import { CAMERA_CONFIG, GAME_SPEED_SCALES, MATCH_TIMERS } from '../config/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { DeterministicRNG } from '../core/RNG';
import type { FormationsData } from '../data/types';
import { clamp, integrateKinematic3D, normalizeXZ, vec3 } from '../entities/math3d';
import { getAllMatchPlayers, type MatchSessionState } from '../entities/MatchState';
import { type PlayerEntity, vectorToFacingDirection } from '../entities/Player';
import { MATCH_SUB_STATE } from '../entities/Referee';
import type { TeamEntity } from '../entities/Team';
import type { InputProfile, InputReader } from '../input/InputManager';
import { kickBallDirect, kickBallToTarget, updateBallPhysics } from './BallPhysics';
import {
  clampPlayersToField,
  resolveBallPlayerInteractions,
  resolvePlayerCollisions,
} from './Collisions';
import {
  checkGoalAndBounds,
  resolveGoalStructureCollisions,
  setupSetPiecePositions,
} from './RulesEngine';
import {
  computeTacticalTargets,
  findBestPassReceiver,
  updateFieldPlayerAI,
  updateFieldPlayerHuman,
  updateGoalkeeperAI,
  updatePlayerAnimation,
  updateTeamNearestAndActive,
} from './TacticalAI';

export interface MatchSimulationContext {
  readonly formationsData: FormationsData;
  readonly rng: DeterministicRNG;
  readonly input: InputReader;
  readonly events?: EventBus;
  speedIndex: 0 | 1 | 2 | 3;
}

/**
 * Simulación pura de un partido (sin dependencias de DOM/Canvas), ejecutada a 30 Hz fijos.
 */
export class MatchSimulation {
  private readonly ctx: MatchSimulationContext;

  constructor(ctx: MatchSimulationContext) {
    this.ctx = ctx;
  }

  public initializeKickOff(match: MatchSessionState): void {
    setupSetPiecePositions(match, this.ctx.formationsData);
    match.subState = MATCH_SUB_STATE.DIALOG_WAIT;
    match.stateTimer = 1.4;
    match.activeSignSprite = 'kickOff';
    match.activeSignTimer = 1.4;
    match.camera.pos = vec3(0, 0, 0);
    match.camera.target = vec3(0, 0, 0);
  }

  public step(match: MatchSessionState, dt: number): void {
    if (match.paused || match.matchFinished) {
      return;
    }

    const speedScale = GAME_SPEED_SCALES[this.ctx.speedIndex] ?? 1.0;
    const simDt = dt * speedScale;

    if (match.activeSignTimer > 0) {
      match.activeSignTimer = Math.max(0, match.activeSignTimer - dt);
      if (match.activeSignTimer <= 0) {
        match.activeSignSprite = null;
      }
    }

    this.updateFade(match, dt);

    switch (match.subState) {
      case MATCH_SUB_STATE.DIALOG_WAIT: {
        this.stepCamera(match, dt);
        this.animateAllIdleOrCelebrate(match, dt);
        match.stateTimer -= dt;
        if (match.stateTimer <= 0) {
          match.subState = MATCH_SUB_STATE.PRE_SET_PIECE;
          match.stateTimer = 0.65;
          match.activeSignSprite = null;
          this.ctx.events?.emit('sound:play', { key: 'whistle:start', volumeScale: 1.0 });
        }
        break;
      }

      case MATCH_SUB_STATE.PLAYING: {
        this.advanceClock(match, simDt);
        this.stepPlaying(match, simDt);
        this.stepCamera(match, simDt);
        break;
      }

      case MATCH_SUB_STATE.STOPPED_WAIT: {
        const players = getAllMatchPlayers(match);
        updateBallPhysics(match.ball, players, simDt, this.ctx.events);
        resolveGoalStructureCollisions(match.ball, players, this.ctx.events);
        this.animateAllIdleOrCelebrate(match, dt);
        this.integrateAllPlayers(players, simDt);
        clampPlayersToField(players);
        this.stepCamera(match, dt);

        match.stateTimer -= dt;
        if (match.stateTimer <= 0) {
          if (match.isGoalPending) {
            match.subState = MATCH_SUB_STATE.GOAL_CELEBRATION_BANNER;
            match.stateTimer = MATCH_TIMERS.goalBannerSeconds;
            match.goalBannerPhase = 0;
            this.ctx.events?.emit('sound:play', { key: 'tribuna:ovacionCorta', volumeScale: 0.9 });
          } else if (match.isHalfEndPending && match.half === 1) {
            this.transitionToSecondHalf(match);
          } else if (match.isExpired) {
            match.subState = MATCH_SUB_STATE.MATCH_END_DELAY;
            match.stateTimer = MATCH_TIMERS.matchEndDelaySeconds;
            match.activeSignSprite = 'endGame';
            match.activeSignTimer = 2.0;
          } else {
            this.beginFadeToSetPiece(match);
          }
        }
        break;
      }

      case MATCH_SUB_STATE.GOAL_CELEBRATION_BANNER: {
        const players = getAllMatchPlayers(match);
        updateBallPhysics(match.ball, players, simDt, this.ctx.events);
        resolveGoalStructureCollisions(match.ball, players, this.ctx.events);
        this.animateAllIdleOrCelebrate(match, dt);
        this.integrateAllPlayers(players, simDt);
        clampPlayersToField(players);
        this.stepCamera(match, dt);

        match.goalBannerPhase += dt;
        match.stateTimer -= dt;
        const skipPressed =
          this.ctx.input.getAction('menu', 'accept').justPressed ||
          this.ctx.input.getAction('P1_SOLO', 'shot').justPressed ||
          this.ctx.input.getAction('P1_2P', 'shot').justPressed ||
          this.ctx.input.getAction('P2_2P', 'shot').justPressed;

        if (match.stateTimer <= 0 || (match.goalBannerPhase > 1.2 && skipPressed)) {
          match.isGoalPending = false;
          if (match.isExpired) {
            match.subState = MATCH_SUB_STATE.MATCH_END_DELAY;
            match.stateTimer = MATCH_TIMERS.matchEndDelaySeconds;
            match.activeSignSprite = 'endGame';
            match.activeSignTimer = 2.0;
          } else if (match.isHalfEndPending && match.half === 1) {
            this.transitionToSecondHalf(match);
          } else {
            this.beginFadeToSetPiece(match);
          }
        }
        break;
      }

      case MATCH_SUB_STATE.PRE_SET_PIECE: {
        this.stepPreSetPiece(match, dt);
        this.stepCamera(match, dt);
        break;
      }

      case MATCH_SUB_STATE.MATCH_END_DELAY: {
        this.stepCamera(match, dt);
        match.stateTimer -= dt;
        if (match.stateTimer <= 0) {
          match.matchFinished = true;
          this.ctx.events?.emit('match:event', { code: 8 });
        }
        break;
      }
    }
  }

  private advanceClock(match: MatchSessionState, simDt: number): void {
    match.elapsedSeconds += simDt;
    if (match.elapsedSeconds < match.halfDurationSeconds) {
      return;
    }

    match.elapsedSeconds = match.halfDurationSeconds;
    if (match.half === 1 && !match.isHalfEndPending) {
      match.isHalfEndPending = true;
      match.subState = MATCH_SUB_STATE.STOPPED_WAIT;
      match.stateTimer = 1.6;
      match.activeSignSprite = 'firstTimeEnd';
      match.activeSignTimer = 1.6;
      this.ctx.events?.emit('sound:play', { key: 'whistle:end', volumeScale: 1.0 });
    } else if (match.half === 2 && !match.isExpired) {
      match.isExpired = true;
      match.subState = MATCH_SUB_STATE.STOPPED_WAIT;
      match.stateTimer = 1.6;
      match.activeSignSprite = 'endGame';
      match.activeSignTimer = 2.2;
      this.ctx.events?.emit('sound:play', { key: 'whistle:end', volumeScale: 1.0 });
    }
  }

  private transitionToSecondHalf(match: MatchSessionState): void {
    match.half = 2;
    match.elapsedSeconds = 0;
    match.isHalfEndPending = false;
    match.setPiece = {
      type: 'KICK_OFF',
      teamSide: -1,
      ballPos: vec3(0, 0, 0),
      signSprite: 'secondHalf',
    };
    setupSetPiecePositions(match, this.ctx.formationsData);
    match.subState = MATCH_SUB_STATE.DIALOG_WAIT;
    match.stateTimer = 1.4;
    match.activeSignSprite = 'secondHalf';
    match.activeSignTimer = 1.4;
  }

  private beginFadeToSetPiece(match: MatchSessionState): void {
    setupSetPiecePositions(match, this.ctx.formationsData);
    match.subState = MATCH_SUB_STATE.PRE_SET_PIECE;
    match.stateTimer = 0.65;
    match.fadeAlpha = 0.65;
    match.fadeDirection = 'in';
    match.activeSignSprite = null;
  }

  private updateFade(match: MatchSessionState, dt: number): void {
    if (match.fadeDirection === 'in') {
      match.fadeAlpha = Math.max(0, match.fadeAlpha - dt * 2.2);
      if (match.fadeAlpha <= 0) {
        match.fadeDirection = 'none';
      }
    } else if (match.fadeDirection === 'out') {
      match.fadeAlpha = Math.min(1, match.fadeAlpha + dt * 2.2);
      if (match.fadeAlpha >= 1) {
        match.fadeDirection = 'in';
      }
    }
  }

  private stepPlaying(match: MatchSessionState, simDt: number): void {
    const allPlayers = getAllMatchPlayers(match);

    computeTacticalTargets(match.teamLeft, match.ball, this.ctx.formationsData, simDt);
    computeTacticalTargets(match.teamRight, match.ball, this.ctx.formationsData, simDt);

    updateTeamNearestAndActive(match.teamLeft, match.ball, this.ctx.input);
    updateTeamNearestAndActive(match.teamRight, match.ball, this.ctx.input);

    this.stepTeamPlayers(match.teamLeft, match.teamRight, match.ball, allPlayers, simDt);
    this.stepTeamPlayers(match.teamRight, match.teamLeft, match.ball, allPlayers, simDt);

    this.integrateAllPlayers(allPlayers, simDt);
    clampPlayersToField(allPlayers);

    updateBallPhysics(match.ball, allPlayers, simDt, this.ctx.events);
    resolveBallPlayerInteractions(match.ball, allPlayers, this.ctx.events);
    resolvePlayerCollisions(allPlayers, simDt);
    clampPlayersToField(allPlayers);

    checkGoalAndBounds(match, this.ctx.events);
  }

  private stepTeamPlayers(
    team: TeamEntity,
    oppTeam: TeamEntity,
    ball: MatchSessionState['ball'],
    allPlayers: readonly PlayerEntity[],
    dt: number,
  ): void {
    const isHumanTeam = team.controlMode !== 'CPU';
    const profile = team.controlMode as InputProfile;

    for (const player of team.players) {
      if (player.isGoalkeeper) {
        updateGoalkeeperAI(player, team, ball, allPlayers, this.ctx.rng, dt, this.ctx.events);
        updatePlayerAnimation(player, false, dt, this.ctx.events);
        continue;
      }

      const isActive = player.indexInTeam === team.activePlayerIndex;
      const isNearest = player.indexInTeam === team.nearestPlayerIndex;

      if (isHumanTeam && isActive) {
        updateFieldPlayerHuman(
          player,
          team,
          ball,
          allPlayers,
          this.ctx.input,
          profile,
          this.ctx.rng,
          dt,
          this.ctx.events,
        );
        updatePlayerAnimation(player, true, dt, this.ctx.events);
      } else {
        updateFieldPlayerAI(
          player,
          team,
          oppTeam,
          ball,
          allPlayers,
          isNearest,
          this.ctx.rng,
          dt,
          this.ctx.events,
        );
        updatePlayerAnimation(player, false, dt, this.ctx.events);
      }
    }
  }

  private stepPreSetPiece(match: MatchSessionState, dt: number): void {
    const takingTeam = match.setPiece.teamSide === 1 ? match.teamLeft : match.teamRight;
    const taker = takingTeam.players[takingTeam.activePlayerIndex] ?? takingTeam.players[9];
    this.animateAllIdleOrCelebrate(match, dt);

    if (!taker) {
      match.subState = MATCH_SUB_STATE.PLAYING;
      return;
    }

    match.stateTimer -= dt;

    if (takingTeam.controlMode !== 'CPU') {
      const profile = takingTeam.controlMode as InputProfile;
      const aim = this.ctx.input.getDirection(profile);
      const shootPressed = this.ctx.input.getAction(profile, 'shot').justPressed;
      const passPressed = this.ctx.input.getAction(profile, 'pass').justPressed;
      const timedOut = match.stateTimer < -5.5;

      if (!shootPressed && !passPressed && !timedOut) {
        return;
      }

      const defaultX = takingTeam.side;
      const aimX = Math.abs(aim.x) > 0.1 || Math.abs(aim.z) > 0.1 ? aim.x : defaultX;
      const aimZ = Math.abs(aim.x) > 0.1 || Math.abs(aim.z) > 0.1 ? aim.z : 0;
      const mate = findBestPassReceiver(takingTeam, taker, aimX, aimZ);

      if (
        shootPressed &&
        match.setPiece.type !== 'THROW_IN_NORTH' &&
        match.setPiece.type !== 'THROW_IN_SOUTH'
      ) {
        const dir = normalizeXZ(aimX, aimZ);
        kickBallDirect(match.ball, getAllMatchPlayers(match), taker, dir.x, dir.z, 540, 220);
      } else if (mate) {
        kickBallToTarget(
          match.ball,
          getAllMatchPlayers(match),
          taker,
          mate.pos.x,
          mate.pos.z,
          380,
          0.05 * Math.PI,
          match.setPiece.type.startsWith('GOAL_KICK') ? 0.65 : 0.15,
          this.ctx.rng,
          true,
        );
      } else {
        const dir = normalizeXZ(aimX, aimZ);
        kickBallDirect(match.ball, getAllMatchPlayers(match), taker, dir.x, dir.z, 360, 120);
      }

      taker.actionState = 'kick';
      taker.stateTimer = 0.2;
      match.subState = MATCH_SUB_STATE.PLAYING;
      this.ctx.events?.emit('sound:play', { key: 'kick', volumeScale: 1.0 });
      return;
    }

    // Ejecución automática para equipo CPU tras breve pausa
    if (match.stateTimer <= 0) {
      const targetDirX =
        match.setPiece.type === 'KICK_OFF'
          ? -takingTeam.side * 0.25
          : match.setPiece.type === 'CORNER_WEST'
            ? 1
            : match.setPiece.type === 'CORNER_EAST'
              ? -1
              : takingTeam.side;
      const targetDirZ =
        match.setPiece.type === 'THROW_IN_NORTH'
          ? 1
          : match.setPiece.type === 'THROW_IN_SOUTH'
            ? -1
            : this.ctx.rng.signedNormalized() * 0.45;

      const mate = findBestPassReceiver(takingTeam, taker, targetDirX, targetDirZ);
      const players = getAllMatchPlayers(match);
      if (mate) {
        kickBallToTarget(
          match.ball,
          players,
          taker,
          mate.pos.x,
          mate.pos.z,
          360,
          0.05 * Math.PI,
          match.setPiece.type.startsWith('GOAL_KICK') ? 0.7 : 0.2,
          this.ctx.rng,
          true,
        );
      } else {
        const dir = normalizeXZ(targetDirX, targetDirZ);
        kickBallDirect(match.ball, players, taker, dir.x, dir.z, 340, 120);
      }

      taker.actionState = 'kick';
      taker.stateTimer = 0.2;
      match.subState = MATCH_SUB_STATE.PLAYING;
      this.ctx.events?.emit('sound:play', { key: 'kick', volumeScale: 0.95 });
    }
  }

  private integrateAllPlayers(players: readonly PlayerEntity[], dt: number): void {
    for (const player of players) {
      if (player.pos.y > 0 || player.vel.y !== 0) {
        player.baseAcc.y = -980;
      } else {
        player.baseAcc.y = 0;
      }
      integrateKinematic3D(player, dt);
      if (player.pos.y <= 0 && player.vel.y < 0) {
        player.pos.y = 0;
        player.vel.y = 0;
        player.baseAcc.y = 0;
      }
    }
  }

  private animateAllIdleOrCelebrate(match: MatchSessionState, dt: number): void {
    const players = getAllMatchPlayers(match);
    for (const p of players) {
      if (p.actionState === 'celebrate') {
        const isScorer =
          p.teamSide === match.lastGoalTeamSide && p.data.number === match.lastGoalScorerNumber;
        const targetX = 0;
        const targetZ = p.pos.z >= 0 ? 220 : -220;
        const dx = targetX - p.pos.x;
        const dz = targetZ - p.pos.z;
        const dist = Math.hypot(dx, dz);
        if ((isScorer || dist > 260) && dist > 60) {
          const dir = normalizeXZ(dx, dz);
          p.dirAcc = vec3(dir.x * 0.55, 0, dir.z * 0.55);
          p.maxSpeed = 165;
          p.facingDir = vectorToFacingDirection(dir.x, dir.z, p.facingDir);
        } else {
          p.dirAcc = vec3(0, 0, 0);
          p.vel.x *= 0.85;
          p.vel.z *= 0.85;
        }
      } else {
        p.vel = vec3(0, 0, 0);
        p.dirAcc = vec3(0, 0, 0);
        p.actionState = p.isGoalkeeper ? 'gkStand' : 'idle';
      }
      updatePlayerAnimation(p, false, dt);
    }
  }

  private stepCamera(match: MatchSessionState, dt: number): void {
    const shouldTrackScorer =
      match.isGoalPending &&
      (match.subState === MATCH_SUB_STATE.GOAL_CELEBRATION_BANNER ||
        (match.subState === MATCH_SUB_STATE.STOPPED_WAIT &&
          match.stateTimer < MATCH_TIMERS.goalWaitSeconds - 1.0));
    let focusX = match.ball.pos.x;
    let focusZ = match.ball.pos.z;
    let leadInput = match.ball.vel.x;

    if (shouldTrackScorer) {
      const team = match.lastGoalTeamSide === 1 ? match.teamLeft : match.teamRight;
      const scorer =
        team.players.find((p) => p.data.number === match.lastGoalScorerNumber) ??
        team.players.find((p) => p.actionState === 'celebrate');
      if (scorer) {
        focusX = scorer.pos.x;
        focusZ = scorer.pos.z;
        leadInput = scorer.vel.x * 0.5;
      }
    }

    const leadTarget = clamp(leadInput * 0.22, -CAMERA_CONFIG.leadOffset, CAMERA_CONFIG.leadOffset);
    const leadStep = Math.min(1, CAMERA_CONFIG.leadLerp * dt);
    match.camera.currentLead += (leadTarget - match.camera.currentLead) * leadStep;

    match.camera.target.x = clamp(
      focusX + match.camera.currentLead,
      -CAMERA_CONFIG.worldClampX,
      CAMERA_CONFIG.worldClampX,
    );
    match.camera.target.z = clamp(
      focusZ * 0.85,
      -CAMERA_CONFIG.worldClampY,
      CAMERA_CONFIG.worldClampY,
    );

    const step = Math.min(1, CAMERA_CONFIG.lerpSpeed * dt);
    match.camera.pos.x += (match.camera.target.x - match.camera.pos.x) * step;
    match.camera.pos.z += (match.camera.target.z - match.camera.pos.z) * step;
  }
}
