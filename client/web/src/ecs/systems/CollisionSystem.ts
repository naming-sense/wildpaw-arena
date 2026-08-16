import type { EcsSystem } from "../world";

const PLAYER_COLLISION_RADIUS = 0.45;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class CollisionSystem implements EcsSystem {
  readonly name = "CollisionSystem";

  update(world: import("../world").World, ctx: import("../world").SimulationContext): void {
    const boundMinX = typeof ctx.worldBounds.minX === "number" ? ctx.worldBounds.minX : ctx.worldBounds.min;
    const boundMaxX = typeof ctx.worldBounds.maxX === "number" ? ctx.worldBounds.maxX : ctx.worldBounds.max;
    const boundMinZ = typeof ctx.worldBounds.minZ === "number" ? ctx.worldBounds.minZ : ctx.worldBounds.min;
    const boundMaxZ = typeof ctx.worldBounds.maxZ === "number" ? ctx.worldBounds.maxZ : ctx.worldBounds.max;
    const movementColliders = (ctx.staticColliders ?? []).filter((collider) => collider.blocksMovement);

    for (const [entityId, transform] of world.transforms) {
      // 투사체 위치와 충돌 판정은 서버가 확정한다. 클라이언트는 이벤트 사이의
      // 시각 이동만 수행하므로 로컬 지형 보정을 적용하지 않는다.
      if (world.projectiles.has(entityId)) {
        continue;
      }

      transform.x = clamp(transform.x, boundMinX, boundMaxX);
      transform.z = clamp(transform.z, boundMinZ, boundMaxZ);
      transform.y = Math.max(0, transform.y);

      for (const collider of movementColliders) {
        const minX = collider.minX - PLAYER_COLLISION_RADIUS;
        const maxX = collider.maxX + PLAYER_COLLISION_RADIUS;
        const minZ = collider.minZ - PLAYER_COLLISION_RADIUS;
        const maxZ = collider.maxZ + PLAYER_COLLISION_RADIUS;

        const insideX = transform.x > minX && transform.x < maxX;
        const insideZ = transform.z > minZ && transform.z < maxZ;
        if (!insideX || !insideZ) continue;

        const leftDist = Math.abs(transform.x - minX);
        const rightDist = Math.abs(maxX - transform.x);
        const downDist = Math.abs(transform.z - minZ);
        const upDist = Math.abs(maxZ - transform.z);

        const minDist = Math.min(leftDist, rightDist, downDist, upDist);

        if (minDist === leftDist) {
          transform.x = minX;
        } else if (minDist === rightDist) {
          transform.x = maxX;
        } else if (minDist === downDist) {
          transform.z = minZ;
        } else {
          transform.z = maxZ;
        }
      }

      transform.x = clamp(transform.x, boundMinX, boundMaxX);
      transform.z = clamp(transform.z, boundMinZ, boundMaxZ);
    }
  }
}
