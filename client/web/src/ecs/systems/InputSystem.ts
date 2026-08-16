import type { EcsSystem } from "../world";
import { resolvePredictionStatusModifiers } from "../statusEffectModifiers";

export class InputSystem implements EcsSystem {
  readonly name = "InputSystem";

  constructor(private readonly moveSpeed: number) {}

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    const velocity = world.velocities.get(ctx.localPlayerId);
    if (!velocity) return;
    const status = resolvePredictionStatusModifiers(world, ctx.localPlayerId);
    if (status.stunned) {
      velocity.x = 0;
      velocity.z = 0;
      return;
    }
    if (!ctx.command) return;

    let moveX = ctx.command.moveX;
    let moveY = ctx.command.moveY;
    const length = Math.hypot(moveX, moveY);
    if (length > 1) {
      moveX /= length;
      moveY /= length;
    }

    velocity.x = moveX * this.moveSpeed * status.moveSpeedMultiplier;
    velocity.z = moveY * this.moveSpeed * status.moveSpeedMultiplier;
  }
}
