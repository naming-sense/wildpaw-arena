import type { EcsSystem } from "../world";

export class RenderSyncSystem implements EcsSystem {
  readonly name = "RenderSyncSystem";

  update(world: import("../world").World): void {
    for (const [entityId, transform] of world.transforms) {
      const proxy = world.renderProxies.get(entityId);
      if (!proxy) continue;
      proxy.object3d.position.set(transform.x, transform.y, transform.z);
      proxy.object3d.rotation.y = transform.yaw;
    }
  }
}
