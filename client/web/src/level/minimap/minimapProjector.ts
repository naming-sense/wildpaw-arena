import { getMapBounds2D, type LevelMapDefinition } from "../data/levelSchema";

export interface MinimapUv {
  u: number;
  v: number;
}

export interface MinimapProjector {
  worldToUv: (x: number, z: number) => MinimapUv;
  mapToUv: (x: number, y: number) => MinimapUv;
}

export function createMinimapProjector(map: LevelMapDefinition): MinimapProjector {
  const bounds = getMapBounds2D(map);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxZ - bounds.minZ);

  const mapToUv = (x: number, y: number): MinimapUv => ({
    u: (x - bounds.minX) / width,
    v: 1 - (y - bounds.minZ) / height,
  });

  const worldToUv = (x: number, z: number): MinimapUv => mapToUv(x, z);

  return { worldToUv, mapToUv };
}
