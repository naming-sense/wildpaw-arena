export type LevelColliderKind = "box" | "trigger" | "ramp";

export interface LevelStaticCollider {
  id: string;
  sourcePrefabCode: string;
  kind: LevelColliderKind;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  blocksMovement: boolean;
  blocksProjectile: boolean;
  blocksLineOfSight: boolean;
}

export interface CreateColliderInput {
  id: string;
  sourcePrefabCode: string;
  kind: LevelColliderKind;
  centerX: number;
  centerY: number;
  centerZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  rotDeg: number;
  blocksMovement: boolean;
  blocksProjectile: boolean;
  blocksLineOfSight: boolean;
}

export function createAabbCollider(input: CreateColliderInput): LevelStaticCollider {
  const halfX = Math.max(0.01, input.sizeX / 2);
  const halfY = Math.max(0.01, input.sizeY / 2);
  const halfZ = Math.max(0.01, input.sizeZ / 2);

  const theta = (input.rotDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const extentX = Math.abs(cos) * halfX + Math.abs(sin) * halfZ;
  const extentZ = Math.abs(sin) * halfX + Math.abs(cos) * halfZ;

  return {
    id: input.id,
    sourcePrefabCode: input.sourcePrefabCode,
    kind: input.kind,
    minX: input.centerX - extentX,
    maxX: input.centerX + extentX,
    minY: input.centerY - halfY,
    maxY: input.centerY + halfY,
    minZ: input.centerZ - extentZ,
    maxZ: input.centerZ + extentZ,
    blocksMovement: input.blocksMovement,
    blocksProjectile: input.blocksProjectile,
    blocksLineOfSight: input.blocksLineOfSight,
  };
}

export function segmentIntersectsCollider2D(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  collider: Pick<LevelStaticCollider, "minX" | "maxX" | "minZ" | "maxZ">,
  padding = 0,
): boolean {
  const minX = collider.minX - padding;
  const maxX = collider.maxX + padding;
  const minZ = collider.minZ - padding;
  const maxZ = collider.maxZ + padding;

  const dx = x1 - x0;
  const dz = z1 - z0;

  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-7) {
    if (x0 < minX || x0 > maxX) return false;
  } else {
    const invDx = 1 / dx;
    let t1 = (minX - x0) * invDx;
    let t2 = (maxX - x0) * invDx;
    if (t1 > t2) {
      const temp = t1;
      t1 = t2;
      t2 = temp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  if (Math.abs(dz) < 1e-7) {
    if (z0 < minZ || z0 > maxZ) return false;
  } else {
    const invDz = 1 / dz;
    let t1 = (minZ - z0) * invDz;
    let t2 = (maxZ - z0) * invDz;
    if (t1 > t2) {
      const temp = t1;
      t1 = t2;
      t2 = temp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  return true;
}

export function isPointInsideCollider2D(
  x: number,
  z: number,
  collider: Pick<LevelStaticCollider, "minX" | "maxX" | "minZ" | "maxZ">,
  padding = 0,
): boolean {
  return (
    x >= collider.minX - padding &&
    x <= collider.maxX + padding &&
    z >= collider.minZ - padding &&
    z <= collider.maxZ + padding
  );
}
