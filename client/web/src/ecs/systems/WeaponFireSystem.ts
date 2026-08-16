import type { EcsSystem } from "../world";
import { resolvePredictionStatusModifiers } from "../statusEffectModifiers";

export class WeaponFireSystem implements EcsSystem {
  readonly name = "WeaponFireSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    if (!ctx.command?.fire) return;
    if (resolvePredictionStatusModifiers(world, ctx.localPlayerId).stunned) return;

    const weapon = world.weapons.get(ctx.localPlayerId);
    if (!weapon) return;
    if (weapon.reloading) return;

    const readyAt = weapon.lastFiredAtMs + weapon.cooldownMs;
    if (ctx.nowMs < readyAt || weapon.ammo === 0) return;

    weapon.lastFiredAtMs = ctx.nowMs;
    if (weapon.ammo > 0) weapon.ammo -= 1;
  }
}
