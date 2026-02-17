import type { EcsSystem } from "../world";

export class MovementSystem implements EcsSystem {
  readonly name = "MovementSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    const dtSeconds = ctx.dtMs / 1000;

    for (const [entityId, transform] of world.transforms) {
      const velocity = world.velocities.get(entityId);
      if (!velocity) continue;

      transform.x += velocity.x * dtSeconds;
      transform.y += velocity.y * dtSeconds;
      transform.z += velocity.z * dtSeconds;
      if (velocity.x !== 0 || velocity.z !== 0) {
        transform.yaw = Math.atan2(velocity.x, velocity.z);
      }
    }
  }
}
