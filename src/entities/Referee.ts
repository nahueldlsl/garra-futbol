import type { Vec3 } from './math3d';

/**
 * Estados internos del partido en `SoccerField + 0x129c` (SPECS.md §1.5).
 */
export type MatchSubState = 1 | 2 | 3 | 4 | 5 | 6;

export const MATCH_SUB_STATE = {
  PLAYING: 1 as MatchSubState,
  STOPPED_WAIT: 2 as MatchSubState,
  PRE_SET_PIECE: 3 as MatchSubState,
  DIALOG_WAIT: 4 as MatchSubState,
  GOAL_CELEBRATION_BANNER: 5 as MatchSubState,
  MATCH_END_DELAY: 6 as MatchSubState,
} as const;

export type SetPieceType =
  | 'KICK_OFF'
  | 'THROW_IN_NORTH'
  | 'THROW_IN_SOUTH'
  | 'CORNER_WEST'
  | 'CORNER_EAST'
  | 'GOAL_KICK_WEST'
  | 'GOAL_KICK_EAST';

export type SignSpriteKey =
  | 'kickOff'
  | 'secondHalf'
  | 'firstTimeEnd'
  | 'endGame'
  | 'gol'
  | 'saquedearco'
  | 'lateral'
  | 'tiroesquina';

export interface SetPieceInfo {
  readonly type: SetPieceType;
  readonly teamSide: 1 | -1;
  readonly ballPos: Vec3;
  readonly signSprite: SignSpriteKey;
}
