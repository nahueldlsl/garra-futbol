import type { TeamData } from '../data/types';
import { createPlayerEntity, type PlayerEntity } from './Player';

export type TeamControlMode = 'CPU' | 'P1_SOLO' | 'P1_2P' | 'P2_2P';

export interface TeamEntity {
  readonly data: TeamData;
  /** `1` = defiende Oeste (-1440), ataca Este (+1440); `-1` = defiende Este (+1440), ataca Oeste (-1440). */
  side: 1 | -1;
  readonly controlMode: TeamControlMode;
  score: number;
  readonly players: PlayerEntity[];
  activePlayerIndex: number;
  nearestPlayerIndex: number;
}

export function createTeamEntity(
  data: TeamData,
  side: 1 | -1,
  controlMode: TeamControlMode,
): TeamEntity {
  const players = data.players.map((playerData, idx) =>
    createPlayerEntity(`${side === 1 ? 'L' : 'R'}_${playerData.number}`, idx, side, playerData),
  );
  return {
    data,
    side,
    controlMode,
    score: 0,
    players,
    activePlayerIndex: Math.min(9, players.length - 1),
    nearestPlayerIndex: Math.min(9, players.length - 1),
  };
}
