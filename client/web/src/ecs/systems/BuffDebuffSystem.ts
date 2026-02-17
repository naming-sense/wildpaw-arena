import type { EcsSystem } from "../world";

export class BuffDebuffSystem implements EcsSystem {
  readonly name = "BuffDebuffSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    for (const effects of world.statusEffects.values()) {
      for (const effect of effects) {
        effect.remainingMs = Math.max(0, effect.remainingMs - ctx.dtMs);
      }
    }
  }
}
