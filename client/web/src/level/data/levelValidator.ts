import {
  type LevelMapDefinition,
  type LevelMapId,
  type LevelVector3,
  getMapBounds2D,
  isLevelMapId,
  isLevelModeId,
} from "./levelSchema";

const SPAWN_BUSH_SAFE_RADIUS_M = 8;
const MIN_LANE_WIDTH_M = 2.4;

export interface LevelValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function distance2D(a: LevelVector3, b: LevelVector3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function isWithinBounds(map: LevelMapDefinition, point: LevelVector3): boolean {
  const bounds = getMapBounds2D(map);
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minZ && point.y <= bounds.maxZ;
}

function validateCommon(map: LevelMapDefinition, errors: string[], warnings: string[]): void {
  if (!isLevelMapId(map.mapId)) {
    errors.push(`mapId is invalid: ${String(map.mapId)}`);
  }
  if (!isLevelModeId(map.mode)) {
    errors.push(`mode is invalid: ${String(map.mode)}`);
  }

  if (!Number.isFinite(map.size.width) || !Number.isFinite(map.size.height) || map.size.width <= 0 || map.size.height <= 0) {
    errors.push("size.width/size.height must be finite positive numbers");
  }

  if (map.prefabs.length === 0) {
    errors.push("prefabs must not be empty");
  }
  if (map.spawnPoints.length === 0) {
    errors.push("spawnPoints must not be empty");
  }

  const prefabIds = new Set<string>();
  for (const prefab of map.prefabs) {
    if (prefabIds.has(prefab.id)) {
      errors.push(`prefab id duplicated: ${prefab.id}`);
    }
    prefabIds.add(prefab.id);

    const placementPoint: LevelVector3 = { x: prefab.x, y: prefab.y, z: prefab.z };
    if (!isWithinBounds(map, placementPoint)) {
      errors.push(`prefab out of bounds: ${prefab.id} (${prefab.x}, ${prefab.y})`);
    }
  }

  for (const spawn of map.spawnPoints) {
    if (!isWithinBounds(map, spawn.position)) {
      errors.push(`spawn out of bounds: ${spawn.id}`);
    }
  }

  for (const objective of map.objectives) {
    if (objective.position && !isWithinBounds(map, objective.position)) {
      errors.push(`objective out of bounds: ${objective.id}`);
    }

    if (objective.pathNodes) {
      for (const [index, node] of objective.pathNodes.entries()) {
        if (!isWithinBounds(map, node)) {
          errors.push(`objective path node out of bounds: ${objective.id}[${index}]`);
        }
      }
    }
  }

  const spawnSafetyRadius = Math.max(SPAWN_BUSH_SAFE_RADIUS_M, map.tuning.spawnSafetyRadius || 0);
  const bushPrefabs = map.prefabs.filter((prefab) => prefab.prefabCode.startsWith("BUSH_"));

  for (const spawn of map.spawnPoints) {
    for (const bush of bushPrefabs) {
      const dist = distance2D(spawn.position, { x: bush.x, y: bush.y, z: bush.z });
      if (dist < spawnSafetyRadius) {
        errors.push(
          `spawn safety violated: bush ${bush.id} is ${dist.toFixed(2)}m from spawn ${spawn.id} (need >= ${spawnSafetyRadius}m)`,
        );
      }
    }
  }

  for (const lane of map.lanes) {
    const laneMin = Number.isFinite(lane.minWidth) ? lane.minWidth : 0;
    if (laneMin < MIN_LANE_WIDTH_M || laneMin < map.tuning.minCorridorWidth) {
      warnings.push(
        `lane ${lane.id} width ${laneMin.toFixed(2)}m is under recommended threshold (${Math.max(MIN_LANE_WIDTH_M, map.tuning.minCorridorWidth).toFixed(2)}m)`,
      );
    }
  }
}

function validateNjdCrystalRush(map: LevelMapDefinition, errors: string[], warnings: string[]): void {
  const core = map.objectives.find((objective) => objective.id === "CORE" && objective.type === "CORE");
  if (!core?.position) {
    errors.push("NJD_CR_01 must contain CORE objective with position");
    return;
  }

  if (Math.hypot(core.position.x - 0, core.position.y - 0, core.position.z - 0) > 0.01) {
    errors.push("NJD_CR_01 CORE must be fixed at (0, 0, 0)");
  }

  const spawnA = map.spawnPoints.find((spawn) => spawn.team === "A");
  const spawnB = map.spawnPoints.find((spawn) => spawn.team === "B");
  if (!spawnA || !spawnB) {
    errors.push("NJD_CR_01 requires both team A and B spawns");
    return;
  }

  const runSpeed = map.tuning.spawnRunSpeedMps > 0 ? map.tuning.spawnRunSpeedMps : 5;
  const travelA = distance2D(spawnA.position, core.position) / runSpeed;
  const travelB = distance2D(spawnB.position, core.position) / runSpeed;
  const delta = Math.abs(travelA - travelB);

  if (delta > 0.5) {
    errors.push(`NJD_CR_01 spawn->core travel time delta too high (${delta.toFixed(2)}s > 0.50s)`);
  } else {
    warnings.push(`NJD_CR_01 spawn->core travel delta ${delta.toFixed(2)}s`);
  }
}

function validateHmySwitchZone(map: LevelMapDefinition, errors: string[]): void {
  const zoneA = map.objectives.find((objective) => objective.id === "ZONE_A" && objective.type === "ZONE");
  const zoneB = map.objectives.find((objective) => objective.id === "ZONE_B" && objective.type === "ZONE");

  if (!zoneA?.radius || !zoneB?.radius) {
    errors.push("HMY_SZ_01 requires ZONE_A and ZONE_B with radius");
  } else {
    if (Math.abs(zoneA.radius - 4.5) > 0.01) {
      errors.push(`HMY_SZ_01 ZONE_A radius must be 4.5 (got ${zoneA.radius})`);
    }
    if (Math.abs(zoneB.radius - 4.5) > 0.01) {
      errors.push(`HMY_SZ_01 ZONE_B radius must be 4.5 (got ${zoneB.radius})`);
    }
  }

  const rotation = map.tuning.switchRotation;
  if (!rotation) {
    errors.push("HMY_SZ_01 tuning.switchRotation is required (A45/gap10/B45)");
    return;
  }

  if (rotation.zoneAActiveSec !== 45 || rotation.gapSec !== 10 || rotation.zoneBActiveSec !== 45) {
    errors.push(
      `HMY_SZ_01 rotation mismatch (expected A45/gap10/B45, got A${rotation.zoneAActiveSec}/gap${rotation.gapSec}/B${rotation.zoneBActiveSec})`,
    );
  }
}

function validateFddPayload(map: LevelMapDefinition, errors: string[]): void {
  const payload = map.objectives.find((objective) => objective.type === "PAYLOAD_PATH");
  if (!payload?.pathNodes || payload.pathNodes.length < 7) {
    errors.push("FDD_PH_01 requires PAYLOAD_PATH objective with at least 7 nodes (P0~P6)");
  } else {
    const nodeIds = payload.meta?.nodeIds;
    if (!Array.isArray(nodeIds)) {
      errors.push("FDD_PH_01 PAYLOAD_PATH meta.nodeIds must exist");
    } else {
      const expected = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];
      const actual = nodeIds.slice(0, 7);
      for (let i = 0; i < expected.length; i += 1) {
        if (actual[i] !== expected[i]) {
          errors.push(`FDD_PH_01 PAYLOAD_PATH node order mismatch at ${i}: expected ${expected[i]}, got ${String(actual[i])}`);
          break;
        }
      }
    }
  }

  const cp1 = map.objectives.find((objective) => objective.id === "CP1" && objective.type === "CHECKPOINT");
  const cp2 = map.objectives.find((objective) => objective.id === "CP2" && objective.type === "CHECKPOINT");

  if (!cp1?.position || !cp2?.position) {
    errors.push("FDD_PH_01 checkpoints CP1/CP2 must exist with positions");
    return;
  }

  const cp1Delta = distance2D(cp1.position, { x: -10, y: 0, z: 0 });
  const cp2Delta = distance2D(cp2.position, { x: 14, y: -3, z: 0 });

  if (cp1Delta > 0.01) {
    errors.push(`FDD_PH_01 CP1 position mismatch (expected -10,0)`);
  }
  if (cp2Delta > 0.01) {
    errors.push(`FDD_PH_01 CP2 position mismatch (expected 14,-3)`);
  }
}

function validateByMapId(mapId: LevelMapId, map: LevelMapDefinition, errors: string[], warnings: string[]): void {
  switch (mapId) {
    case "NJD_CR_01":
      validateNjdCrystalRush(map, errors, warnings);
      break;
    case "HMY_SZ_01":
      validateHmySwitchZone(map, errors);
      break;
    case "FDD_PH_01":
      validateFddPayload(map, errors);
      break;
    default:
      break;
  }
}

export function validateLevelMapDefinition(map: LevelMapDefinition): LevelValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  validateCommon(map, errors, warnings);

  if (isLevelMapId(map.mapId)) {
    validateByMapId(map.mapId, map, errors, warnings);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
