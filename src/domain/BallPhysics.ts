import { ACTION_CONFIG, BALL_PHYSICS, PLAYER_PHYSICS } from '../config/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { DeterministicRNG } from '../core/RNG';
import type { BallEntity } from '../entities/Ball';
import { clamp, cloneVec3, integrateKinematic3D, length3D, normalizeXZ } from '../entities/math3d';
import { facingVector, type PlayerEntity } from '../entities/Player';

/**
 * Calcula `ball.fallingPos` (`sub_426590` @ `0x426590`) estimando el punto de caída en `y = 0`.
 */
export function updateBallFallingPos(ball: BallEntity): void {
  if (ball.pos.y <= 0.5 && Math.abs(ball.vel.y) < 1) {
    // Rodando en suelo: proyecta avance suavizado a 0.35s para anticipación de IA.
    const tGround = 0.25;
    ball.fallingPos.x = ball.pos.x + ball.vel.x * tGround;
    ball.fallingPos.y = 0;
    ball.fallingPos.z = ball.pos.z + ball.vel.z * tGround;
    return;
  }

  const g = BALL_PHYSICS.gravity; // -480
  const vy = ball.vel.y;
  const y0 = Math.max(0, ball.pos.y);
  const disc = vy * vy - 2 * g * y0;
  let tLand = 0;
  if (disc >= 0) {
    tLand = (-vy - Math.sqrt(disc)) / g;
  }
  tLand = clamp(tLand, 0, 2.2);
  const dragAttenuation = Math.exp(-0.22 * tLand);
  ball.fallingPos.x = ball.pos.x + ball.vel.x * tLand * dragAttenuation;
  ball.fallingPos.y = 0;
  ball.fallingPos.z = ball.pos.z + ball.vel.z * tLand * dragAttenuation;
}

export function attachBallToPlayer(
  ball: BallEntity,
  players: readonly PlayerEntity[],
  player: PlayerEntity,
): void {
  for (const p of players) {
    p.hasBall = p.uid === player.uid;
  }
  ball.ownerPlayerId = player.uid;
  ball.lastTouchTeamSide = player.teamSide;
  ball.lastTouchPlayerName = player.data.name;
  ball.lastTouchPlayerNumber = player.data.number;
  ball.pos.y = 0;
  ball.vel.y = 0;
  ball.baseAcc.y = 0;
}

export function detachBall(ball: BallEntity, players: readonly PlayerEntity[]): void {
  if (ball.ownerPlayerId !== null) {
    for (const p of players) {
      if (p.uid === ball.ownerPlayerId) {
        p.hasBall = false;
      }
    }
    ball.ownerPlayerId = null;
  }
}

/**
 * Patada directa (`sub_425d40` @ `0x425d40`).
 */
export function kickBallDirect(
  ball: BallEntity,
  players: readonly PlayerEntity[],
  kicker: PlayerEntity,
  dirX: number,
  dirZ: number,
  horizSpeed: number,
  vertSpeed: number,
): void {
  detachBall(ball, players);
  const dir = normalizeXZ(dirX, dirZ);
  ball.lastTouchTeamSide = kicker.teamSide;
  ball.lastTouchPlayerName = kicker.data.name;
  ball.lastTouchPlayerNumber = kicker.data.number;
  ball.immunityTimer = BALL_PHYSICS.immunityTime;
  ball.originPos = cloneVec3(ball.pos);

  ball.vel.x = dir.x * horizSpeed;
  ball.vel.y = vertSpeed;
  ball.vel.z = dir.z * horizSpeed;
  ball.baseAcc.x = 0;
  ball.baseAcc.y = vertSpeed > 0 || ball.pos.y > 0 ? BALL_PHYSICS.gravity : 0;
  ball.baseAcc.z = 0;
  updateBallFallingPos(ball);
}

/**
 * Patada parabólica a objetivo con cono de dispersión (`sub_425de0`, `sub_434a90`).
 */
export function kickBallToTarget(
  ball: BallEntity,
  players: readonly PlayerEntity[],
  kicker: PlayerEntity,
  targetX: number,
  targetZ: number,
  speed: number,
  halfAngleCone: number,
  heightFactor: number,
  rng: DeterministicRNG,
  applyInaccuracy = true,
): void {
  const dx = targetX - ball.pos.x;
  const dz = targetZ - ball.pos.z;
  const baseAngle = Math.atan2(dz, dx);

  let finalAngle = baseAngle;
  if (applyInaccuracy && halfAngleCone > 0) {
    const scaledHalf = clamp(halfAngleCone * kicker.data.inaccuracy, 0, 0.9 * Math.PI * 0.5);
    finalAngle += rng.signedNormalized() * scaledHalf;
  }

  const dirX = Math.cos(finalAngle);
  const dirZ = Math.sin(finalAngle);

  const clampedPeak = clamp(
    heightFactor *
      BALL_PHYSICS.parabolicBaseHeight *
      Math.max(0.55, speed / ACTION_CONFIG.passSpeed),
    0,
    BALL_PHYSICS.parabolicMaxHeight,
  );
  const vy = clampedPeak > 1 ? Math.sqrt(2 * Math.abs(BALL_PHYSICS.gravity) * clampedPeak) : 0;

  kickBallDirect(ball, players, kicker, dirX, dirZ, speed, vy);
}

/**
 * Actualiza física del balón durante `dt` (`0x425390..0x42679c`).
 */
export function updateBallPhysics(
  ball: BallEntity,
  players: readonly PlayerEntity[],
  dt: number,
  events?: EventBus,
): void {
  ball.prevPos = cloneVec3(ball.pos);
  if (ball.immunityTimer > 0) {
    ball.immunityTimer = Math.max(0, ball.immunityTimer - dt);
  }

  if (ball.ownerPlayerId !== null) {
    const owner = players.find((p) => p.uid === ball.ownerPlayerId);
    if (owner && owner.hasBall) {
      const speedXZ = Math.hypot(owner.vel.x, owner.vel.z);
      const dir =
        speedXZ > 10 ? normalizeXZ(owner.vel.x, owner.vel.z) : facingVector(owner.facingDir);
      ball.pos.x = owner.pos.x + dir.x * PLAYER_PHYSICS.dribbleLookahead;
      ball.pos.y = 0;
      ball.pos.z = owner.pos.z + dir.z * PLAYER_PHYSICS.dribbleLookahead;
      ball.vel.x = owner.vel.x;
      ball.vel.y = 0;
      ball.vel.z = owner.vel.z;
      ball.baseAcc.x = 0;
      ball.baseAcc.y = 0;
      ball.baseAcc.z = 0;
      ball.fallingPos = cloneVec3(ball.pos);
      ball.spinAnimId = speedXZ > 25 ? 0 : 20;
      return;
    }
    ball.ownerPlayerId = null;
  }

  if (ball.pos.y <= 0.001 && Math.abs(ball.vel.y) < 0.001) {
    ball.pos.y = 0;
    ball.baseAcc.y = 0;
    ball.linearFriction = BALL_PHYSICS.groundFriction;
  } else {
    ball.baseAcc.y = BALL_PHYSICS.gravity;
    ball.linearFriction = BALL_PHYSICS.airDrag * length3D(ball.vel);
  }

  integrateKinematic3D(ball, dt);

  if (ball.pos.y <= 0 && ball.vel.y < 0) {
    const reboundVy = -ball.vel.y * ball.restitution;
    if (reboundVy >= ball.stopBounceVy) {
      ball.pos.y = 0;
      ball.vel.y = reboundVy;
      ball.baseAcc.y = BALL_PHYSICS.gravity;
      if (reboundVy > 65) {
        events?.emit('sound:play', {
          key: 'catch',
          volumeScale: clamp(reboundVy / 350, 0.15, 0.45),
        });
      }
    } else {
      ball.pos.y = 0;
      ball.vel.y = 0;
      ball.baseAcc.y = 0;
      ball.vel.x *= ball.restitution;
      ball.vel.z *= ball.restitution;
    }
  } else if (ball.pos.y < 0) {
    ball.pos.y = 0;
    ball.vel.y = 0;
    ball.baseAcc.y = 0;
  }

  updateBallFallingPos(ball);

  const horizSpeed = Math.hypot(ball.vel.x, ball.vel.z);
  if (horizSpeed > 320 || ball.pos.y > 18) {
    ball.spinAnimId = 10;
  } else if (horizSpeed > 15) {
    ball.spinAnimId = 0;
  } else {
    ball.spinAnimId = 20;
  }
}
