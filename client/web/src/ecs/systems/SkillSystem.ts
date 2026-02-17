import type { EcsSystem } from "../world";

export class SkillSystem implements EcsSystem {
  readonly name = "SkillSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    const skillSet = world.skills.get(ctx.localPlayerId);
    if (!skillSet || !ctx.command) return;

    if (ctx.command.skillQ && ctx.nowMs >= skillSet.qCooldownEndMs) {
      skillSet.qCooldownEndMs = ctx.nowMs + 4000;
    }
    if (ctx.command.skillE && ctx.nowMs >= skillSet.eCooldownEndMs) {
      skillSet.eCooldownEndMs = ctx.nowMs + 6500;
    }
    if (ctx.command.skillR && ctx.nowMs >= skillSet.rCooldownEndMs) {
      skillSet.rCooldownEndMs = ctx.nowMs + 18000;
    }
  }
}
