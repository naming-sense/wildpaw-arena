import { distance, lerpVec2 } from "../../core/math/vec2";
import type { InputCommand, NetworkPlayerState } from "../protocol/schemas";
import { applyCommandPrediction, type PredictedState } from "../prediction/localPrediction";

export function reconcileLocalState(args: {
  authoritative: NetworkPlayerState;
  currentPredicted: PredictedState;
  pendingCommands: InputCommand[];
  dtSeconds: number;
  moveSpeed: number;
  hardSnapThreshold: number;
  smoothCorrectionAlpha: number;
}): PredictedState {
  const {
    authoritative,
    currentPredicted,
    pendingCommands,
    dtSeconds,
    moveSpeed,
    hardSnapThreshold,
    smoothCorrectionAlpha,
  } = args;

  const serverBase: PredictedState = {
    position: { x: authoritative.x, y: authoritative.y },
    velocity: { x: authoritative.vx, y: authoritative.vy },
    lastSeq: authoritative.lastProcessedInputSeq,
  };

  let replayed = serverBase;
  for (const cmd of pendingCommands) {
    if (cmd.seq <= authoritative.lastProcessedInputSeq) continue;
    replayed = applyCommandPrediction(replayed, cmd, dtSeconds, moveSpeed);
  }

  const errorDistance = distance(currentPredicted.position, replayed.position);
  if (errorDistance > hardSnapThreshold) {
    return replayed;
  }

  return {
    position: lerpVec2(currentPredicted.position, replayed.position, smoothCorrectionAlpha),
    velocity: lerpVec2(currentPredicted.velocity, replayed.velocity, smoothCorrectionAlpha),
    lastSeq: replayed.lastSeq,
  };
}
