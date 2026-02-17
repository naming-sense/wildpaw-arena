import type { EcsSystem } from "../world";

export class InputSystem implements EcsSystem {
  readonly name = "InputSystem";

  constructor(private readonly moveSpeed: number) {}

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    if (!ctx.command) return;
    const velocity = world.velocities.get(ctx.localPlayerId);
    if (!velocity) return;

    velocity.x = ctx.command.moveX * this.moveSpeed;
    velocity.z = ctx.command.moveY * this.moveSpeed;
  }
}
