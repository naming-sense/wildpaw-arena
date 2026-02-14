import type { InputFrame, PlayerSnapshot } from "./types";

const PLAYER_SPEED_MPS = 4;

export interface PredictedPlayerState {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  lastAppliedInputSeq: number;
}

export function applyInput(
  state: PredictedPlayerState,
  input: InputFrame,
  dtSeconds: number,
): PredictedPlayerState {
  const vx = input.moveX * PLAYER_SPEED_MPS;
  const vy = input.moveY * PLAYER_SPEED_MPS;

  return {
    position: {
      x: state.position.x + vx * dtSeconds,
      y: state.position.y + vy * dtSeconds,
    },
    velocity: { x: vx, y: vy },
    lastAppliedInputSeq: input.inputSeq,
  };
}

export function reconcile(
  authoritative: PlayerSnapshot,
  pendingInputs: InputFrame[],
  dtSeconds: number,
): PredictedPlayerState {
  let state: PredictedPlayerState = {
    position: { ...authoritative.position },
    velocity: { ...authoritative.velocity },
    lastAppliedInputSeq: authoritative.lastProcessedInputSeq,
  };

  for (const input of pendingInputs) {
    if (input.inputSeq <= authoritative.lastProcessedInputSeq) {
      continue;
    }
    state = applyInput(state, input, dtSeconds);
  }

  return state;
}
