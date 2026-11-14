import { PLAYER_PHYSICS } from '../config/gameConfig';
import type { PlayerData } from '../data/types';
import { type KinematicBody3D, type Vec3, vec3 } from './math3d';

/** Dirección cardinal según offset en `Jugador.fgt`: `0`=Sur, `2`=Este, `4`=Norte, `6`=Oeste. */
export type FacingDirection = 0 | 2 | 4 | 6;

export type PlayerActionState =
  | 'idle'
  | 'run'
  | 'tackle'
  | 'raise'
  | 'kickPrep'
  | 'kick'
  | 'headerPrep'
  | 'header'
  | 'evasion'
  | 'throwIn'
  | 'gkStand'
  | 'gkJump'
  | 'gkHold'
  | 'celebrate';

export interface PlayerEntity extends KinematicBody3D {
  readonly uid: string;
  readonly indexInTeam: number;
  readonly teamSide: 1 | -1;
  readonly isGoalkeeper: boolean;
  readonly data: PlayerData;
  facingDir: FacingDirection;
  actionState: PlayerActionState;
  stateTimer: number;
  hasBall: boolean;
  hasRebounded: boolean;
  isChargingShot: boolean;
  shotChargeTimer: number;
  isChargingPass: boolean;
  passChargeTimer: number;
  aimOffsetY: -1 | 0 | 1;
  tacticalHome: Vec3;
  isSteering: boolean;
  aiCooldownTimer: number;
  animId: number;
  animStepIndex: number;
  animTick: number;
  stepSoundTimer: number;
}

export function createPlayerEntity(
  uid: string,
  indexInTeam: number,
  teamSide: 1 | -1,
  data: PlayerData,
): PlayerEntity {
  const isGoalkeeper = data.number === 1;
  return {
    uid,
    indexInTeam,
    teamSide,
    isGoalkeeper,
    data,
    pos: vec3(0, 0, 0),
    vel: vec3(0, 0, 0),
    baseAcc: vec3(0, 0, 0),
    dirAcc: vec3(0, 0, 0),
    driveAccMag: PLAYER_PHYSICS.driveAcc,
    maxSpeed: PLAYER_PHYSICS.maxSpeed * data.speed,
    linearFriction: PLAYER_PHYSICS.groundFriction,
    facingDir: teamSide === 1 ? 2 : 6,
    actionState: isGoalkeeper ? 'gkStand' : 'idle',
    stateTimer: 0,
    hasBall: false,
    hasRebounded: false,
    isChargingShot: false,
    shotChargeTimer: 0,
    isChargingPass: false,
    passChargeTimer: 0,
    aimOffsetY: 0,
    tacticalHome: vec3(0, 0, 0),
    isSteering: false,
    aiCooldownTimer: 0,
    animId: isGoalkeeper ? 320 : teamSide === 1 ? 22 : 26,
    animStepIndex: 0,
    animTick: 0,
    stepSoundTimer: 0,
  };
}

export function facingVector(dir: FacingDirection): { readonly x: number; readonly z: number } {
  switch (dir) {
    case 0:
      return { x: 0, z: 1 };
    case 2:
      return { x: 1, z: 0 };
    case 4:
      return { x: 0, z: -1 };
    case 6:
      return { x: -1, z: 0 };
  }
}

export function vectorToFacingDirection(
  x: number,
  z: number,
  fallback: FacingDirection,
): FacingDirection {
  if (Math.abs(x) < 1e-3 && Math.abs(z) < 1e-3) {
    return fallback;
  }
  if (Math.abs(x) >= Math.abs(z)) {
    return x >= 0 ? 2 : 6;
  }
  return z >= 0 ? 0 : 4;
}
