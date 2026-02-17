import type { Vec2 } from "../../core/math/vec2";
import type { InputCommand } from "../protocol/schemas";

export interface PredictedState {
  position: Vec2;
  velocity: Vec2;
  lastSeq: number;
}

export function applyCommandPrediction(
  state: PredictedState,
  command: InputCommand,
  dtSeconds: number,
  moveSpeed: number,
): PredictedState {
  const vx = command.moveX * moveSpeed;
  const vy = command.moveY * moveSpeed;

  return {
    position: {
      x: state.position.x + vx * dtSeconds,
      y: state.position.y + vy * dtSeconds,
    },
    velocity: { x: vx, y: vy },
    lastSeq: command.seq,
  };
}
