import type { EcsSystem } from "../world";

export class InputSystem implements EcsSystem {
  readonly name = "InputSystem";

  constructor(private readonly moveSpeed: number) {}

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    if (!ctx.command) return;
    const velocity = world.velocities.get(ctx.localPlayerId);
    if (!velocity) return;

    let moveX = ctx.command.moveX;
    let moveY = ctx.command.moveY;
    const length = Math.hypot(moveX, moveY);
    if (length > 1) {
      moveX /= length;
      moveY /= length;
    }

    velocity.x = moveX * this.moveSpeed;
    velocity.z = moveY * this.moveSpeed;
  }
}
