import * as THREE from "three";
import type { LevelMapDefinition } from "../data/levelSchema";
import { mapCoordToWorld } from "../data/levelSchema";

function colorForLaneTags(tags?: string[]): number {
  if (!tags || tags.length === 0) return 0x9cb5d6;
  if (tags.includes("main")) return 0x7ac4ff;
  if (tags.includes("flank")) return 0x7de8b2;
  if (tags.includes("backdoor")) return 0xffca73;
  if (tags.includes("objective")) return 0xffbc62;
  if (tags.includes("clash")) return 0xff8f8f;
  return 0x9cb5d6;
}

export function createLaneOverlayGroup(map: LevelMapDefinition): THREE.Group {
  const group = new THREE.Group();
  group.name = "debug:lanes";

  for (const lane of map.lanes) {
    if (lane.points.length < 2) continue;

    const points = lane.points.map((point) => {
      const world = mapCoordToWorld(point);
      return new THREE.Vector3(world.x, 0.06, world.z);
    });

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: colorForLaneTags(lane.tags),
        transparent: true,
        opacity: 0.84,
      }),
    );

    group.add(line);
  }

  return group;
}
