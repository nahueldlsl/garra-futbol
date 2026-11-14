import { BALL_PHYSICS } from '../config/gameConfig';
import { type KinematicBody3D, type Vec3, vec3 } from './math3d';

export type BallAnimId = 0 | 10 | 20;

export interface BallEntity extends KinematicBody3D {
  prevPos: Vec3;
  originPos: Vec3;
  fallingPos: Vec3;
  ownerPlayerId: string | null;
  lastTouchTeamSide: 1 | -1;
  lastTouchPlayerName: string;
  lastTouchPlayerNumber: number;
  immunityTimer: number;
  restitution: number;
  stopBounceVy: number;
  spinAnimId: BallAnimId;
  animStepIndex: number;
  animTick: number;
}

export function createBallEntity(): BallEntity {
  return {
    pos: vec3(0, 0, 0),
    vel: vec3(0, 0, 0),
    baseAcc: vec3(0, 0, 0),
    dirAcc: vec3(0, 0, 0),
    driveAccMag: 0,
    maxSpeed: 2000,
    linearFriction: BALL_PHYSICS.groundFriction,
    prevPos: vec3(0, 0, 0),
    originPos: vec3(0, 0, 0),
    fallingPos: vec3(0, 0, 0),
    ownerPlayerId: null,
    lastTouchTeamSide: 1,
    lastTouchPlayerName: '',
    lastTouchPlayerNumber: 0,
    immunityTimer: 0,
    restitution: BALL_PHYSICS.restitution,
    stopBounceVy: BALL_PHYSICS.stopBounceVy,
    spinAnimId: 20,
    animStepIndex: 0,
    animTick: 0,
  };
}
