import type { EcsSystem, SimulationContext } from "../world";

export class ProjectileSystem implements EcsSystem {
  readonly name = "ProjectileSystem";

  update(world: import("../world").World, ctx: SimulationContext): void {
    const dtSeconds = ctx.dtMs / 1000;

    for (const [entityId, projectile] of world.projectiles) {
      if (!projectile.active) {
        continue;
      }

      if (ctx.nowMs >= projectile.expiresAtMs) {
        projectile.active = false;
        continue;
      }

      const transform = world.transforms.get(entityId);
      if (!transform) {
        projectile.active = false;
        continue;
      }

      transform.x += projectile.velocityX * dtSeconds;
      transform.z += projectile.velocityZ * dtSeconds;
      if (Math.hypot(projectile.velocityX, projectile.velocityZ) > 0.001) {
        transform.yaw = Math.atan2(projectile.velocityX, projectile.velocityZ);
      }
    }
  }
}
