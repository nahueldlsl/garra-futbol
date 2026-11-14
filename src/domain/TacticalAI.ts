import {
  ACTION_CONFIG,
  FIELD,
  GOALKEEPER_CONFIG,
  KICK_LEVELS,
  MATCH_TIMERS,
  PLAYER_PHYSICS,
} from '../config/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { DeterministicRNG } from '../core/RNG';
import type { FormationsData } from '../data/types';
import type { BallEntity } from '../entities/Ball';
import { clamp, distXZ, normalizeXZ, vec3 } from '../entities/math3d';
import {
  type FacingDirection,
  facingVector,
  type PlayerEntity,
  vectorToFacingDirection,
} from '../entities/Player';
import type { TeamEntity } from '../entities/Team';
import type { InputProfile, InputReader } from '../input/InputManager';
import { detachBall, kickBallDirect, kickBallToTarget } from './BallPhysics';

interface SteerConfig {
  readonly startRadius: number;
  readonly stopRadius: number;
  readonly slowRadius: number;
}

const ARRIVE_OUTFIELD: SteerConfig = { startRadius: 32, stopRadius: 12, slowRadius: 90 };
const ARRIVE_GK: SteerConfig = { startRadius: 12, stopRadius: 4, slowRadius: 40 };

/**
 * Cambia de eje cardinal solo si el nuevo eje domina con histéresis (evita flicker diagonal).
 */
function facingWithHysteresis(current: FacingDirection, x: number, z: number): FacingDirection {
  const absX = Math.abs(x);
  const absZ = Math.abs(z);
  if (absX < 1e-3 && absZ < 1e-3) {
    return current;
  }
  const currentlyHorizontal = current === 2 || current === 6;
  if (currentlyHorizontal) {
    if (absZ > absX * 1.35) {
      return z >= 0 ? 0 : 4;
    }
    return x >= 0 ? 2 : 6;
  }
  if (absX > absZ * 1.35) {
    return x >= 0 ? 2 : 6;
  }
  return z >= 0 ? 0 : 4;
}

function steerToward(
  player: PlayerEntity,
  tx: number,
  tz: number,
  ball: BallEntity,
  cfg: SteerConfig,
  baseMaxSpeed: number,
  accelScale: number,
  lockFacing?: FacingDirection,
): void {
  const dx = tx - player.pos.x;
  const dz = tz - player.pos.z;
  const dist = Math.hypot(dx, dz);

  if (player.isSteering) {
    if (dist < cfg.stopRadius) {
      player.isSteering = false;
    }
  } else if (dist > cfg.startRadius) {
    player.isSteering = true;
  }

  const horizSpeed = Math.hypot(player.vel.x, player.vel.z);

  if (player.isSteering) {
    const dir = normalizeXZ(dx, dz);
    player.maxSpeed = baseMaxSpeed;
    const desiredSpeed =
      dist < cfg.slowRadius
        ? Math.min(
            baseMaxSpeed * (dist / cfg.slowRadius),
            Math.sqrt(1.5 * player.linearFriction * dist),
          )
        : baseMaxSpeed;
    const radialSpeed = player.vel.x * dir.x + player.vel.z * dir.z;

    if (dist < cfg.slowRadius && radialSpeed > desiredSpeed) {
      // Ya se aproxima con impulso suficiente: soltar aceleración y frenar con fricción.
      player.dirAcc = vec3(0, 0, 0);
    } else {
      const throttle = dist < cfg.slowRadius ? clamp(dist / cfg.slowRadius, 0.35, 1) : 1;
      player.dirAcc = vec3(dir.x * accelScale * throttle, 0, dir.z * accelScale * throttle);
    }

    if (lockFacing !== undefined) {
      player.facingDir = lockFacing;
    } else if (horizSpeed > 40) {
      player.facingDir = facingWithHysteresis(player.facingDir, player.vel.x, player.vel.z);
    } else {
      player.facingDir = facingWithHysteresis(player.facingDir, dir.x, dir.z);
    }
    player.actionState = 'run';
    return;
  }

  player.dirAcc = vec3(0, 0, 0);
  player.maxSpeed = baseMaxSpeed;
  if (lockFacing !== undefined) {
    player.facingDir = lockFacing;
  } else if (horizSpeed > 40) {
    player.facingDir = facingWithHysteresis(player.facingDir, player.vel.x, player.vel.z);
  } else {
    player.facingDir = facingWithHysteresis(
      player.facingDir,
      ball.pos.x - player.pos.x,
      ball.pos.z - player.pos.z,
    );
  }
  player.actionState = player.isGoalkeeper ? 'gkStand' : 'idle';
}

/**
 * Calcula los objetivos tácticos (`tacticalHome`) de los 11 jugadores según formación y `ball.fallingPos` (SPECS §4.1).
 */
export function computeTacticalTargets(
  team: TeamEntity,
  ball: BallEntity,
  formationsData: FormationsData,
  dt = 1 / 30,
): void {
  const formation = formationsData.formations[team.data.formation];
  // Desplazamiento constante según el lado del equipo (evita saltos al cambiar la posesión).
  const sideBias = MATCH_TIMERS.tacticalSideOffset * team.side;

  const normBallX = clamp(ball.fallingPos.x / FIELD.halfWidth, -1, 1);
  const normBallZ = clamp(ball.fallingPos.z / FIELD.halfDepth, -1, 1);
  const ballShiftX = normBallX * 600;
  const ballShiftZ = normBallZ * 240;
  const smoothAlpha = clamp(2.0 * dt, 0, 1);

  for (const player of team.players) {
    if (player.isGoalkeeper) {
      const homeX = -team.side * (FIELD.halfWidth - 36);
      const boxDanger = Math.abs(ball.fallingPos.x - -team.side * FIELD.halfWidth) < 340;
      const stepOutX = boxDanger ? team.side * 32 : 0;
      const goalTargetZ = clamp(
        ball.fallingPos.z * 0.34,
        -FIELD.goalHalfZ + 16,
        FIELD.goalHalfZ - 16,
      );
      const targetX = homeX + stepOutX;
      player.tacticalHome.x += (targetX - player.tacticalHome.x) * smoothAlpha;
      player.tacticalHome.z += (goalTargetZ - player.tacticalHome.z) * smoothAlpha;
      continue;
    }

    const slot =
      formation.outfieldPositions.find((p) => p.playerNumber === player.data.number) ??
      formation.outfieldPositions[(player.data.number - 2) % formation.outfieldPositions.length];

    // slot.x in [0..1]: 0 = propio arco, 1 = arco rival
    const normalizedX = (slot.x - 0.5) * 2; // [-1, 1]
    const baseFieldX = normalizedX * (FIELD.halfWidth * 0.68) * team.side;
    const baseFieldZ = (slot.y - 0.5) * (FIELD.halfDepth * 1.62);

    const targetX = clamp(
      baseFieldX + ballShiftX + sideBias,
      -FIELD.halfWidth + 85,
      FIELD.halfWidth - 85,
    );
    const targetZ = clamp(
      baseFieldZ + ballShiftZ * 0.7,
      -FIELD.halfDepth + 55,
      FIELD.halfDepth - 55,
    );

    player.tacticalHome.x += (targetX - player.tacticalHome.x) * smoothAlpha;
    player.tacticalHome.z += (targetZ - player.tacticalHome.z) * smoothAlpha;
  }
}

/**
 * Actualiza `nearestPlayerIndex` y `activePlayerIndex` del equipo (`sub_42c080`) con histéresis.
 */
export function updateTeamNearestAndActive(
  team: TeamEntity,
  ball: BallEntity,
  input?: InputReader,
): void {
  const outfield = team.players.filter((p) => !p.isGoalkeeper);
  if (outfield.length === 0) return;

  let nearest = outfield[0];
  let bestDist = distXZ(nearest.pos, ball.fallingPos);
  for (let i = 1; i < outfield.length; i += 1) {
    const candidate = outfield[i];
    const d = distXZ(candidate.pos, ball.fallingPos);
    if (d < bestDist) {
      bestDist = d;
      nearest = candidate;
    }
  }

  const currentNearest = team.players[team.nearestPlayerIndex];
  if (!currentNearest || currentNearest.isGoalkeeper || isPlayerLockedInAction(currentNearest)) {
    team.nearestPlayerIndex = nearest.indexInTeam;
  } else if (currentNearest.indexInTeam !== nearest.indexInTeam) {
    const currentDist = distXZ(currentNearest.pos, ball.fallingPos);
    if (bestDist + 45 < currentDist) {
      team.nearestPlayerIndex = nearest.indexInTeam;
    }
  }

  const chosenNearest = team.players[team.nearestPlayerIndex] ?? nearest;
  const chosenNearestDist = distXZ(chosenNearest.pos, ball.fallingPos);

  // Si un compañero o el arquero posee la pelota, ese jugador pasa a ser el activo.
  const owner = ball.ownerPlayerId
    ? team.players.find((p) => p.uid === ball.ownerPlayerId)
    : undefined;
  if (owner) {
    team.activePlayerIndex = owner.indexInTeam;
    return;
  }

  if (team.controlMode === 'CPU') {
    team.activePlayerIndex = chosenNearest.indexInTeam;
    return;
  }

  const currentActive = team.players[team.activePlayerIndex];
  const profile = team.controlMode as InputProfile;
  const passSwitchPressed = input ? input.getAction(profile, 'pass').justPressed : false;

  if (!currentActive || currentActive.isGoalkeeper) {
    team.activePlayerIndex = chosenNearest.indexInTeam;
    return;
  }

  const busy = isPlayerLockedInAction(currentActive);
  if (passSwitchPressed && !busy && team.activePlayerIndex !== chosenNearest.indexInTeam) {
    team.activePlayerIndex = chosenNearest.indexInTeam;
    return;
  }

  // Cambio automático inteligente si el jugador más cercano está sustancialmente más cerca,
  // salvo que el jugador activo humano ya esté corriendo directo hacia el balón dentro de 230 px.
  const activeDist = distXZ(currentActive.pos, ball.fallingPos);
  const toBallX = ball.fallingPos.x - currentActive.pos.x;
  const toBallZ = ball.fallingPos.z - currentActive.pos.z;
  const activeSpeed = Math.hypot(currentActive.vel.x, currentActive.vel.z);
  const closingDot =
    activeSpeed > 25 && activeDist > 1
      ? (toBallX * currentActive.vel.x + toBallZ * currentActive.vel.z) / (activeDist * activeSpeed)
      : 0;
  const closingInOnBall = activeDist < 230 && closingDot > 0.45;
  if (!busy && !closingInOnBall && chosenNearestDist + 55 < activeDist) {
    team.activePlayerIndex = chosenNearest.indexInTeam;
  }
}

/**
 * Busca el mejor receptor de pase alineado con la dirección de apuntado (`sub_434a90`).
 */
export function findBestPassReceiver(
  team: TeamEntity,
  passer: PlayerEntity,
  aimDirX: number,
  aimDirZ: number,
): PlayerEntity | null {
  const dir = normalizeXZ(aimDirX, aimDirZ);
  let bestCandidate: PlayerEntity | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const mate of team.players) {
    if (mate.uid === passer.uid || mate.isGoalkeeper) continue;
    const dx = mate.pos.x - passer.pos.x;
    const dz = mate.pos.z - passer.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 40 || dist > 920) continue;

    const dot = (dx / dist) * dir.x + (dz / dist) * dir.z;
    if (dot < 0.25) continue;

    const distScore = 1 - Math.abs(dist - 240) / 800;
    const score = dot * 2.2 + distScore;
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = mate;
    }
  }

  return bestCandidate;
}

export function isPlayerLockedInAction(player: PlayerEntity): boolean {
  return (
    player.actionState === 'tackle' ||
    player.actionState === 'raise' ||
    player.actionState === 'kick' ||
    player.actionState === 'headerPrep' ||
    player.actionState === 'header' ||
    player.actionState === 'evasion' ||
    player.actionState === 'throwIn' ||
    player.actionState === 'gkJump' ||
    player.actionState === 'celebrate'
  );
}

function advanceLockedPlayerState(
  player: PlayerEntity,
  ball: BallEntity,
  players: readonly PlayerEntity[],
  rng: DeterministicRNG,
  dt: number,
  events?: EventBus,
): boolean {
  if (player.stateTimer > 0) {
    player.stateTimer = Math.max(0, player.stateTimer - dt);
  }

  switch (player.actionState) {
    case 'tackle': {
      player.dirAcc = vec3(0, 0, 0);
      player.linearFriction = ACTION_CONFIG.tackleFriction;
      if (player.stateTimer <= 0) {
        player.actionState = 'raise';
        player.stateTimer = ACTION_CONFIG.tackleRecoveryTime;
        player.vel.x *= 0.25;
        player.vel.z *= 0.25;
      }
      return true;
    }

    case 'raise':
    case 'kick':
    case 'header':
    case 'evasion':
    case 'throwIn': {
      player.dirAcc = vec3(0, 0, 0);
      player.linearFriction = PLAYER_PHYSICS.groundFriction;
      if (player.stateTimer <= 0) {
        player.actionState = 'idle';
        player.maxSpeed = PLAYER_PHYSICS.maxSpeed * player.data.speed;
      }
      return true;
    }

    case 'headerPrep': {
      player.dirAcc = vec3(0, 0, 0);
      player.linearFriction = 120;
      const distToBall = distXZ(player.pos, ball.pos);
      if (!ball.ownerPlayerId && distToBall < 34 && Math.abs(player.pos.y + 18 - ball.pos.y) < 38) {
        const goalX = player.teamSide * FIELD.halfWidth;
        const goalZ = clamp(
          player.aimOffsetY * (FIELD.goalHalfZ * 0.75),
          -FIELD.goalHalfZ * 0.8,
          FIELD.goalHalfZ * 0.8,
        );
        kickBallToTarget(
          ball,
          players,
          player,
          goalX,
          goalZ,
          ACTION_CONFIG.headerShotSpeed + 260,
          0.08 * Math.PI,
          0.25,
          rng,
          true,
        );
        player.actionState = 'header';
        player.stateTimer = 0.25;
        events?.emit('sound:play', { key: 'kick', volumeScale: 1.0 });
        return true;
      }
      if (player.pos.y <= 0 && player.vel.y <= 0 && player.stateTimer <= 0) {
        player.actionState = 'idle';
        player.pos.y = 0;
        player.vel.y = 0;
        player.baseAcc.y = 0;
      }
      return true;
    }

    case 'gkJump': {
      player.dirAcc = vec3(0, 0, 0);
      player.linearFriction = 260;
      // Atrapar/despejar pelota cercana en vuelo del arquero
      if (
        !ball.ownerPlayerId &&
        distXZ(player.pos, ball.pos) < 42 &&
        Math.abs(ball.pos.y - player.pos.y) < 52
      ) {
        const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
        if (speed <= GOALKEEPER_CONFIG.catchMaxSpeed * 0.55) {
          detachBall(ball, players);
          ball.ownerPlayerId = player.uid;
          player.hasBall = true;
          ball.lastTouchTeamSide = player.teamSide;
          ball.lastTouchPlayerName = player.data.name;
          ball.lastTouchPlayerNumber = player.data.number;
          player.actionState = 'gkHold';
          player.stateTimer = 0.7;
          player.pos.y = 0;
          player.vel = vec3(0, 0, 0);
          player.baseAcc.y = 0;
          events?.emit('sound:play', { key: 'catch', volumeScale: 1.0 });
        } else {
          // Despeje de puños
          const clearDir = normalizeXZ(player.teamSide * 1.2, (player.pos.z >= 0 ? 1 : -1) * 0.6);
          kickBallDirect(ball, players, player, clearDir.x, clearDir.z, 480, 260);
          events?.emit('sound:play', { key: 'strongHit', volumeScale: 0.9 });
        }
        return true;
      }
      if (player.pos.y <= 0 && player.vel.y <= 0 && player.stateTimer <= 0) {
        player.pos.y = 0;
        player.vel = vec3(0, 0, 0);
        player.baseAcc.y = 0;
        player.actionState = 'gkStand';
      }
      return true;
    }

    case 'celebrate': {
      const f = facingVector(player.facingDir);
      player.dirAcc = vec3(f.x * 0.45, 0, f.z * 0.45);
      player.maxSpeed = 160;
      player.linearFriction = PLAYER_PHYSICS.groundFriction;
      return true;
    }

    default:
      return false;
  }
}

function executePlayerShot(
  player: PlayerEntity,
  team: TeamEntity,
  ball: BallEntity,
  players: readonly PlayerEntity[],
  aimX: number,
  aimZ: number,
  chargeSeconds: number,
  rng: DeterministicRNG,
  events?: EventBus,
): void {
  let chosen = KICK_LEVELS[1]; // lv1 disparo rápido
  if (chargeSeconds < 0.04 && Math.abs(aimX) < 0.1 && Math.abs(aimZ) < 0.1) {
    chosen = KICK_LEVELS[0];
  } else {
    for (let i = KICK_LEVELS.length - 1; i >= 1; i -= 1) {
      if (chargeSeconds >= KICK_LEVELS[i].minCharge) {
        chosen = KICK_LEVELS[i];
        break;
      }
    }
  }

  const targetGoalX = team.side * FIELD.halfWidth;
  const shootingBackward = aimX * team.side < -0.35;
  let targetX = targetGoalX;
  let targetZ = clamp(
    player.aimOffsetY * (FIELD.goalHalfZ * 0.85),
    -FIELD.goalHalfZ * 0.9,
    FIELD.goalHalfZ * 0.9,
  );

  if (shootingBackward || (Math.abs(aimX) > 0.25 && Math.abs(aimX - team.side) > 0.6)) {
    const norm = normalizeXZ(aimX, aimZ);
    targetX = ball.pos.x + norm.x * 520;
    targetZ = ball.pos.z + norm.z * 520;
  }

  const powerMult = 0.85 + player.data.power * 0.22;
  const speed = chosen.speed * powerMult;

  kickBallToTarget(
    ball,
    players,
    player,
    targetX,
    targetZ,
    speed,
    chosen.inaccuracy,
    chosen.heightFactor,
    rng,
    true,
  );

  player.isChargingShot = false;
  player.shotChargeTimer = 0;
  player.actionState = 'kick';
  player.stateTimer = 0.22;
  player.facingDir = vectorToFacingDirection(
    targetX - player.pos.x,
    targetZ - player.pos.z,
    player.facingDir,
  );
  events?.emit('sound:play', {
    key: chosen.playPowerSfx ? 'powerKick' : 'kick',
    volumeScale: 1.0,
  });
}

function executePlayerPass(
  player: PlayerEntity,
  team: TeamEntity,
  ball: BallEntity,
  players: readonly PlayerEntity[],
  aimX: number,
  aimZ: number,
  chargeSeconds: number,
  rng: DeterministicRNG,
  events?: EventBus,
): void {
  const fallbackDir = facingVector(player.facingDir);
  const dirX = Math.abs(aimX) > 0.1 || Math.abs(aimZ) > 0.1 ? aimX : fallbackDir.x;
  const dirZ = Math.abs(aimX) > 0.1 || Math.abs(aimZ) > 0.1 ? aimZ : fallbackDir.z;

  const receiver = findBestPassReceiver(team, player, dirX, dirZ);
  let targetX: number;
  let targetZ: number;
  let dist: number;

  if (receiver) {
    targetX = receiver.pos.x + receiver.vel.x * 0.28;
    targetZ = receiver.pos.z + receiver.vel.z * 0.28;
    dist = distXZ(ball.pos, vec3(targetX, 0, targetZ));
  } else {
    const norm = normalizeXZ(dirX, dirZ);
    targetX = ball.pos.x + norm.x * 260;
    targetZ = ball.pos.z + norm.z * 260;
    dist = 260;
  }

  const isHighPass = chargeSeconds >= ACTION_CONFIG.passHighHoldThreshold;
  const speed = clamp(
    dist * 1.45 + chargeSeconds * 160,
    ACTION_CONFIG.passMinSpeed + 180,
    ACTION_CONFIG.passSpeed + (isHighPass ? 160 : 60),
  );
  const heightFactor = isHighPass ? ACTION_CONFIG.passHighHeightFactor : 0.08;

  kickBallToTarget(
    ball,
    players,
    player,
    targetX,
    targetZ,
    speed,
    ACTION_CONFIG.passInaccuracy,
    heightFactor,
    rng,
    true,
  );

  player.isChargingPass = false;
  player.passChargeTimer = 0;
  player.actionState = 'kick';
  player.stateTimer = 0.2;
  player.facingDir = vectorToFacingDirection(
    targetX - player.pos.x,
    targetZ - player.pos.z,
    player.facingDir,
  );
  events?.emit('sound:play', { key: 'kick', volumeScale: 0.95 });
}

/**
 * Actualiza jugador humano activo usando entradas de `InputReader`.
 */
export function updateFieldPlayerHuman(
  player: PlayerEntity,
  team: TeamEntity,
  ball: BallEntity,
  players: readonly PlayerEntity[],
  input: InputReader,
  profile: InputProfile,
  rng: DeterministicRNG,
  dt: number,
  events?: EventBus,
): void {
  if (advanceLockedPlayerState(player, ball, players, rng, dt, events)) {
    return;
  }

  const move = input.getDirection(profile);
  const shootInput = input.getAction(profile, 'shot');
  const passInput = input.getAction(profile, 'pass');

  const baseMax = PLAYER_PHYSICS.maxSpeed * player.data.speed;
  player.maxSpeed = player.hasBall ? baseMax * PLAYER_PHYSICS.dribbleSpeedFactor : baseMax;
  player.linearFriction = PLAYER_PHYSICS.groundFriction;

  if (move.z < -0.2) player.aimOffsetY = -1;
  else if (move.z > 0.2) player.aimOffsetY = 1;
  else player.aimOffsetY = 0;

  if (Math.abs(move.x) > 0.05 || Math.abs(move.z) > 0.05) {
    const moveLen = Math.hypot(move.x, move.z);
    const nx = moveLen > 1 ? move.x / moveLen : move.x;
    const nz = moveLen > 1 ? move.z / moveLen : move.z;
    player.dirAcc = vec3(nx, 0, nz);
    player.facingDir = vectorToFacingDirection(nx, nz, player.facingDir);
    player.actionState = 'run';
  } else {
    player.dirAcc = vec3(0, 0, 0);
    player.actionState = 'idle';
  }

  if (player.hasBall) {
    // Disparo con barra de potencia (pulsación corta vs mantenida)
    if (shootInput.isDown) {
      player.isChargingShot = true;
      player.shotChargeTimer += dt;
      player.actionState = 'kickPrep';
      if (player.shotChargeTimer >= 1.15) {
        executePlayerShot(
          player,
          team,
          ball,
          players,
          move.x,
          move.z,
          player.shotChargeTimer,
          rng,
          events,
        );
      }
      return;
    }

    if (player.isChargingShot) {
      executePlayerShot(
        player,
        team,
        ball,
        players,
        move.x,
        move.z,
        player.shotChargeTimer,
        rng,
        events,
      );
      return;
    }

    // Pase raso o elevado
    if (passInput.isDown) {
      player.isChargingPass = true;
      player.passChargeTimer += dt;
      player.actionState = 'kickPrep';
      if (player.passChargeTimer >= 0.75) {
        executePlayerPass(
          player,
          team,
          ball,
          players,
          move.x,
          move.z,
          player.passChargeTimer,
          rng,
          events,
        );
      }
      return;
    }

    if (player.isChargingPass) {
      executePlayerPass(
        player,
        team,
        ball,
        players,
        move.x,
        move.z,
        player.passChargeTimer,
        rng,
        events,
      );
    }
    return;
  }

  // Sin posesión: cabezazo en pelota aérea o barrida (`tackle`)
  player.isChargingShot = false;
  player.shotChargeTimer = 0;
  player.isChargingPass = false;
  player.passChargeTimer = 0;

  if (shootInput.justPressed) {
    const distBall = distXZ(player.pos, ball.pos);
    const airborneForHeader =
      !ball.ownerPlayerId &&
      ball.pos.y >= ACTION_CONFIG.headerMinY &&
      ball.pos.y <= ACTION_CONFIG.headerMaxY &&
      distBall <= ACTION_CONFIG.headerMaxDist;

    if (airborneForHeader) {
      const jumpDir = normalizeXZ(
        ball.fallingPos.x - player.pos.x,
        ball.fallingPos.z - player.pos.z,
      );
      player.actionState = 'headerPrep';
      player.stateTimer = 0.5;
      player.vel.x = jumpDir.x * ACTION_CONFIG.headerJumpHorizSpeed;
      player.vel.z = jumpDir.z * ACTION_CONFIG.headerJumpHorizSpeed;
      player.vel.y = ACTION_CONFIG.headerJumpVy;
      player.baseAcc.y = -PLAYER_PHYSICS.gravity;
      player.facingDir = vectorToFacingDirection(jumpDir.x, jumpDir.z, player.facingDir);
      events?.emit('sound:play', { key: 'action', volumeScale: 0.55 });
    } else {
      const slideDir =
        Math.abs(move.x) > 0.05 || Math.abs(move.z) > 0.05
          ? normalizeXZ(move.x, move.z)
          : facingVector(player.facingDir);
      player.actionState = 'tackle';
      player.stateTimer = ACTION_CONFIG.tackleActiveTime;
      player.vel.x = slideDir.x * ACTION_CONFIG.tackleVx;
      player.vel.z = slideDir.z * (ACTION_CONFIG.tackleVx * 0.92 + ACTION_CONFIG.tackleVz * 0.25);
      player.facingDir = vectorToFacingDirection(slideDir.x, slideDir.z, player.facingDir);
      events?.emit('sound:play', { key: 'slide', volumeScale: 0.9 });
    }
  }
}

/**
 * Actualiza jugador de campo controlado por IA (equipo CPU o compañeros sin control en equipo humano).
 */
export function updateFieldPlayerAI(
  player: PlayerEntity,
  team: TeamEntity,
  oppTeam: TeamEntity,
  ball: BallEntity,
  players: readonly PlayerEntity[],
  isNearestChaser: boolean,
  rng: DeterministicRNG,
  dt: number,
  events?: EventBus,
): void {
  if (advanceLockedPlayerState(player, ball, players, rng, dt, events)) {
    return;
  }

  if (player.aiCooldownTimer > 0) {
    player.aiCooldownTimer = Math.max(0, player.aiCooldownTimer - dt);
  }

  const baseMax = PLAYER_PHYSICS.maxSpeed * player.data.speed;
  player.maxSpeed = player.hasBall ? baseMax * PLAYER_PHYSICS.dribbleSpeedFactor : baseMax;
  player.linearFriction = PLAYER_PHYSICS.groundFriction;

  if (player.hasBall) {
    const oppGoalX = team.side * FIELD.halfWidth;
    const distGoal = Math.hypot(oppGoalX - player.pos.x, -player.pos.z);

    // Buscar rival más cercano enfrente
    let nearestOppDist = Number.POSITIVE_INFINITY;
    for (const opp of oppTeam.players) {
      const d = distXZ(player.pos, opp.pos);
      if (d < nearestOppDist) nearestOppDist = d;
    }

    if (player.aiCooldownTimer <= 0) {
      if (distGoal < 560 && Math.abs(player.pos.z) < 380) {
        const cornerZ = rng.signedNormalized() * (FIELD.goalHalfZ * 0.72);
        player.aimOffsetY = cornerZ < -25 ? -1 : cornerZ > 25 ? 1 : 0;
        const charge = 0.2 + rng.nextFloat() * 0.48;
        executePlayerShot(
          player,
          team,
          ball,
          players,
          team.side,
          cornerZ / FIELD.goalHalfZ,
          charge,
          rng,
          events,
        );
        player.aiCooldownTimer = 0.35;
        return;
      }

      const teammateAhead = findBestPassReceiver(team, player, team.side, 0);
      const shouldPassUnderPressure = nearestOppDist < 125 && teammateAhead !== null;
      const shouldPassTactically =
        teammateAhead !== null &&
        (teammateAhead.pos.x - player.pos.x) * team.side > 120 &&
        rng.nextFloat() < 0.28 * clamp(player.data.skill * 0.5, 0.4, 1.2);

      if (shouldPassUnderPressure || shouldPassTactically) {
        executePlayerPass(
          player,
          team,
          ball,
          players,
          teammateAhead!.pos.x - player.pos.x,
          teammateAhead!.pos.z - player.pos.z,
          rng.nextFloat() * 0.22,
          rng,
          events,
        );
        player.aiCooldownTimer = 0.25;
        return;
      }

      player.aiCooldownTimer = 0.14 + rng.nextFloat() * 0.1;
    }

    // Regate hacia el arco rival evitando salida por bandas
    const targetZ = clamp(player.pos.z * 0.85, -FIELD.goalHalfZ * 1.4, FIELD.goalHalfZ * 1.4);
    const dir = normalizeXZ(oppGoalX - player.pos.x, targetZ - player.pos.z);
    player.dirAcc = vec3(dir.x, 0, dir.z);
    player.facingDir = facingWithHysteresis(player.facingDir, dir.x, dir.z);
    player.actionState = 'run';
    return;
  }

  const oppHasBall = ball.ownerPlayerId !== null && ball.lastTouchTeamSide === oppTeam.side;
  const distToBall = distXZ(player.pos, ball.fallingPos);
  const shouldPressBall =
    isNearestChaser || (oppHasBall && distToBall < 150 + player.data.marking * 35);

  if (shouldPressBall) {
    player.isSteering = true;
    const chaseDir = normalizeXZ(
      ball.fallingPos.x - player.pos.x,
      ball.fallingPos.z - player.pos.z,
    );
    player.dirAcc = vec3(chaseDir.x, 0, chaseDir.z);
    player.facingDir = facingWithHysteresis(player.facingDir, chaseDir.x, chaseDir.z);
    player.actionState = 'run';

    if (
      oppHasBall &&
      distToBall < 86 &&
      player.aiCooldownTimer <= 0 &&
      rng.nextFloat() < 0.16 * clamp(player.data.block, 0.5, 1.8)
    ) {
      player.actionState = 'tackle';
      player.stateTimer = ACTION_CONFIG.tackleActiveTime;
      player.vel.x = chaseDir.x * ACTION_CONFIG.tackleVx;
      player.vel.z = chaseDir.z * ACTION_CONFIG.tackleVx;
      player.facingDir = vectorToFacingDirection(chaseDir.x, chaseDir.z, player.facingDir);
      player.aiCooldownTimer = 0.8;
      events?.emit('sound:play', { key: 'slide', volumeScale: 0.75 });
    }
    return;
  }

  // Retorno ordenado a posición táctica con llegada suave e histéresis
  steerToward(
    player,
    player.tacticalHome.x,
    player.tacticalHome.z,
    ball,
    ARRIVE_OUTFIELD,
    baseMax,
    0.85,
  );
}

/**
 * Lógica del arquero (`sub_42ea70`): posicionamiento de arco, estirada ante remates y saque con las manos/pie.
 */
export function updateGoalkeeperAI(
  gk: PlayerEntity,
  team: TeamEntity,
  ball: BallEntity,
  players: readonly PlayerEntity[],
  rng: DeterministicRNG,
  dt: number,
  events?: EventBus,
): void {
  if (advanceLockedPlayerState(gk, ball, players, rng, dt, events)) {
    return;
  }

  if (gk.hasBall) {
    gk.dirAcc = vec3(0, 0, 0);
    gk.vel.x *= 0.85;
    gk.vel.z *= 0.85;
    gk.facingDir = team.side === 1 ? 2 : 6;
    gk.actionState = 'gkHold';

    if (gk.stateTimer <= 0) {
      gk.stateTimer = 0.65;
      return;
    }
    gk.stateTimer -= dt;
    if (gk.stateTimer <= 0.02) {
      // Despeje / distribución del arquero (`GOALKEEPER_CONFIG`)
      const openMate = findBestPassReceiver(team, gk, team.side, rng.signedNormalized() * 0.45);
      const speed =
        GOALKEEPER_CONFIG.kickMinSpeed +
        (GOALKEEPER_CONFIG.kickMaxSpeed - GOALKEEPER_CONFIG.kickMinSpeed) * 0.72;
      if (openMate && rng.nextFloat() < 0.6) {
        kickBallToTarget(
          ball,
          players,
          gk,
          openMate.pos.x,
          openMate.pos.z,
          speed * 0.78,
          0.05 * Math.PI,
          0.55,
          rng,
          true,
        );
      } else {
        const puntX = team.side * (gk.pos.x * team.side + 900);
        const puntZ = rng.signedNormalized() * 260;
        kickBallToTarget(ball, players, gk, puntX, puntZ, speed, 0.09 * Math.PI, 0.95, rng, true);
      }
      gk.actionState = 'kick';
      gk.stateTimer = 0.25;
      events?.emit('sound:play', { key: 'kick', volumeScale: 1.0 });
    }
    return;
  }

  const goalLineX = -team.side * (FIELD.halfWidth - 34);
  const incomingTowardMyGoal = !ball.ownerPlayerId && ball.vel.x * team.side < -220;
  const distToGoalLine = Math.abs(ball.pos.x - goalLineX);

  // Detectar disparo inminente -> estirada (`gkJump` / anim 100, 102, 104)
  if (incomingTowardMyGoal && distToGoalLine < 420) {
    const timeToLine = distToGoalLine / Math.max(120, Math.abs(ball.vel.x));
    const predZ = ball.pos.z + ball.vel.z * timeToLine;
    const predY = Math.max(
      0,
      ball.pos.y + ball.vel.y * timeToLine + 0.5 * -480 * timeToLine * timeToLine,
    );
    const distFromGk = Math.hypot(ball.pos.x - gk.pos.x, predZ - gk.pos.z);

    if (
      Math.abs(predZ) <= FIELD.goalHalfZ + 42 &&
      distFromGk <= GOALKEEPER_CONFIG.diveTriggerDist + 140 &&
      timeToLine < 0.65
    ) {
      const zDiff = predZ - gk.pos.z;
      const sideSign = zDiff >= 0 ? 1 : -1;
      const centralHighShot = Math.abs(zDiff) < 38 && predY > 36;
      gk.actionState = 'gkJump';
      gk.stateTimer = 0.65;
      gk.dirAcc = vec3(0, 0, 0);
      gk.vel.z = centralHighShot ? zDiff * 1.5 : sideSign * GOALKEEPER_CONFIG.diveSpeed;
      gk.vel.x = (predY > 36 ? GOALKEEPER_CONFIG.highDiveExtraVx : 0) * team.side * 0.45;
      gk.vel.y = predY > 36 ? GOALKEEPER_CONFIG.highDiveVy : GOALKEEPER_CONFIG.diveVy;
      gk.baseAcc.y = -PLAYER_PHYSICS.gravity;
      events?.emit('sound:play', { key: 'action', volumeScale: 0.7 });
      return;
    }
  }

  // Salida a cortar balón suelto dentro del área chica si nadie la tiene
  const insideSmallBox =
    !ball.ownerPlayerId &&
    Math.abs(ball.pos.x - goalLineX) < 220 &&
    Math.abs(ball.pos.z) < 210 &&
    ball.pos.y < 36;

  const targetX = insideSmallBox ? ball.fallingPos.x : gk.tacticalHome.x;
  const targetZ = insideSmallBox
    ? ball.fallingPos.z
    : clamp(ball.fallingPos.z * 0.34, -FIELD.goalHalfZ + 16, FIELD.goalHalfZ - 16);

  gk.linearFriction = PLAYER_PHYSICS.groundFriction;
  steerToward(
    gk,
    targetX,
    targetZ,
    ball,
    ARRIVE_GK,
    PLAYER_PHYSICS.maxSpeed * gk.data.speed * 0.92,
    1.0,
    team.side === 1 ? 2 : 6,
  );
}

/**
 * Actualiza el ID y paso de animación (`jugador.json`) para cualquier jugador (`dt` a 30Hz).
 */
export function updatePlayerAnimation(
  player: PlayerEntity,
  isHumanActive: boolean,
  dt: number,
  events?: EventBus,
): void {
  const horizSpeed = Math.hypot(player.vel.x, player.vel.z);
  const dirOffset = player.facingDir; // 0, 2, 4, 6
  let desiredAnimId: number;

  if (player.isGoalkeeper) {
    switch (player.actionState) {
      case 'gkJump':
        if (Math.abs(player.vel.z) < 55 && player.vel.y > 120) {
          desiredAnimId = 102;
        } else {
          desiredAnimId = player.vel.z >= 0 ? 100 : 104;
        }
        break;
      case 'gkHold':
        desiredAnimId = player.teamSide === 1 ? 330 : 332;
        break;
      case 'kick':
        desiredAnimId = 70 + dirOffset;
        break;
      case 'run':
        desiredAnimId = horizSpeed > 18 ? (player.teamSide === 1 ? 340 : 342) : 320;
        break;
      case 'gkStand':
      default:
        desiredAnimId = 320;
        break;
    }
  } else {
    switch (player.actionState) {
      case 'run':
        desiredAnimId =
          horizSpeed >= PLAYER_PHYSICS.runAnimMinSpeed * 0.4 ? dirOffset : 20 + dirOffset;
        break;
      case 'tackle':
        desiredAnimId = 30 + dirOffset;
        break;
      case 'raise':
        desiredAnimId = 40 + dirOffset;
        break;
      case 'kickPrep':
        desiredAnimId = player.isChargingShot ? 10 : 60 + dirOffset;
        break;
      case 'kick':
        desiredAnimId = 70 + dirOffset;
        break;
      case 'headerPrep':
      case 'header':
        desiredAnimId = player.facingDir === 6 ? 82 : 80;
        break;
      case 'evasion':
        desiredAnimId = 90 + dirOffset;
        break;
      case 'throwIn':
        desiredAnimId = player.pos.z < 0 ? 54 : 56;
        break;
      case 'celebrate': {
        const celebAnims = [200, 210, 220, 230];
        desiredAnimId = horizSpeed > 25 ? 230 : celebAnims[player.data.number % celebAnims.length];
        break;
      }
      case 'idle':
      default:
        desiredAnimId = 20 + dirOffset;
        break;
    }
  }

  if (desiredAnimId !== player.animId) {
    player.animId = desiredAnimId;
    player.animStepIndex = 0;
    player.animTick = 0;
  } else {
    const speedFactor =
      player.actionState === 'run'
        ? clamp(
            (horizSpeed / PLAYER_PHYSICS.animRefSpeed) * PLAYER_PHYSICS.animSpeedFactor,
            0.55,
            2.2,
          )
        : 1.0;
    player.animTick += dt * 30 * speedFactor;
  }

  if (isHumanActive && player.actionState === 'run' && horizSpeed > 180) {
    player.stepSoundTimer -= dt;
    if (player.stepSoundTimer <= 0) {
      player.stepSoundTimer = 0.24;
      events?.emit('sound:play', { key: 'step', volumeScale: 0.28 });
    }
  } else {
    player.stepSoundTimer = 0.08;
  }
}
