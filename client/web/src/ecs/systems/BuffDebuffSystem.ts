import type { EcsSystem } from "../world";

export class BuffDebuffSystem implements EcsSystem {
  readonly name = "BuffDebuffSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    for (const [entityId, effects] of world.statusEffects) {
      for (const effect of effects) {
        effect.remainingMs = Math.max(0, effect.remainingMs - ctx.dtMs);
      }

      const activeEffects = effects.filter((effect) => effect.remainingMs > 0);
      if (activeEffects.length !== effects.length) {
        world.statusEffects.set(entityId, activeEffects);
      }
    }
  }
}
