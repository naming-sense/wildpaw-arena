import type { EcsSystem } from "../world";

export class CollisionSystem implements EcsSystem {
  readonly name = "CollisionSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    for (const transform of world.transforms.values()) {
      transform.x = Math.max(ctx.worldBounds.min, Math.min(ctx.worldBounds.max, transform.x));
      transform.z = Math.max(ctx.worldBounds.min, Math.min(ctx.worldBounds.max, transform.z));
      transform.y = Math.max(0, transform.y);
    }
  }
}
