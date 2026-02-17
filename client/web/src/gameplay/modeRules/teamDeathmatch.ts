export interface TeamDeathmatchState {
  teamAScore: number;
  teamBScore: number;
  targetScore: number;
  remainingTimeMs: number;
}

export function createInitialTdmState(): TeamDeathmatchState {
  return {
    teamAScore: 0,
    teamBScore: 0,
    targetScore: 30,
    remainingTimeMs: 180000,
  };
}
