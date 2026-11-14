import { BALL_PHYSICS, FIELD, MATCH_TIMERS, PLAYER_PHYSICS } from '../config/gameConfig';
import type { EventBus, MatchEventCode } from '../core/EventBus';
import type { FormationsData } from '../data/types';
import type { BallEntity } from '../entities/Ball';
import { clamp, cloneVec3, distXZ, vec3 } from '../entities/math3d';
import { getAllMatchPlayers, type MatchSessionState } from '../entities/MatchState';
import type { PlayerEntity } from '../entities/Player';
import { MATCH_SUB_STATE, type SetPieceInfo } from '../entities/Referee';
import type { TeamEntity } from '../entities/Team';
import { detachBall, updateBallFallingPos } from './BallPhysics';

export type RulesCheckOutcome = 'NONE' | 'POST_HIT' | 'GOAL' | 'OUT_OF_BOUNDS';

/**
 * Conmuta el balón contra los postes verticales, travesaño y redes de ambos arcos (`sub_42b430`, `sub_42b100`).
 */
export function resolveGoalStructureCollisions(
  ball: BallEntity,
  players: readonly PlayerEntity[],
  events?: EventBus,
): { readonly postHit: boolean; readonly netHit: boolean } {
  let postHit = false;
  let netHit = false;
  const hitRadius = FIELD.goalPostRadius + 3;

  for (const goalSign of [-1, 1] as const) {
    const goalX = goalSign * FIELD.halfWidth;
    const netBackX = goalSign * (FIELD.halfWidth + FIELD.goalDepth);

    // 1. Postes verticales (`z = ±117.12`, `y <= 78 + hitRadius`)
    for (const postZ of [-FIELD.goalHalfZ, FIELD.goalHalfZ]) {
      if (ball.pos.y <= FIELD.goalHeight + hitRadius) {
        const dx = ball.pos.x - goalX;
        const dz = ball.pos.z - postZ;
        const dist = Math.hypot(dx, dz);
        if (dist < hitRadius && dist > 1e-5) {
          const nx = dx / dist;
          const nz = dz / dist;
          ball.pos.x = goalX + nx * hitRadius;
          ball.pos.z = postZ + nz * hitRadius;
          const dot = ball.vel.x * nx + ball.vel.z * nz;
          if (dot < 0) {
            ball.vel.x = (ball.vel.x - 2 * dot * nx) * BALL_PHYSICS.postRestitution;
            ball.vel.z = (ball.vel.z - 2 * dot * nz) * BALL_PHYSICS.postRestitution;
            ball.vel.y *= BALL_PHYSICS.postRestitution;
            postHit = true;
          }
        }
      }
    }

    // 2. Travesaño (`x = goalX, y = 78, z in [-117.12, +117.12]`)
    if (Math.abs(ball.pos.z) <= FIELD.goalHalfZ + hitRadius) {
      const dx = ball.pos.x - goalX;
      const dy = ball.pos.y - FIELD.goalHeight;
      const dist = Math.hypot(dx, dy);
      if (dist < hitRadius && dist > 1e-5) {
        const nx = dx / dist;
        const ny = dy / dist;
        ball.pos.x = goalX + nx * hitRadius;
        ball.pos.y = Math.max(0, FIELD.goalHeight + ny * hitRadius);
        const dot = ball.vel.x * nx + ball.vel.y * ny;
        if (dot < 0) {
          ball.vel.x = (ball.vel.x - 2 * dot * nx) * BALL_PHYSICS.postRestitution;
          ball.vel.y = (ball.vel.y - 2 * dot * ny) * BALL_PHYSICS.postRestitution;
          ball.vel.z *= BALL_PHYSICS.postRestitution;
          postHit = true;
        }
      }
    }

    // 3. Redes laterales, trasera y superior (rebote físico por eje normal; en goles fuertes puede salir del arco)
    const insideDepthX =
      goalSign === -1 ? ball.pos.x < -FIELD.halfWidth : ball.pos.x > FIELD.halfWidth;
    const insideGoalMouth =
      Math.abs(ball.prevPos.z) <= FIELD.goalHalfZ + 6 && ball.prevPos.y <= FIELD.goalHeight + 6;
    let sideNetHit = false;

    if (insideDepthX && insideGoalMouth) {
      if (
        (goalSign === -1 && ball.pos.x <= netBackX) ||
        (goalSign === 1 && ball.pos.x >= netBackX)
      ) {
        ball.pos.x = netBackX - goalSign * 2;
        if (ball.vel.x * goalSign > 0) {
          ball.vel.x = -goalSign * Math.max(25, Math.abs(ball.vel.x) * 0.34);
          ball.vel.y *= 0.55;
          ball.vel.z *= 0.65;
          detachBall(ball, players);
          updateBallFallingPos(ball);
          sideNetHit = true;
        }
      }

      if (Math.abs(ball.pos.z) >= FIELD.goalHalfZ - 3) {
        const zSign = Math.sign(ball.pos.z) || 1;
        ball.pos.z = zSign * (FIELD.goalHalfZ - 3);
        if (ball.vel.z * zSign > 0) {
          ball.vel.z = -zSign * Math.abs(ball.vel.z) * 0.35;
          ball.vel.x *= 0.72;
          ball.vel.y *= 0.75;
          detachBall(ball, players);
          updateBallFallingPos(ball);
          sideNetHit = true;
        }
      }

      if (ball.pos.y >= FIELD.goalHeight - 3) {
        ball.pos.y = FIELD.goalHeight - 3;
        if (ball.vel.y > 0) {
          ball.vel.y = -Math.abs(ball.vel.y) * 0.35;
          ball.vel.x *= 0.78;
          ball.vel.z *= 0.78;
          detachBall(ball, players);
          updateBallFallingPos(ball);
          sideNetHit = true;
        }
      }
    } else if (
      insideDepthX &&
      !insideGoalMouth &&
      Math.abs(ball.pos.x) < FIELD.halfWidth + FIELD.goalDepth + 6 &&
      Math.abs(ball.pos.z) < FIELD.goalHalfZ + 8 &&
      ball.pos.y < FIELD.goalHeight + 8
    ) {
      // Rebote exterior contra la malla si un tiro desviado cruza detrás de la línea
      if (Math.abs(ball.prevPos.z) > FIELD.goalHalfZ) {
        const zSign = Math.sign(ball.prevPos.z) || 1;
        ball.pos.z = zSign * (FIELD.goalHalfZ + 6);
        if (ball.vel.z * zSign < 0) {
          ball.vel.z = zSign * Math.abs(ball.vel.z) * 0.35;
        }
      } else if (ball.prevPos.y > FIELD.goalHeight) {
        ball.pos.y = FIELD.goalHeight + 6;
        if (ball.vel.y < 0) {
          ball.vel.y = Math.abs(ball.vel.y) * 0.35;
        }
      }
      sideNetHit = true;
    }

    if (sideNetHit) {
      netHit = true;
    }
  }

  if (postHit) {
    detachBall(ball, players);
    updateBallFallingPos(ball);
    events?.emit('sound:play', { key: 'palo', volumeScale: 1.0 });
    events?.emit('sound:play', { key: 'tribuna:susto', volumeScale: 0.9 });
  }

  return { postHit, netHit };
}

/**
 * Evalúa gol, saque de banda, tiro de esquina y saque de arco (`sub_42b430`, `sub_42b3a0`, `sub_42bef0`).
 */
export function checkGoalAndBounds(match: MatchSessionState, events?: EventBus): RulesCheckOutcome {
  const players = getAllMatchPlayers(match);
  const ball = match.ball;
  const { postHit } = resolveGoalStructureCollisions(ball, players, events);

  // Chequear cruce del plano de gol Oeste (gol del equipo Derecho `side = -1`)
  if (ball.prevPos.x >= -FIELD.halfWidth && ball.pos.x < -FIELD.halfWidth) {
    const denom = ball.pos.x - ball.prevPos.x;
    const t = Math.abs(denom) > 1e-6 ? (-FIELD.halfWidth - ball.prevPos.x) / denom : 0;
    const zCross = ball.prevPos.z + (ball.pos.z - ball.prevPos.z) * t;
    const yCross = ball.prevPos.y + (ball.pos.y - ball.prevPos.y) * t;
    if (Math.abs(zCross) < FIELD.goalHalfZ - FIELD.goalPostRadius && yCross < FIELD.goalHeight) {
      triggerGoal(match, -1, events);
      return 'GOAL';
    }
  }

  // Chequear cruce del plano de gol Este (gol del equipo Izquierdo `side = 1`)
  if (ball.prevPos.x <= FIELD.halfWidth && ball.pos.x > FIELD.halfWidth) {
    const denom = ball.pos.x - ball.prevPos.x;
    const t = Math.abs(denom) > 1e-6 ? (FIELD.halfWidth - ball.prevPos.x) / denom : 0;
    const zCross = ball.prevPos.z + (ball.pos.z - ball.prevPos.z) * t;
    const yCross = ball.prevPos.y + (ball.pos.y - ball.prevPos.y) * t;
    if (Math.abs(zCross) < FIELD.goalHalfZ - FIELD.goalPostRadius && yCross < FIELD.goalHeight) {
      triggerGoal(match, 1, events);
      return 'GOAL';
    }
  }

  // Líneas laterales Norte y Sur (`z < -720` / `z > +720`)
  if (ball.pos.z < -FIELD.halfDepth || ball.pos.z > FIELD.halfDepth) {
    const isNorth = ball.pos.z < -FIELD.halfDepth;
    const boundZ = isNorth ? -FIELD.halfDepth : FIELD.halfDepth;
    const takerSide: 1 | -1 = ball.lastTouchTeamSide === 1 ? -1 : 1;
    const clampedX = clamp(ball.pos.x, -FIELD.halfWidth + 40, FIELD.halfWidth - 40);
    const code: MatchEventCode = isNorth ? 4 : 5;
    triggerSetPieceStop(
      match,
      code,
      {
        type: isNorth ? 'THROW_IN_NORTH' : 'THROW_IN_SOUTH',
        teamSide: takerSide,
        ballPos: vec3(clampedX, 0, boundZ),
        signSprite: 'lateral',
      },
      events,
    );
    return 'OUT_OF_BOUNDS';
  }

  // Línea de fondo Oeste (`x < -1440`, arco defendido por teamLeft `side = 1`)
  if (ball.pos.x < -FIELD.halfWidth) {
    const zCorner = ball.pos.z >= 0 ? FIELD.halfDepth - 16 : -FIELD.halfDepth + 16;
    const zGoalKick = ball.pos.z >= 0 ? 110 : -110;
    const isCorner = ball.lastTouchTeamSide === 1;
    const setPiece: SetPieceInfo = isCorner
      ? {
          type: 'CORNER_WEST',
          teamSide: -1,
          ballPos: vec3(-FIELD.halfWidth + 16, 0, zCorner),
          signSprite: 'tiroesquina',
        }
      : {
          type: 'GOAL_KICK_WEST',
          teamSide: 1,
          ballPos: vec3(-FIELD.halfWidth + 120, 0, zGoalKick),
          signSprite: 'saquedearco',
        };
    triggerSetPieceStop(match, 6, setPiece, events);
    return 'OUT_OF_BOUNDS';
  }

  // Línea de fondo Este (`x > +1440`, arco defendido por teamRight `side = -1`)
  if (ball.pos.x > FIELD.halfWidth) {
    const zCorner = ball.pos.z >= 0 ? FIELD.halfDepth - 16 : -FIELD.halfDepth + 16;
    const zGoalKick = ball.pos.z >= 0 ? 110 : -110;
    const isCorner = ball.lastTouchTeamSide === -1;
    const setPiece: SetPieceInfo = isCorner
      ? {
          type: 'CORNER_EAST',
          teamSide: 1,
          ballPos: vec3(FIELD.halfWidth - 16, 0, zCorner),
          signSprite: 'tiroesquina',
        }
      : {
          type: 'GOAL_KICK_EAST',
          teamSide: -1,
          ballPos: vec3(FIELD.halfWidth - 120, 0, zGoalKick),
          signSprite: 'saquedearco',
        };
    triggerSetPieceStop(match, 7, setPiece, events);
    return 'OUT_OF_BOUNDS';
  }

  return postHit ? 'POST_HIT' : 'NONE';
}

function triggerGoal(match: MatchSessionState, scoringTeamSide: 1 | -1, events?: EventBus): void {
  const players = getAllMatchPlayers(match);
  detachBall(match.ball, players);

  const scoringTeam = scoringTeamSide === 1 ? match.teamLeft : match.teamRight;
  scoringTeam.score += 1;

  const concedeSide: 1 | -1 = scoringTeamSide === 1 ? -1 : 1;
  match.lastGoalTeamSide = scoringTeamSide;
  match.lastGoalScorerName =
    match.ball.lastTouchTeamSide === scoringTeamSide && match.ball.lastTouchPlayerName
      ? match.ball.lastTouchPlayerName
      : (scoringTeam.data.players[9]?.name ?? scoringTeam.data.shortName);
  match.lastGoalScorerNumber =
    match.ball.lastTouchTeamSide === scoringTeamSide && match.ball.lastTouchPlayerNumber > 0
      ? match.ball.lastTouchPlayerNumber
      : 10;

  match.isGoalPending = true;
  match.setPiece = {
    type: 'KICK_OFF',
    teamSide: concedeSide,
    ballPos: vec3(0, 0, 0),
    signSprite: 'kickOff',
  };
  match.subState = MATCH_SUB_STATE.STOPPED_WAIT;
  match.stateTimer = MATCH_TIMERS.goalWaitSeconds;
  match.activeSignSprite = 'gol';
  match.activeSignTimer = MATCH_TIMERS.goalWaitSeconds;

  const celebAnims = [200, 210, 220, 230] as const;
  for (const p of players) {
    if (p.teamSide === scoringTeamSide && !p.isGoalkeeper) {
      p.actionState = 'celebrate';
      p.facingDir = p.teamSide === 1 ? 6 : 2;
      p.animId =
        p.data.number === match.lastGoalScorerNumber
          ? 230
          : celebAnims[p.data.number % celebAnims.length];
    }
  }

  events?.emit('sound:play', { key: 'whistle:goal', volumeScale: 1.0 });
  events?.emit('sound:play', { key: 'tribuna:ovacion', volumeScale: 1.0 });
  events?.emit('match:goal', {
    scoringTeamSide,
    scorerName: match.lastGoalScorerName,
    scorerNumber: match.lastGoalScorerNumber,
  });
  events?.emit('match:event', { code: 3, teamSide: scoringTeamSide });
}

function triggerSetPieceStop(
  match: MatchSessionState,
  code: MatchEventCode,
  setPiece: SetPieceInfo,
  events?: EventBus,
): void {
  detachBall(match.ball, getAllMatchPlayers(match));
  match.isGoalPending = false;
  match.setPiece = setPiece;
  match.subState = MATCH_SUB_STATE.STOPPED_WAIT;
  match.stateTimer = MATCH_TIMERS.setPieceWaitSeconds;
  match.activeSignSprite = setPiece.signSprite;
  match.activeSignTimer = 1.6;

  events?.emit('sound:play', { key: 'whistle:short', volumeScale: 1.0 });
  events?.emit('match:event', { code, teamSide: setPiece.teamSide });
}

/**
 * Ubica pelota y los 22 jugadores para cualquier pelota parada (`sub_42cf90`, `sub_43b3f0`).
 */
export function setupSetPiecePositions(
  match: MatchSessionState,
  formationsData: FormationsData,
): void {
  const { setPiece } = match;
  const ball = match.ball;
  detachBall(ball, getAllMatchPlayers(match));

  ball.pos = cloneVec3(setPiece.ballPos);
  ball.prevPos = cloneVec3(setPiece.ballPos);
  ball.originPos = cloneVec3(setPiece.ballPos);
  ball.fallingPos = cloneVec3(setPiece.ballPos);
  ball.vel = vec3(0, 0, 0);
  ball.baseAcc = vec3(0, 0, 0);
  ball.immunityTimer = 0.05;
  ball.spinAnimId = 20;

  positionTeamForSetPiece(match.teamLeft, formationsData, setPiece);
  positionTeamForSetPiece(match.teamRight, formationsData, setPiece);

  if (setPiece.type === 'KICK_OFF') {
    const kickTeam = setPiece.teamSide === 1 ? match.teamLeft : match.teamRight;
    const taker =
      kickTeam.players.find((p) => p.data.number === 9) ??
      kickTeam.players[9] ??
      kickTeam.players[1];
    if (taker) {
      taker.pos.x = -kickTeam.side * 16;
      taker.pos.z = 0;
      taker.facingDir = kickTeam.side === 1 ? 2 : 6;
      kickTeam.activePlayerIndex = taker.indexInTeam;
      kickTeam.nearestPlayerIndex = taker.indexInTeam;
    }
    const partner = kickTeam.players.find((p) => p.data.number === 10) ?? kickTeam.players[8];
    if (partner && partner.uid !== taker?.uid) {
      partner.pos.x = -kickTeam.side * 36;
      partner.pos.z = 64;
    }
  } else {
    const takingTeam = setPiece.teamSide === 1 ? match.teamLeft : match.teamRight;
    const taker = selectSetPieceTaker(takingTeam, setPiece);
    if (taker) {
      const offsetBehind =
        setPiece.type === 'THROW_IN_NORTH'
          ? { dx: 0, dz: -10 }
          : setPiece.type === 'THROW_IN_SOUTH'
            ? { dx: 0, dz: 10 }
            : { dx: -takingTeam.side * 12, dz: 0 };
      taker.pos.x = clamp(
        setPiece.ballPos.x + offsetBehind.dx,
        -FIELD.playerLimitX,
        FIELD.playerLimitX,
      );
      taker.pos.z = clamp(
        setPiece.ballPos.z + offsetBehind.dz,
        -FIELD.playerLimitZ,
        FIELD.playerLimitZ,
      );
      taker.vel = vec3(0, 0, 0);
      taker.facingDir =
        setPiece.type === 'THROW_IN_NORTH'
          ? 0
          : setPiece.type === 'THROW_IN_SOUTH'
            ? 4
            : takingTeam.side === 1
              ? 2
              : 6;
      takingTeam.activePlayerIndex = taker.indexInTeam;
      takingTeam.nearestPlayerIndex = taker.indexInTeam;
    }

    // Separar rivales al menos 150 px del punto de saque.
    const oppTeam = setPiece.teamSide === 1 ? match.teamRight : match.teamLeft;
    for (const opp of oppTeam.players) {
      const d = distXZ(opp.pos, setPiece.ballPos);
      if (d < 160) {
        opp.pos.x = clamp(opp.pos.x - oppTeam.side * 180, -FIELD.playerLimitX, FIELD.playerLimitX);
        if (opp.pos.z < -FIELD.halfDepth + 120) opp.pos.z = -FIELD.halfDepth + 140;
        if (opp.pos.z > FIELD.halfDepth - 120) opp.pos.z = FIELD.halfDepth - 140;
      }
    }
  }
}

function positionTeamForSetPiece(
  team: TeamEntity,
  formationsData: FormationsData,
  setPiece: SetPieceInfo,
): void {
  const formation = formationsData.formations[team.data.formation];
  for (const player of team.players) {
    player.vel = vec3(0, 0, 0);
    player.baseAcc = vec3(0, 0, 0);
    player.dirAcc = vec3(0, 0, 0);
    player.hasBall = false;
    player.isChargingShot = false;
    player.shotChargeTimer = 0;
    player.isChargingPass = false;
    player.passChargeTimer = 0;
    player.stateTimer = 0;
    player.isSteering = false;
    player.maxSpeed = PLAYER_PHYSICS.maxSpeed * player.data.speed;
    player.facingDir = team.side === 1 ? 2 : 6;
    player.actionState = player.isGoalkeeper ? 'gkStand' : 'idle';
    player.animId = player.isGoalkeeper ? 320 : team.side === 1 ? 22 : 26;

    if (player.isGoalkeeper) {
      player.pos = vec3(-team.side * (FIELD.halfWidth - 36), 0, 0);
      player.tacticalHome = cloneVec3(player.pos);
      continue;
    }

    const posDef =
      formation.outfieldPositions.find((f) => f.playerNumber === player.data.number) ??
      formation.outfieldPositions[(player.data.number - 2) % formation.outfieldPositions.length];

    let worldX = (-FIELD.halfWidth + posDef.x * FIELD.halfWidth * 1.15) * team.side;
    const worldZ = (posDef.y - 0.5) * (FIELD.halfDepth * 1.65);

    if (setPiece.type === 'KICK_OFF') {
      // Mantener en campo propio para saque del medio.
      if (team.side === 1) {
        worldX = clamp(worldX, -FIELD.halfWidth + 80, -90);
      } else {
        worldX = clamp(worldX, 90, FIELD.halfWidth - 80);
      }
      if (Math.hypot(worldX, worldZ) < 150) {
        worldX = -team.side * 170;
      }
    } else if (setPiece.type === 'CORNER_WEST' || setPiece.type === 'CORNER_EAST') {
      const boxCenterX =
        setPiece.type === 'CORNER_WEST' ? -FIELD.halfWidth + 240 : FIELD.halfWidth - 240;
      worldX = clamp(
        boxCenterX + (posDef.x - 0.5) * 320 * team.side,
        -FIELD.halfWidth + 60,
        FIELD.halfWidth - 60,
      );
    } else {
      worldX = clamp(
        worldX + clamp(setPiece.ballPos.x, -900, 900) * 0.4,
        -FIELD.halfWidth + 70,
        FIELD.halfWidth - 70,
      );
    }

    player.pos = vec3(worldX, 0, clamp(worldZ, -FIELD.halfDepth + 50, FIELD.halfDepth - 50));
    player.tacticalHome = cloneVec3(player.pos);
  }
}

function selectSetPieceTaker(team: TeamEntity, setPiece: SetPieceInfo): PlayerEntity | undefined {
  if (setPiece.type === 'GOAL_KICK_WEST' || setPiece.type === 'GOAL_KICK_EAST') {
    return team.players.find((p) => p.isGoalkeeper) ?? team.players[0];
  }
  const outfield = team.players.filter((p) => !p.isGoalkeeper);
  return outfield.sort(
    (a, b) => distXZ(a.pos, setPiece.ballPos) - distXZ(b.pos, setPiece.ballPos),
  )[0];
}
