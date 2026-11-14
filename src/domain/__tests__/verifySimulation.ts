import assert from 'node:assert/strict';
import {
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
import { InputManager } from '../../input/InputManager';
import { kickBallDirect, updateBallFallingPos, updateBallPhysics } from '../BallPhysics';
import { resolveBallPlayerInteractions } from '../Collisions';
import { MatchSimulation } from '../MatchSimulation';
import {
  checkGoalAndBounds,
  resolveGoalStructureCollisions,
  setupSetPiecePositions,
} from '../RulesEngine';
import { updateGoalkeeperAI, updatePlayerAnimation } from '../TacticalAI';

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

function main(): void {
  testTrapezoidalPerspective();
  testKinematicsAndBallBounce();
  testGoalPostsAndSetPieces();
  testDeterministicMatchSimulation();
  testAiMovementStability();
  testBallPickupAndGkDive();
  console.log(
    'verifySimulation OK: todas las pruebas de física, proyección, reglas y estabilidad de IA pasaron.',
  );
}

main();
