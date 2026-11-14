import {
  ACTION_CONFIG,
  BALL_PHYSICS,
  FIELD,
  GOALKEEPER_CONFIG,
  PLAYER_PHYSICS,
} from '../config/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { BallEntity } from '../entities/Ball';
import { distXZ, length3D, normalizeXZ } from '../entities/math3d';
import type { PlayerEntity } from '../entities/Player';
import { attachBallToPlayer, detachBall, updateBallFallingPos } from './BallPhysics';

/**
 * Resolución de colisiones jugador-jugador (`sub_42ca60` @ `0x42ca60`).
 */
export function resolvePlayerCollisions(players: readonly PlayerEntity[], dt: number): void {
  const minDist = PLAYER_PHYSICS.collisionRadius * 2; // 40 px
  const count = players.length;

  for (let i = 0; i < count; i += 1) {
    const a = players[i];
    for (let j = i + 1; j < count; j += 1) {
      const b = players[j];
      if (Math.abs(a.pos.y - b.pos.y) > 28) {
        continue;
      }
      let dx = b.pos.x - a.pos.x;
      let dz = b.pos.z - a.pos.z;
      let dist = Math.hypot(dx, dz);
      if (dist >= minDist) {
        continue;
      }

      if (dist < 1e-4) {
        dx = a.teamSide;
        dz = 0.25;
        dist = Math.hypot(dx, dz);
      }

      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;
      const push = Math.min(
        overlap * 0.5,
        PLAYER_PHYSICS.pushForce * PLAYER_PHYSICS.pushReceptivity * dt,
      );

      a.pos.x -= nx * push;
      a.pos.z -= nz * push;
      b.pos.x += nx * push;
      b.pos.z += nz * push;
    }
  }
}

/**
 * Sujeta las posiciones de todos los jugadores dentro de la cancha (`sub_42ccc0` @ `0x42ccc0`).
 */
export function clampPlayersToField(players: readonly PlayerEntity[]): void {
  for (const p of players) {
    if (p.pos.x < -FIELD.playerLimitX) {
      p.pos.x = -FIELD.playerLimitX;
      if (p.vel.x < 0) p.vel.x = 0;
    } else if (p.pos.x > FIELD.playerLimitX) {
      p.pos.x = FIELD.playerLimitX;
      if (p.vel.x > 0) p.vel.x = 0;
    }

    if (p.pos.z < -FIELD.playerLimitZ) {
      p.pos.z = -FIELD.playerLimitZ;
      if (p.vel.z < 0) p.vel.z = 0;
    } else if (p.pos.z > FIELD.playerLimitZ) {
      p.pos.z = FIELD.playerLimitZ;
      if (p.vel.z > 0) p.vel.z = 0;
    }

    if (p.pos.y < 0) {
      p.pos.y = 0;
      p.vel.y = 0;
      p.baseAcc.y = 0;
    }
  }
}

function segmentDistXZ(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  px: number,
  pz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const abLenSq = abx * abx + abz * abz;
  if (abLenSq < 1e-6) {
    return Math.hypot(px - ax, pz - az);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / abLenSq));
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, pz - cz);
}

/**
 * Resuelve robos por barrida, disputa cercana, captura limpia y rebote/bloqueo contra jugadores (`sub_425b40`).
 */
export function resolveBallPlayerInteractions(
  ball: BallEntity,
  players: readonly PlayerEntity[],
  events?: EventBus,
): void {
  if (ball.ownerPlayerId !== null) {
    const owner = players.find((p) => p.uid === ball.ownerPlayerId);
    if (!owner || !owner.hasBall) {
      ball.ownerPlayerId = null;
      return;
    }
    if (owner.actionState === 'gkHold') {
      return;
    }

    for (const challenger of players) {
      if (challenger.teamSide === owner.teamSide || challenger.isGoalkeeper) {
        continue;
      }
      if (
        challenger.actionState === 'evasion' ||
        challenger.actionState === 'raise' ||
        challenger.actionState === 'kick' ||
        challenger.actionState === 'header' ||
        challenger.actionState === 'headerPrep'
      ) {
        continue;
      }

      const d = Math.hypot(challenger.pos.x - ball.pos.x, challenger.pos.z - ball.pos.z);
      const dOwner = distXZ(challenger.pos, owner.pos);

      if (challenger.actionState === 'tackle') {
        if (d <= PLAYER_PHYSICS.pickupRadius + 10 || dOwner <= PLAYER_PHYSICS.collisionRadius + 6) {
          // Robo exitoso (`tackle` con `stealSuccessChance = 2.0f`) -> `evasion` en el portador.
          detachBall(ball, players);
          owner.hasBall = false;
          owner.isChargingShot = false;
          owner.shotChargeTimer = 0;
          owner.isChargingPass = false;
          owner.passChargeTimer = 0;
          owner.actionState = 'evasion';
          owner.stateTimer = ACTION_CONFIG.evasionDuration;
          owner.vel.y = ACTION_CONFIG.evasionVy;
          owner.baseAcc.y = -PLAYER_PHYSICS.gravity;

          attachBallToPlayer(ball, players, challenger);
          ball.immunityTimer = 0.25;
          events?.emit('sound:play', { key: 'catch', volumeScale: 0.7 });
          return;
        }
        continue;
      }

      // Disputa cuerpo a cuerpo / robo con los pies al encimar la pelota del rival
      if (
        ball.immunityTimer <= 0 &&
        (d <= PLAYER_PHYSICS.pickupRadius + 4 || dOwner <= PLAYER_PHYSICS.collisionRadius + 4)
      ) {
        detachBall(ball, players);
        owner.hasBall = false;
        owner.isChargingShot = false;
        owner.shotChargeTimer = 0;
        owner.isChargingPass = false;
        owner.passChargeTimer = 0;

        attachBallToPlayer(ball, players, challenger);
        ball.immunityTimer = 0.24;
        events?.emit('sound:play', { key: 'catch', volumeScale: 0.55 });
        return;
      }
    }
    return;
  }

  if (ball.immunityTimer > 0) {
    return;
  }

  // Ordenar por cercanía continua (segmento prevPos->pos) en plano XZ para captura/rebote determinista.
  const ballDist = (p: PlayerEntity) =>
    segmentDistXZ(ball.prevPos.x, ball.prevPos.z, ball.pos.x, ball.pos.z, p.pos.x, p.pos.z);
  const sorted = [...players].sort((a, b) => ballDist(a) - ballDist(b));
  const ballSpeed = length3D(ball.vel);

  for (const p of sorted) {
    if (p.actionState === 'evasion' || p.actionState === 'raise') {
      continue;
    }

    const dXZ = ballDist(p);

    if (p.isGoalkeeper) {
      const isDiving = p.actionState === 'gkJump';
      const pickupR = isDiving
        ? GOALKEEPER_CONFIG.pickupRadius + 16
        : GOALKEEPER_CONFIG.pickupRadius + 6;
      const maxY = isDiving ? 66 : GOALKEEPER_CONFIG.maxPickupHeight + 8;
      if (ball.pos.y <= maxY && dXZ <= pickupR) {
        const catchLimit = isDiving
          ? GOALKEEPER_CONFIG.catchMaxSpeed
          : GOALKEEPER_CONFIG.pickupMaxSpeed * p.data.block * 6;
        if (ballSpeed <= catchLimit || isDiving) {
          attachBallToPlayer(ball, players, p);
          p.actionState = 'gkHold';
          p.stateTimer = 0.65;
          p.pos.y = 0;
          p.vel.x = 0;
          p.vel.y = 0;
          p.vel.z = 0;
          p.baseAcc.y = 0;
          ball.immunityTimer = 0.2;
          events?.emit('sound:play', { key: 'catch', volumeScale: 1.0 });
          return;
        }
        reboundBallOffPlayer(ball, p, ballSpeed, events);
        return;
      }
      continue;
    }

    const pickupRadius =
      p.actionState === 'tackle'
        ? PLAYER_PHYSICS.pickupRadius + 10
        : PLAYER_PHYSICS.pickupRadius + 4;
    if (ball.pos.y <= PLAYER_PHYSICS.maxPickupHeight + 4 && dXZ <= pickupRadius) {
      const relSpeed = Math.hypot(ball.vel.x - p.vel.x, ball.vel.y - p.vel.y, ball.vel.z - p.vel.z);
      const effectiveSpeed = Math.min(ballSpeed, relSpeed);
      const sameTeamPass = ball.lastTouchTeamSide === p.teamSide;
      const cleanControlLimit =
        p.actionState === 'tackle'
          ? 500
          : PLAYER_PHYSICS.pickupMaxSpeed * (1 + p.data.skill * 0.45) + (sameTeamPass ? 390 : 250);
      const blockLimit = PLAYER_PHYSICS.blockMaxSpeed * p.data.block;

      if (effectiveSpeed <= cleanControlLimit) {
        attachBallToPlayer(ball, players, p);
        events?.emit('sound:play', { key: 'catch', volumeScale: 0.4 });
        return;
      }

      if (ballSpeed <= blockLimit) {
        reboundBallOffPlayer(ball, p, ballSpeed, events);
        return;
      }
    }
  }
}

function reboundBallOffPlayer(
  ball: BallEntity,
  player: PlayerEntity,
  ballSpeed: number,
  events?: EventBus,
): void {
  const dir = normalizeXZ(ball.pos.x - player.pos.x || player.teamSide, ball.pos.z - player.pos.z);
  const newSpeed = Math.max(40, ballSpeed * 0.25);
  ball.vel.x = dir.x * newSpeed;
  ball.vel.z = dir.z * newSpeed;
  ball.vel.y *= 0.25;
  ball.immunityTimer = BALL_PHYSICS.immunityTime;
  ball.lastTouchTeamSide = player.teamSide;
  ball.lastTouchPlayerName = player.data.name;
  ball.lastTouchPlayerNumber = player.data.number;
  player.hasRebounded = true;
  updateBallFallingPos(ball);
  events?.emit('sound:play', { key: 'kick', volumeScale: 0.65 });
}
