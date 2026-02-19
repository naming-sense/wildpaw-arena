export const LEVEL_MAP_IDS = ["NJD_CR_01", "HMY_SZ_01", "FDD_PH_01"] as const;
export type LevelMapId = (typeof LEVEL_MAP_IDS)[number];

export const LEVEL_MODE_IDS = ["CRYSTAL_RUSH", "SWITCH_ZONE", "PAYLOAD_HOWL"] as const;
export type LevelModeId = (typeof LEVEL_MODE_IDS)[number];

export type LevelTeamId = "A" | "B";

export interface LevelVector3 {
  x: number;
  y: number;
  z: number;
}

export interface LevelSize2D {
  width: number;
  height: number;
}

export interface SpawnPoint {
  id: string;
  team: LevelTeamId;
  position: LevelVector3;
  radius: number;
  phase?: number;
}

export type ObjectiveType = "CORE" | "ZONE" | "PAYLOAD_PATH" | "CHECKPOINT" | "MARKER";

export interface ObjectiveDef {
  id: string;
  type: ObjectiveType;
  position?: LevelVector3;
  radius?: number;
  pathNodes?: LevelVector3[];
  meta?: Record<string, string | number | boolean | string[]>;
}

export interface PrefabPlacement {
  id: string;
  prefabCode: string;
  x: number;
  y: number;
  z: number;
  rotDeg?: number;
  extra?: Record<string, string | number | boolean>;
}

export interface LaneDef {
  id: string;
  points: LevelVector3[];
  minWidth: number;
  tags?: string[];
}

export interface LevelSwitchRotationDef {
  zoneAActiveSec: number;
  gapSec: number;
  zoneBActiveSec: number;
}

export interface PayloadCheckpointTuning {
  id: string;
  targetMinSec: number;
  targetMaxSec: number;
}

export interface LevelTuningDef {
  spawnSafetyRadius: number;
  minCorridorWidth: number;
  expectedFirstEngageSec: [number, number];
  spawnRunSpeedMps: number;
  switchRotation?: LevelSwitchRotationDef;
  payloadCheckpointTargets?: PayloadCheckpointTuning[];
}

export interface LevelMapDefinition {
  mapId: LevelMapId;
  mode: LevelModeId;
  mapRevision: number;
  size: LevelSize2D;
  origin: LevelVector3;
  spawnPoints: SpawnPoint[];
  objectives: ObjectiveDef[];
  prefabs: PrefabPlacement[];
  lanes: LaneDef[];
  tuning: LevelTuningDef;
}

export interface WorldBounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function isLevelMapId(value: string): value is LevelMapId {
  return (LEVEL_MAP_IDS as readonly string[]).includes(value);
}

export function isLevelModeId(value: string): value is LevelModeId {
  return (LEVEL_MODE_IDS as readonly string[]).includes(value);
}

/**
 * Map design docs use (x, y, z) where x/y are top-down plane and z is height.
 * Runtime world uses (x, y, z) where x/z are top-down plane and y is height.
 */
export function mapCoordToWorld(coord: LevelVector3): { x: number; y: number; z: number } {
  return {
    x: coord.x,
    y: coord.z,
    z: coord.y,
  };
}

export function worldCoordToMap(coord: { x: number; y: number; z: number }): LevelVector3 {
  return {
    x: coord.x,
    y: coord.z,
    z: coord.y,
  };
}

export function getMapBounds2D(map: Pick<LevelMapDefinition, "size" | "origin">): WorldBounds2D {
  const halfWidth = map.size.width / 2;
  const halfHeight = map.size.height / 2;

  return {
    minX: map.origin.x - halfWidth,
    maxX: map.origin.x + halfWidth,
    minZ: map.origin.y - halfHeight,
    maxZ: map.origin.y + halfHeight,
  };
}
