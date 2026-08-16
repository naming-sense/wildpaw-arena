import type { SkillRuntime } from "../components";
import type { EcsSystem, EntityId, SimulationContext, World } from "../world";

export class SkillRuntimeSystem implements EcsSystem {
  readonly name = "SkillRuntimeSystem";

  update(world: World, ctx: SimulationContext): void {
    for (const [ownerEntityId, runtimes] of world.skillRuntimes) {
      const ownerTransform = world.transforms.get(ownerEntityId);
      const activeRuntimes: SkillRuntime[] = [];

      for (const runtime of runtimes) {
        runtime.remainingMs = Math.max(0, runtime.expiresAtMs - ctx.nowMs);
        if (runtime.remainingMs <= 0) {
          continue;
        }

        this.updateRuntime(world, ownerEntityId, runtime, ownerTransform);
        activeRuntimes.push(runtime);
      }

      if (activeRuntimes.length === 0) {
        world.skillRuntimes.delete(ownerEntityId);
      } else if (activeRuntimes.length !== runtimes.length) {
        world.skillRuntimes.set(ownerEntityId, activeRuntimes);
      }
    }
  }

  private updateRuntime(
    world: World,
    ownerEntityId: EntityId,
    runtime: SkillRuntime,
    ownerTransform: import("../components").Transform | undefined,
  ): void {
    switch (runtime.archetype) {
      case "Dash":
        if (!ownerTransform) return;
        runtime.currentX = ownerTransform.x;
        runtime.currentZ = ownerTransform.z;
        runtime.observedTravelM = Math.max(
          runtime.observedTravelM,
          Math.hypot(runtime.currentX - runtime.originX, runtime.currentZ - runtime.originZ),
        );
        if (runtime.observedTravelM > 0.05) {
          runtime.authority = "SnapshotConfirmed";
        }
        return;
      case "Projectile": {
        const elapsedSeconds = Math.max(0, runtime.durationMs - runtime.remainingMs) / 1000;
        const distance = Math.min(runtime.rangeM, elapsedSeconds * runtime.speedMps);
        runtime.currentX = runtime.originX + runtime.directionX * distance;
        runtime.currentZ = runtime.originZ + runtime.directionZ * distance;
        return;
      }
      case "Channel":
      case "Buff":
      case "Rescue":
        if (!ownerTransform) return;
        runtime.currentX = ownerTransform.x;
        runtime.currentZ = ownerTransform.z;
        return;
      case "Shield": {
        if (!ownerTransform) return;
        runtime.currentX = ownerTransform.x;
        runtime.currentZ = ownerTransform.z;
        const health = world.healths.get(ownerEntityId);
        if (health && health.shield > 0) {
          runtime.authority = "SnapshotConfirmed";
        }
        return;
      }
      case "Zone":
        return;
    }
  }
}
