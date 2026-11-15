import assert from 'node:assert/strict';
import {
  ACTION_CONFIG,
  BALL_PHYSICS,
  FIELD,
  FIXED_DT,
  PLAYER_PHYSICS,
  projectWorldToScreen,
} from '../../config/gameConfig';
import { EventBus } from '../../core/EventBus';
import { DeterministicRNG } from '../../core/RNG';
import formationsJson from '../../data/formations.json';
import teamsJson from '../../data/teams.json';
import type { FormationsData, TeamsData } from '../../data/types';
import { createBallEntity } from '../../entities/Ball';
import { integrateKinematic3D, vec3 } from '../../entities/math3d';
import { createMatchSessionState, getAllMatchPlayers } from '../../entities/MatchState';
import { type FacingDirection, type PlayerActionState } from '../../entities/Player';
import { MATCH_SUB_STATE } from '../../entities/Referee';
import {
  type ActionStateSnapshot,
  InputManager,
  type InputProfile,
  type InputReader,
  type ProfileDirection,
  type SemanticAction,
} from '../../input/InputManager';
import { kickBallDirect, updateBallFallingPos, updateBallPhysics } from '../BallPhysics';
import { resolveBallPlayerInteractions } from '../Collisions';
import { MatchSimulation } from '../MatchSimulation';
import {
  checkGoalAndBounds,
  resolveGoalStructureCollisions,
  setupSetPiecePositions,
} from '../RulesEngine';
import { updateFieldPlayerAI, updateGoalkeeperAI, updatePlayerAnimation } from '../TacticalAI';

const teamsData = teamsJson as unknown as TeamsData;
const formationsData = formationsJson as unknown as FormationsData;

function testTrapezoidalPerspective(): void {
  const north = projectWorldToScreen(1440, 0, -FIELD.halfDepth);
  assert.equal(north.x, 1080);
  assert.equal(north.y, -360);

  const mid = projectWorldToScreen(1440, 0, 0);
  assert.equal(mid.x, 1260);
  assert.equal(mid.y, 0);

  const south = projectWorldToScreen(1440, 0, FIELD.halfDepth);
  assert.equal(south.x, 1440);
  assert.equal(south.y, 360);

  const crossbar = projectWorldToScreen(0, FIELD.goalHeight, 0);
  assert.equal(crossbar.x, 0);
  assert.equal(crossbar.y, -78);
}

function testKinematicsAndBallBounce(): void {
  const ball = createBallEntity();
  ball.pos = vec3(0, 60, 0);
  ball.vel = vec3(200, 0, 0);
  ball.baseAcc = vec3(0, BALL_PHYSICS.gravity, 0);

  integrateKinematic3D(ball, FIXED_DT);
  assert.ok(ball.pos.y < 60, 'La gravedad debe hacer descender el balón');
  assert.ok(ball.vel.y < 0, 'vel.y debe volverse negativa bajo gravedad');

  // Lanzar al suelo con velocidad vertical fuerte para verificar rebote (restitution = 0.65)
  ball.pos = vec3(0, 2, 0);
  ball.vel = vec3(100, -120, 0);
  let bounced = false;
  for (let i = 0; i < 10; i += 1) {
    updateBallPhysics(ball, [], FIXED_DT);
    if (ball.vel.y > 0) {
      bounced = true;
      break;
    }
  }
  assert.ok(bounced, 'El balón debe rebotar al impactar el suelo con |vy| * 0.65 >= 20');
  assert.ok(Math.abs(ball.vel.y) <= 120 * BALL_PHYSICS.restitution + 10);

  updateBallFallingPos(ball);
  assert.equal(ball.fallingPos.y, 0);
  assert.ok(Number.isFinite(ball.fallingPos.x) && ball.fallingPos.x > ball.pos.x);
}

function createSampleMatch() {
  const teamA = { ...teamsData.teams[0], formation: '442' as const };
  const teamB = { ...teamsData.teams[1], formation: '433' as const };
  return createMatchSessionState({
    mode: 'CPUvsCPU',
    leftTeam: teamA,
    rightTeam: teamB,
    leftControl: 'CPU',
    rightControl: 'CPU',
    durationIndex: 0,
  });
}

function testGoalPostsAndSetPieces(): void {
  // 1. Detección de gol en arco Este
  {
    const match = createSampleMatch();
    const events = new EventBus();
    let goalEmitted = false;
    events.on('match:goal', (p) => {
      goalEmitted = p.scoringTeamSide === 1;
    });
    match.ball.prevPos = vec3(FIELD.halfWidth - 8, 20, 10);
    match.ball.pos = vec3(FIELD.halfWidth + 12, 20, 10);
    match.ball.lastTouchTeamSide = 1;
    const outcome = checkGoalAndBounds(match, events);
    assert.equal(outcome, 'GOAL');
    assert.equal(match.teamLeft.score, 1);
    assert.equal(match.activeSignSprite, 'gol');
    assert.ok(goalEmitted);
  }

  // 2. Rebote contra el poste vertical Oeste
  {
    const match = createSampleMatch();
    const events = new EventBus();
    let paloPlayed = false;
    events.on('sound:play', (p) => {
      if (p.key === 'palo') paloPlayed = true;
    });
    match.ball.prevPos = vec3(-FIELD.halfWidth + 12, 20, -FIELD.goalHalfZ);
    match.ball.pos = vec3(-FIELD.halfWidth + 3, 20, -FIELD.goalHalfZ);
    match.ball.vel = vec3(-300, 0, 0);
    const outcome = checkGoalAndBounds(match, events);
    assert.equal(outcome, 'POST_HIT');
    assert.ok(match.ball.vel.x > 0, 'Debe rebotar hacia adentro del campo');
    assert.ok(paloPlayed, 'Debe emitir el sonido palo al golpear el poste');
  }

  // 3. Lateral Norte
  {
    const match = createSampleMatch();
    match.ball.lastTouchTeamSide = 1;
    match.ball.prevPos = vec3(100, 0, -FIELD.halfDepth + 4);
    match.ball.pos = vec3(100, 0, -FIELD.halfDepth - 6);
    const outcome = checkGoalAndBounds(match);
    assert.equal(outcome, 'OUT_OF_BOUNDS');
    assert.equal(match.setPiece.type, 'THROW_IN_NORTH');
    assert.equal(match.setPiece.teamSide, -1);
  }

  // 4. Córner vs Saque de arco en línea Este
  {
    const match = createSampleMatch();
    match.ball.lastTouchTeamSide = -1; // último toque del defensor
    match.ball.prevPos = vec3(FIELD.halfWidth - 5, 10, 300);
    match.ball.pos = vec3(FIELD.halfWidth + 8, 10, 300);
    assert.equal(checkGoalAndBounds(match), 'OUT_OF_BOUNDS');
    assert.equal(match.setPiece.type, 'CORNER_EAST');
    assert.equal(match.setPiece.teamSide, 1);

    const match2 = createSampleMatch();
    match2.ball.lastTouchTeamSide = 1; // último toque del atacante
    match2.ball.prevPos = vec3(FIELD.halfWidth - 5, 10, 300);
    match2.ball.pos = vec3(FIELD.halfWidth + 8, 10, 300);
    assert.equal(checkGoalAndBounds(match2), 'OUT_OF_BOUNDS');
    assert.equal(match2.setPiece.type, 'GOAL_KICK_EAST');
    assert.equal(match2.setPiece.teamSide, -1);
  }

  // 5. Posicionamiento de formaciones 442, 433, 352
  for (const formation of ['442', '433', '352'] as const) {
    const teamL = { ...teamsData.teams[0], formation };
    const teamR = { ...teamsData.teams[1], formation };
    const match = createMatchSessionState({
      mode: 'CPUvsCPU',
      leftTeam: teamL,
      rightTeam: teamR,
      leftControl: 'CPU',
      rightControl: 'CPU',
      durationIndex: 0,
    });
    setupSetPiecePositions(match, formationsData);
    const players = getAllMatchPlayers(match);
    assert.equal(players.length, 22);
    for (const p of players) {
      assert.ok(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z));
      assert.ok(Math.abs(p.pos.x) <= FIELD.playerLimitX);
      assert.ok(Math.abs(p.pos.z) <= FIELD.playerLimitZ);
    }
  }
}

function runDeterministic300Ticks(seed: number) {
  const input = new InputManager();
  const events = new EventBus();
  const rng = new DeterministicRNG(seed);
  const match = createSampleMatch();
  const sim = new MatchSimulation({
    formationsData,
    rng,
    input,
    events,
    speedIndex: 2, // Normal 1.0x
  });
  sim.initializeKickOff(match);

  // Adelantar patada de inicio y simular 300 ticks (10 segundos a 30Hz)
  for (let tick = 0; tick < 300; tick += 1) {
    input.advanceStep(FIXED_DT);
    if (tick === 45) {
      kickBallDirect(
        match.ball,
        getAllMatchPlayers(match),
        match.teamLeft.players[9],
        1,
        0.2,
        420,
        140,
      );
    }
    sim.step(match, FIXED_DT);

    assert.ok(
      Number.isFinite(match.ball.pos.x) &&
        Number.isFinite(match.ball.pos.y) &&
        Number.isFinite(match.ball.pos.z),
      `Posición inválida del balón en tick ${tick}`,
    );
    for (const p of getAllMatchPlayers(match)) {
      assert.ok(
        Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z),
        `Posición inválida en jugador ${p.uid} tick ${tick}`,
      );
    }
  }
  return {
    ballX: match.ball.pos.x,
    ballZ: match.ball.pos.z,
    leftScore: match.teamLeft.score,
    rightScore: match.teamRight.score,
    elapsed: match.elapsedSeconds,
  };
}

function testDeterministicMatchSimulation(): void {
  const runA = runDeterministic300Ticks(77777);
  const runB = runDeterministic300Ticks(77777);
  assert.deepEqual(runA, runB, 'La simulación a 30Hz con RNG fijo debe ser 100% determinista');
  assert.ok(runA.elapsed > 0, 'El reloj del partido debe avanzar');
}

function testAiMovementStability(): void {
  const input = new InputManager();
  const events = new EventBus();
  const rng = new DeterministicRNG(5);
  const match = createMatchSessionState({
    mode: 'CPUvsCPU',
    leftTeam: { ...teamsData.teams[0], formation: '442' as const },
    rightTeam: { ...teamsData.teams[1], formation: '433' as const },
    leftControl: 'CPU',
    rightControl: 'CPU',
    durationIndex: 1,
  });
  const sim = new MatchSimulation({
    formationsData,
    rng,
    input,
    events,
    speedIndex: 2,
  });
  sim.initializeKickOff(match);

  const players = getAllMatchPlayers(match);
  const prevSign = new Map<string, number>();
  const prevFace = new Map<string, FacingDirection>();
  const prevVel = new Map<string, { x: number; z: number; state: PlayerActionState }>();
  let velReversals = 0;
  let facingEwFlips = 0;
  let playTicks = 0;
  let maxDeltaSpeed = 0;
  const maxAllowedDelta = (PLAYER_PHYSICS.driveAcc + PLAYER_PHYSICS.groundFriction) * FIXED_DT + 15;

  for (let tick = 0; tick < 1800; tick += 1) {
    input.advanceStep(FIXED_DT);
    const wasPlaying = match.subState === MATCH_SUB_STATE.PLAYING;
    sim.step(match, FIXED_DT);
    if (match.subState !== MATCH_SUB_STATE.PLAYING) {
      prevVel.clear();
      continue;
    }
    playTicks += 1;

    for (const p of players) {
      const sign = Math.sign(Math.round(p.vel.x / 10));
      const lastSign = prevSign.get(p.uid) ?? 0;
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) {
        velReversals += 1;
      }
      if (sign !== 0) {
        prevSign.set(p.uid, sign);
      }

      const lastFace = prevFace.get(p.uid);
      if (
        lastFace !== undefined &&
        ((p.facingDir === 2 && lastFace === 6) || (p.facingDir === 6 && lastFace === 2))
      ) {
        facingEwFlips += 1;
      }
      prevFace.set(p.uid, p.facingDir);

      const pv = prevVel.get(p.uid);
      const isNormalMotion = p.actionState === 'run' || p.actionState === 'idle';
      if (wasPlaying && pv && isNormalMotion && (pv.state === 'run' || pv.state === 'idle')) {
        const dv = Math.hypot(p.vel.x - pv.x, p.vel.z - pv.z);
        if (dv > maxDeltaSpeed) maxDeltaSpeed = dv;
        assert.ok(
          dv <= maxAllowedDelta,
          `Cambio brusco de velocidad (${dv.toFixed(1)} > ${maxAllowedDelta.toFixed(1)}) en ${p.uid}`,
        );
      }
      prevVel.set(p.uid, { x: p.vel.x, z: p.vel.z, state: p.actionState });
    }
  }

  assert.ok(playTicks > 600, 'Debe simular suficientes ticks en estado PLAYING');
  const playSeconds = playTicks / 30;
  const reversalsPerPlayerPerSec = velReversals / players.length / playSeconds;
  const ewFlipsPerPlayerPerSec = facingEwFlips / players.length / playSeconds;

  assert.ok(
    reversalsPerPlayerPerSec < 0.35,
    `Demasiadas inversiones de vel.x: ${reversalsPerPlayerPerSec.toFixed(2)}/jug/s`,
  );
  assert.ok(
    ewFlipsPerPlayerPerSec < 0.35,
    `Demasiados giros Este<->Oeste: ${ewFlipsPerPlayerPerSec.toFixed(2)}/jug/s`,
  );
}

function testBallPickupAndGkDive(): void {
  const events = new EventBus();
  const rng = new DeterministicRNG(42);
  const match = createMatchSessionState({
    mode: '1PvsCPU',
    leftTeam: { ...teamsData.teams[0], formation: '442' as const },
    rightTeam: { ...teamsData.teams[1], formation: '433' as const },
    leftControl: 'P1_SOLO',
    rightControl: 'CPU',
    durationIndex: 1,
  });

  const players = getAllMatchPlayers(match);
  // 1. Recepción limpia de pase moderado mientras el jugador corre hacia el balón
  const receiver = match.teamLeft.players[9];
  receiver.pos = vec3(120, 0, 120);
  receiver.vel = vec3(-80, 0, 0);
  receiver.hasBall = false;
  match.ball.ownerPlayerId = null;
  match.ball.immunityTimer = 0;
  match.ball.lastTouchTeamSide = 1;
  match.ball.pos = vec3(98, 0, 120);
  match.ball.prevPos = vec3(88, 0, 120);
  match.ball.vel = vec3(280, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    updateBallPhysics(match.ball, players, FIXED_DT, events);
    resolveBallPlayerInteractions(match.ball, players, events);
    if (match.ball.ownerPlayerId === receiver.uid) break;
  }
  assert.equal(
    match.ball.ownerPlayerId,
    receiver.uid,
    'El jugador debe controlar un pase moderado en carrera sin rebotarlo',
  );

  // 2. Disputa directa cuerpo a cuerpo al encimar balón del rival
  const challenger = match.teamRight.players[5];
  challenger.actionState = 'run';
  challenger.pos = vec3(receiver.pos.x + 16, 0, receiver.pos.z);
  match.ball.immunityTimer = 0;
  updateBallPhysics(match.ball, players, FIXED_DT, events);
  resolveBallPlayerInteractions(match.ball, players, events);
  assert.equal(
    match.ball.ownerPlayerId,
    challenger.uid,
    'El rival que encima la pelota debe poder disputarla con los pies',
  );

  // 3. Salto / estirada real del golero con animación 100/102/104 y altura
  const gk = match.teamRight.players[0];
  gk.pos = vec3(FIELD.halfWidth - 34, 0, 0);
  gk.vel = vec3(0, 0, 0);
  gk.actionState = 'gkStand';
  match.ball.ownerPlayerId = null;
  match.ball.immunityTimer = 0;
  match.ball.pos = vec3(FIELD.halfWidth - 260, 12, 20);
  match.ball.prevPos = vec3(FIELD.halfWidth - 280, 12, 20);
  match.ball.vel = vec3(800, 120, 60);

  let enteredGkJump = false;
  let maxGkY = 0;
  let gkJumpAnim = 0;
  for (let i = 0; i < 16; i += 1) {
    updateGoalkeeperAI(gk, match.teamRight, match.ball, players, rng, FIXED_DT, events);
    integrateKinematic3D(gk, FIXED_DT);
    updatePlayerAnimation(gk, false, FIXED_DT, events);
    if ((gk.actionState as PlayerActionState) === 'gkJump') {
      enteredGkJump = true;
      gkJumpAnim = gk.animId;
    }
    if (gk.pos.y > maxGkY) maxGkY = gk.pos.y;
  }
  assert.ok(enteredGkJump, 'El golero debe iniciar estirada gkJump ante disparo entrante');
  assert.ok(
    gkJumpAnim === 100 || gkJumpAnim === 102 || gkJumpAnim === 104,
    `Animación de salto del golero debe ser 100/102/104 (obtenida ${gkJumpAnim})`,
  );
  assert.ok(maxGkY > 25, `El salto del golero debe elevarse en Y (obtenido ${maxGkY.toFixed(1)})`);

  // 4. Red sin atrapamiento falso: gol potente rebota y sale del arco; gol suave queda dentro
  const hardGoalBall = createBallEntity();
  hardGoalBall.pos = vec3(FIELD.halfWidth + 20, 18, 0);
  hardGoalBall.prevPos = vec3(FIELD.halfWidth - 10, 18, 0);
  hardGoalBall.vel = vec3(920, 30, 0);
  let hardExitedGoal = false;
  for (let i = 0; i < 65; i += 1) {
    updateBallPhysics(hardGoalBall, [], FIXED_DT, events);
    resolveGoalStructureCollisions(hardGoalBall, [], events);
    if (hardGoalBall.vel.x < 0 && hardGoalBall.pos.x < FIELD.halfWidth) {
      hardExitedGoal = true;
      break;
    }
  }
  assert.ok(hardExitedGoal, 'Un gol potente debe rebotar en la red trasera y poder salir del arco');

  const softGoalBall = createBallEntity();
  softGoalBall.pos = vec3(FIELD.halfWidth + 10, 8, 0);
  softGoalBall.prevPos = vec3(FIELD.halfWidth - 2, 8, 0);
  softGoalBall.vel = vec3(210, 0, 0);
  for (let i = 0; i < 90; i += 1) {
    updateBallPhysics(softGoalBall, [], FIXED_DT, events);
    resolveGoalStructureCollisions(softGoalBall, [], events);
  }
  assert.ok(
    softGoalBall.pos.x >= FIELD.halfWidth,
    `Un gol suave debe quedar dentro del arco (x=${softGoalBall.pos.x.toFixed(1)})`,
  );
}

class StubInputReader implements InputReader {
  public direction: ProfileDirection = { x: 0, z: 0 };
  public passJustPressed = false;
  public passIsDown = false;
  public shotJustPressed = false;

  public getDirection(_profile: InputProfile): ProfileDirection {
    return this.direction;
  }

  public getAction(_profile: InputProfile, action: SemanticAction): ActionStateSnapshot {
    const justPressed =
      (action === 'pass' && this.passJustPressed) || (action === 'shot' && this.shotJustPressed);
    const isDown = justPressed || (action === 'pass' && this.passIsDown);
    return {
      isDown,
      justPressed,
      justReleased: false,
      holdDuration: 0,
    };
  }
}

function testThrowInBehavior(): void {
  const input = new StubInputReader();
  const events = new EventBus();
  const soundKeys: string[] = [];
  events.on('sound:play', (payload) => soundKeys.push(payload.key));

  const sim = new MatchSimulation({
    formationsData,
    rng: new DeterministicRNG(2026),
    input,
    events,
    speedIndex: 2,
  });

  // 1. Saque lateral norte (P1 humano) con aim hacia afuera (-z): debe contenerse hacia +z
  const northMatch = createMatchSessionState({
    mode: '1PvsCPU',
    leftTeam: { ...teamsData.teams[0], formation: '442' as const },
    rightTeam: { ...teamsData.teams[1], formation: '433' as const },
    leftControl: 'P1_SOLO',
    rightControl: 'CPU',
    durationIndex: 1,
  });
  northMatch.subState = MATCH_SUB_STATE.PRE_SET_PIECE;
  northMatch.setPiece = {
    type: 'THROW_IN_NORTH',
    teamSide: 1,
    ballPos: vec3(120, 0, -FIELD.halfDepth),
    signSprite: 'lateral',
  };
  setupSetPiecePositions(northMatch, formationsData);

  const northTaker = northMatch.teamLeft.players[northMatch.teamLeft.activePlayerIndex];
  assert.ok(northTaker, 'Debe existir un ejecutor para THROW_IN_NORTH');
  assert.equal(northTaker.actionState, 'throwInHold');
  assert.equal(northTaker.facingDir, 0);
  assert.equal(northTaker.animId, 50);
  assert.equal(northMatch.ball.pos.y, ACTION_CONFIG.throwInCarryHeight);
  assert.equal(northMatch.ball.pos.z, northTaker.pos.z + ACTION_CONFIG.throwInHoldOffset);

  input.direction = { x: 1, z: -1 };
  input.passJustPressed = true;
  sim.step(northMatch, FIXED_DT);
  input.passJustPressed = false;

  assert.equal(
    northMatch.subState,
    MATCH_SUB_STATE.PRE_SET_PIECE,
    'Durante la ventana corta de windup el lateral sigue en PRE_SET_PIECE',
  );
  assert.equal(northTaker.actionState, 'throwIn');
  assert.equal(northTaker.animId, 54);
  assert.equal(northMatch.ball.pos.y, ACTION_CONFIG.throwInCarryHeight);
  assert.equal(northMatch.ball.pos.z, northTaker.pos.z + ACTION_CONFIG.throwInReleaseOffset);

  // Tick 2 (~0.033s < 0.05s): sigue en windup
  sim.step(northMatch, FIXED_DT);
  assert.equal(northMatch.subState, MATCH_SUB_STATE.PRE_SET_PIECE);

  // Tick 3 (~0.067s >= 0.05s): libera el balón hacia adentro sin sonido 'kick'
  sim.step(northMatch, FIXED_DT);
  assert.equal(northMatch.subState, MATCH_SUB_STATE.PLAYING);
  assert.ok(
    northMatch.ball.vel.z > 0,
    `THROW_IN_NORTH debe lanzar hacia +z aun con aim afuera (vel.z=${northMatch.ball.vel.z})`,
  );
  assert.ok(
    northMatch.ball.pos.z > -FIELD.halfDepth,
    `El balón debe entrar al campo en THROW_IN_NORTH (pos.z=${northMatch.ball.pos.z})`,
  );
  assert.ok(
    Math.hypot(northMatch.ball.vel.x, northMatch.ball.vel.z) <= ACTION_CONFIG.throwInMaxSpeed + 2,
    'La velocidad horizontal del lateral no debe superar throwInMaxSpeed',
  );
  assert.ok(!soundKeys.includes('kick'), 'El saque lateral no debe emitir sonido kick');
  assert.equal(
    northTaker.actionState,
    'throwIn',
    'El ejecutor debe mantener brevemente el follow-through throwIn tras soltar',
  );

  for (let i = 0; i < 25; i += 1) {
    sim.step(northMatch, FIXED_DT);
  }
  assert.notEqual(
    northTaker.actionState,
    'throwIn',
    'Tras 0.75s de duración total, el ejecutor debe salir del estado throwIn',
  );

  // 2. Saque lateral sur (P1 humano) con aim neutral: pose 52 -> 56 y lanzamiento hacia -z
  soundKeys.length = 0;
  const southMatch = createMatchSessionState({
    mode: '1PvsCPU',
    leftTeam: { ...teamsData.teams[0], formation: '442' as const },
    rightTeam: { ...teamsData.teams[1], formation: '433' as const },
    leftControl: 'P1_SOLO',
    rightControl: 'CPU',
    durationIndex: 1,
  });
  southMatch.subState = MATCH_SUB_STATE.PRE_SET_PIECE;
  southMatch.setPiece = {
    type: 'THROW_IN_SOUTH',
    teamSide: 1,
    ballPos: vec3(-80, 0, FIELD.halfDepth),
    signSprite: 'lateral',
  };
  setupSetPiecePositions(southMatch, formationsData);

  const southTaker = southMatch.teamLeft.players[southMatch.teamLeft.activePlayerIndex];
  assert.ok(southTaker, 'Debe existir un ejecutor para THROW_IN_SOUTH');
  assert.equal(southTaker.actionState, 'throwInHold');
  assert.equal(southTaker.facingDir, 4);
  assert.equal(southTaker.animId, 52);
  assert.equal(southMatch.ball.pos.z, southTaker.pos.z - ACTION_CONFIG.throwInHoldOffset);

  input.direction = { x: 0, z: 0 };
  input.passJustPressed = true;
  sim.step(southMatch, FIXED_DT);
  input.passJustPressed = false;
  assert.equal(southTaker.actionState, 'throwIn');
  assert.equal(southTaker.animId, 56);
  assert.equal(southMatch.ball.pos.z, southTaker.pos.z - ACTION_CONFIG.throwInReleaseOffset);

  sim.step(southMatch, FIXED_DT);
  sim.step(southMatch, FIXED_DT);
  assert.equal(southMatch.subState, MATCH_SUB_STATE.PLAYING);
  assert.ok(southMatch.ball.vel.z < 0, 'THROW_IN_SOUTH debe lanzar hacia -z');
  assert.ok(southMatch.ball.pos.z < FIELD.halfDepth);
  assert.ok(!soundKeys.includes('kick'));

  // 3. Auto-saque CPU tras ~1.5s de espera sin input
  soundKeys.length = 0;
  const cpuMatch = createMatchSessionState({
    mode: 'CPUvsCPU',
    leftTeam: { ...teamsData.teams[0], formation: '442' as const },
    rightTeam: { ...teamsData.teams[1], formation: '433' as const },
    leftControl: 'CPU',
    rightControl: 'CPU',
    durationIndex: 1,
  });
  cpuMatch.subState = MATCH_SUB_STATE.PRE_SET_PIECE;
  cpuMatch.setPiece = {
    type: 'THROW_IN_NORTH',
    teamSide: 1,
    ballPos: vec3(40, 0, -FIELD.halfDepth),
    signSprite: 'lateral',
  };
  setupSetPiecePositions(cpuMatch, formationsData);

  for (let i = 0; i < 44; i += 1) {
    sim.step(cpuMatch, FIXED_DT);
  }
  assert.equal(
    cpuMatch.subState,
    MATCH_SUB_STATE.PRE_SET_PIECE,
    'CPU debe esperar ~1.5s en throwInHold antes de ejecutar',
  );

  for (let i = 0; i < 8; i += 1) {
    sim.step(cpuMatch, FIXED_DT);
  }
  assert.equal(cpuMatch.subState, MATCH_SUB_STATE.PLAYING, 'CPU debe ejecutar automáticamente');
  assert.ok(cpuMatch.ball.vel.z > 0, 'El auto-saque CPU norte debe lanzar hacia adentro (+z)');
  assert.ok(!soundKeys.includes('kick'));
}

function testHeaderMechanics(): void {
  // 1. Pase alto humano supera headerMinY para habilitar cabezazos
  {
    const input = new StubInputReader();
    const events = new EventBus();
    const sim = new MatchSimulation({
      formationsData,
      rng: new DeterministicRNG(111),
      input,
      events,
      speedIndex: 2,
    });
    const match = createMatchSessionState({
      mode: '1PvsCPU',
      leftTeam: { ...teamsData.teams[0], formation: '442' as const },
      rightTeam: { ...teamsData.teams[1], formation: '433' as const },
      leftControl: 'P1_SOLO',
      rightControl: 'CPU',
      durationIndex: 1,
    });
    setupSetPiecePositions(match, formationsData);
    match.subState = MATCH_SUB_STATE.PLAYING;

    const passer = match.teamLeft.players[9];
    const mate = match.teamLeft.players[10];
    passer.pos = vec3(100, 0, 120);
    mate.pos = vec3(320, 0, -40);
    passer.hasBall = true;
    match.ball.ownerPlayerId = passer.uid;
    match.teamLeft.activePlayerIndex = passer.indexInTeam;

    input.direction = { x: 1, z: -0.7 };
    input.passIsDown = true;
    for (let i = 0; i < 8; i += 1) {
      sim.step(match, FIXED_DT);
    }
    input.passIsDown = false;
    sim.step(match, FIXED_DT);

    let peakY = 0;
    for (let i = 0; i < 30; i += 1) {
      sim.step(match, FIXED_DT);
      peakY = Math.max(peakY, match.ball.pos.y);
    }
    assert.ok(
      peakY >= ACTION_CONFIG.headerMinY,
      `Un pase alto debe superar headerMinY (${ACTION_CONFIG.headerMinY}), obtuvo peakY=${peakY.toFixed(1)}`,
    );
  }

  // 2. Cabezazo humano de remate al arco (shot) y aterrizaje limpio
  {
    const input = new StubInputReader();
    const events = new EventBus();
    const soundKeys: string[] = [];
    events.on('sound:play', (p) => soundKeys.push(p.key));

    const sim = new MatchSimulation({
      formationsData,
      rng: new DeterministicRNG(222),
      input,
      events,
      speedIndex: 2,
    });
    const match = createMatchSessionState({
      mode: '1PvsCPU',
      leftTeam: { ...teamsData.teams[0], formation: '442' as const },
      rightTeam: { ...teamsData.teams[1], formation: '433' as const },
      leftControl: 'P1_SOLO',
      rightControl: 'CPU',
      durationIndex: 1,
    });
    setupSetPiecePositions(match, formationsData);
    match.subState = MATCH_SUB_STATE.PLAYING;

    const striker = match.teamLeft.players[9];
    striker.pos = vec3(FIELD.halfWidth * 0.65, 0, 10);
    striker.vel = vec3(0, 0, 0);
    match.teamLeft.activePlayerIndex = striker.indexInTeam;
    match.teamLeft.nearestPlayerIndex = striker.indexInTeam;

    match.ball.ownerPlayerId = null;
    match.ball.immunityTimer = 0;
    match.ball.pos = vec3(striker.pos.x + 28, 72, 10);
    match.ball.prevPos = vec3(striker.pos.x + 30, 76, 10);
    match.ball.vel = vec3(-80, -40, 0);
    updateBallFallingPos(match.ball);

    input.shotJustPressed = true;
    sim.step(match, FIXED_DT);
    input.shotJustPressed = false;

    assert.equal(striker.actionState, 'headerPrep', 'Debe iniciar headerPrep ante balón aéreo');
    assert.ok(
      striker.animId === 80 || striker.animId === 82,
      `Animación de cabezazo esperada (80/82), obtuvo ${striker.animId}`,
    );

    let sawHeaderHit = false;
    for (let i = 0; i < 30; i += 1) {
      sim.step(match, FIXED_DT);
      if ((striker.actionState as string) === 'header') {
        sawHeaderHit = true;
      }
    }
    assert.ok(sawHeaderHit, 'El cabezazo debe impactar el balón y pasar a estado header');
    assert.ok(match.ball.vel.x > 300, 'El cabezazo en área rival debe salir potente hacia el arco');
    assert.ok(soundKeys.includes('powerKick'), 'Súper cabezazo en área rival debe sonar powerKick');
    assert.equal(striker.pos.y, 0, 'El jugador debe aterrizar limpio en y=0 tras cabecear');
    assert.equal(striker.actionState, 'idle', 'Tras aterrizar debe volver a idle');
  }

  // 3. Cabezazo humano de pase (pass) no cambia de jugador y pasa al compañero
  {
    const input = new StubInputReader();
    const events = new EventBus();
    const sim = new MatchSimulation({
      formationsData,
      rng: new DeterministicRNG(333),
      input,
      events,
      speedIndex: 2,
    });
    const match = createMatchSessionState({
      mode: '1PvsCPU',
      leftTeam: { ...teamsData.teams[0], formation: '442' as const },
      rightTeam: { ...teamsData.teams[1], formation: '433' as const },
      leftControl: 'P1_SOLO',
      rightControl: 'CPU',
      durationIndex: 1,
    });
    setupSetPiecePositions(match, formationsData);
    match.subState = MATCH_SUB_STATE.PLAYING;

    const mid = match.teamLeft.players[6];
    const targetMate = match.teamLeft.players[9];
    const closerMate = match.teamLeft.players[7];
    mid.pos = vec3(120, 0, 0);
    mid.facingDir = 2;
    targetMate.pos = vec3(340, 0, 20);
    closerMate.pos = vec3(150, 0, 12);
    match.teamLeft.activePlayerIndex = mid.indexInTeam;

    match.ball.ownerPlayerId = null;
    match.ball.immunityTimer = 0;
    match.ball.pos = vec3(145, 68, 0);
    match.ball.prevPos = vec3(147, 72, 0);
    match.ball.vel = vec3(-60, -30, 0);
    updateBallFallingPos(match.ball);

    input.passJustPressed = true;
    sim.step(match, FIXED_DT);
    input.passJustPressed = false;

    assert.equal(
      match.teamLeft.activePlayerIndex,
      mid.indexInTeam,
      'Con balón aéreo al alcance, pass no debe cambiar de jugador',
    );
    assert.equal(mid.actionState, 'headerPrep');
    assert.equal(mid.headerIntent, 'pass');

    let passed = false;
    for (let i = 0; i < 20; i += 1) {
      sim.step(match, FIXED_DT);
      if ((mid.actionState as string) === 'header') passed = true;
    }
    assert.ok(passed, 'El pase de cabeza debe conectar el balón');
  }

  // 4. Cabezazo de IA en balón aéreo dentro de rango
  {
    const rng = new DeterministicRNG(444);
    const events = new EventBus();
    const match = createSampleMatch();
    setupSetPiecePositions(match, formationsData);
    const players = getAllMatchPlayers(match);
    const aiPlayer = match.teamRight.players[9];
    aiPlayer.pos = vec3(300, 0, 0);
    aiPlayer.vel = vec3(0, 0, 0);
    match.ball.ownerPlayerId = null;
    match.ball.immunityTimer = 0;
    match.ball.pos = vec3(250, 68, 0);
    match.ball.vel = vec3(90, -25, 0);
    updateBallFallingPos(match.ball);

    updateFieldPlayerAI(
      aiPlayer,
      match.teamRight,
      match.teamLeft,
      match.ball,
      players,
      true,
      rng,
      FIXED_DT,
      events,
    );
    assert.equal(
      aiPlayer.actionState,
      'headerPrep',
      'La IA debe iniciar headerPrep ante balón aéreo cercano',
    );
  }
}

function main(): void {
  testTrapezoidalPerspective();
  testKinematicsAndBallBounce();
  testGoalPostsAndSetPieces();
  testDeterministicMatchSimulation();
  testAiMovementStability();
  testBallPickupAndGkDive();
  testThrowInBehavior();
  testHeaderMechanics();
  console.log(
    'verifySimulation OK: todas las pruebas de física, proyección, reglas y estabilidad de IA pasaron.',
  );
}

main();
