import type { EcsSystem } from "../world";

export class WeaponFireSystem implements EcsSystem {
  readonly name = "WeaponFireSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    if (!ctx.command?.fire) return;

    const weapon = world.weapons.get(ctx.localPlayerId);
    if (!weapon) return;

    const readyAt = weapon.lastFiredAtMs + weapon.cooldownMs;
    if (ctx.nowMs < readyAt || weapon.ammo === 0) return;

    weapon.lastFiredAtMs = ctx.nowMs;
    if (weapon.ammo > 0) weapon.ammo -= 1;
  }
}
