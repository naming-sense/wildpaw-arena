import * as THREE from "three";
import type { LevelMapDefinition } from "../data/levelSchema";
import { mapCoordToWorld } from "../data/levelSchema";
import { segmentIntersectsCollider2D, type LevelStaticCollider } from "./levelCollision";

function createLine(start: THREE.Vector3, end: THREE.Vector3, color: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.88 }),
  );
}

export function createLineOfSightDebugGroup(
  map: LevelMapDefinition,
  colliders: readonly LevelStaticCollider[],
): THREE.Group {
  const group = new THREE.Group();
  group.name = "debug:line-of-sight";

  const teamASpawns = map.spawnPoints.filter((spawn) => spawn.team === "A");
  const teamBSpawns = map.spawnPoints.filter((spawn) => spawn.team === "B");

  const maxPairCount = Math.min(4, teamASpawns.length * teamBSpawns.length);
  let pairCount = 0;

  for (const spawnA of teamASpawns) {
    for (const spawnB of teamBSpawns) {
      if (pairCount >= maxPairCount) break;

      const blocked = colliders.some((collider) => {
        if (!collider.blocksLineOfSight) return false;
        return segmentIntersectsCollider2D(
          spawnA.position.x,
          spawnA.position.y,
          spawnB.position.x,
          spawnB.position.y,
          collider,
        );
      });

      const startW = mapCoordToWorld(spawnA.position);
      const endW = mapCoordToWorld(spawnB.position);
      const start = new THREE.Vector3(startW.x, 0.2, startW.z);
      const end = new THREE.Vector3(endW.x, 0.2, endW.z);
      const line = createLine(start, end, blocked ? 0x62d8ff : 0xff7373);

      group.add(line);
      pairCount += 1;
    }
  }

  return group;
}
