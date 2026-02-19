import type { LevelMapDefinition, LevelTeamId, SpawnPoint } from "../data/levelSchema";
import { segmentIntersectsCollider2D, type LevelStaticCollider } from "./levelCollision";

export interface SpawnFallbackOffset {
  x: number;
  y: number;
  z: number;
}

export interface SpawnSafetyCheckResult {
  warnings: string[];
  fallbackOffsetsBySpawnId: Record<string, SpawnFallbackOffset>;
}

function distance2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function primarySpawn(spawns: SpawnPoint[], team: LevelTeamId): SpawnPoint | null {
  return (
    spawns
      .filter((spawn) => spawn.team === team)
      .sort((a, b) => (a.phase ?? 1) - (b.phase ?? 1))[0] ?? null
  );
}

export function runSpawnSafetyCheck(
  map: LevelMapDefinition,
  colliders: readonly LevelStaticCollider[],
): SpawnSafetyCheckResult {
  const warnings: string[] = [];
  const fallbackOffsetsBySpawnId: Record<string, SpawnFallbackOffset> = {};

  const safetyRadius = Math.max(8, map.tuning.spawnSafetyRadius || 0);
  const bushPlacements = map.prefabs.filter((prefab) => prefab.prefabCode.startsWith("BUSH_"));

  for (const spawn of map.spawnPoints) {
    let offsetX = 0;
    let offsetY = 0;

    for (const bush of bushPlacements) {
      const dist = distance2D(spawn.position, { x: bush.x, y: bush.y });
      if (dist >= safetyRadius) continue;

      warnings.push(
        `[spawn-safety] ${spawn.id} near bush ${bush.id} (${dist.toFixed(2)}m < ${safetyRadius.toFixed(1)}m)`
      );

      const push = safetyRadius - dist + 0.8;
      const dx = spawn.position.x - bush.x;
      const dy = spawn.position.y - bush.y;
      const len = Math.max(0.01, Math.hypot(dx, dy));
      offsetX += (dx / len) * push;
      offsetY += (dy / len) * push;
    }

    if (Math.abs(offsetX) > 0.01 || Math.abs(offsetY) > 0.01) {
      fallbackOffsetsBySpawnId[spawn.id] = {
        x: offsetX,
        y: offsetY,
        z: 0,
      };
    }
  }

  const spawnA = primarySpawn(map.spawnPoints, "A");
  const spawnB = primarySpawn(map.spawnPoints, "B");

  if (spawnA && spawnB) {
    const lineBlocked = colliders.some((collider) => {
      if (!collider.blocksLineOfSight) return false;
      return segmentIntersectsCollider2D(
        spawnA.position.x,
        spawnA.position.y,
        spawnB.position.x,
        spawnB.position.y,
        collider,
      );
    });

    if (!lineBlocked) {
      warnings.push(
        `[spawn-safety] direct spawn line-of-sight open between ${spawnA.id} and ${spawnB.id}`,
      );
    }
  }

  return {
    warnings,
    fallbackOffsetsBySpawnId,
  };
}
