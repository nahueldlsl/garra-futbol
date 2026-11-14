import { MATCH_DURATION_MINUTES } from '../config/gameConfig';
import type { TeamData } from '../data/types';
import { type BallEntity, createBallEntity } from './Ball';
import { type Vec3, vec3 } from './math3d';
import type { PlayerEntity } from './Player';
import {
  MATCH_SUB_STATE,
  type MatchSubState,
  type SetPieceInfo,
  type SignSpriteKey,
} from './Referee';
import { createTeamEntity, type TeamControlMode, type TeamEntity } from './Team';

export type MatchMode = '1PvsCPU' | '1Pvs2P' | 'CPUvsCPU' | 'CALCAR_CUP';

export interface MatchCameraState {
  pos: Vec3;
  target: Vec3;
  currentLead: number;
}

export interface MatchSessionState {
  readonly mode: MatchMode;
  readonly cupRound: number;
  teamLeft: TeamEntity;
  teamRight: TeamEntity;
  readonly ball: BallEntity;
  half: 1 | 2;
  halfDurationSeconds: number;
  elapsedSeconds: number;
  isExpired: boolean;
  isHalfEndPending: boolean;
  isGoalPending: boolean;
  subState: MatchSubState;
  stateTimer: number;
  fadeAlpha: number;
  fadeDirection: 'none' | 'out' | 'in';
  fadeCallbackAction: 'none' | 'preSetPiece' | 'matchEnd';
  setPiece: SetPieceInfo;
  activeSignSprite: SignSpriteKey | null;
  activeSignTimer: number;
  lastGoalScorerName: string;
  lastGoalScorerNumber: number;
  lastGoalTeamSide: 1 | -1;
  goalBannerPhase: number;
  paused: boolean;
  matchFinished: boolean;
  camera: MatchCameraState;
}

export function createMatchSessionState(params: {
  readonly mode: MatchMode;
  readonly cupRound?: number;
  readonly leftTeam: TeamData;
  readonly rightTeam: TeamData;
  readonly leftControl: TeamControlMode;
  readonly rightControl: TeamControlMode;
  readonly durationIndex: 0 | 1 | 2 | 3;
}): MatchSessionState {
  const halfDurationSeconds = MATCH_DURATION_MINUTES[params.durationIndex] * 0.5 * 60;
  return {
    mode: params.mode,
    cupRound: params.cupRound ?? 0,
    teamLeft: createTeamEntity(params.leftTeam, 1, params.leftControl),
    teamRight: createTeamEntity(params.rightTeam, -1, params.rightControl),
    ball: createBallEntity(),
    half: 1,
    halfDurationSeconds,
    elapsedSeconds: 0,
    isExpired: false,
    isHalfEndPending: false,
    isGoalPending: false,
    subState: MATCH_SUB_STATE.DIALOG_WAIT,
    stateTimer: 1.5,
    fadeAlpha: 0,
    fadeDirection: 'none',
    fadeCallbackAction: 'none',
    setPiece: {
      type: 'KICK_OFF',
      teamSide: 1,
      ballPos: vec3(0, 0, 0),
      signSprite: 'kickOff',
    },
    activeSignSprite: 'kickOff',
    activeSignTimer: 1.5,
    lastGoalScorerName: '',
    lastGoalScorerNumber: 0,
    lastGoalTeamSide: 1,
    goalBannerPhase: 0,
    paused: false,
    matchFinished: false,
    camera: {
      pos: vec3(0, 0, 0),
      target: vec3(0, 0, 0),
      currentLead: 0,
    },
  };
}

export function getAllMatchPlayers(match: MatchSessionState): readonly PlayerEntity[] {
  return [...match.teamLeft.players, ...match.teamRight.players];
}
