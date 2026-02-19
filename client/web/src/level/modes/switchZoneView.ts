import * as THREE from "three";
import type { ObjectiveDef } from "../data/levelSchema";
import { mapCoordToWorld } from "../data/levelSchema";

interface ZoneVisual {
  id: string;
  mesh: THREE.Mesh;
}

export class SwitchZoneView {
  readonly root = new THREE.Group();
  private readonly zones: ZoneVisual[] = [];
  private activeZoneId: string | null = "ZONE_A";

  constructor(zoneObjectives: ObjectiveDef[]) {
    this.root.name = "mode:switch-zone";

    for (const objective of zoneObjectives) {
      const position = mapCoordToWorld(objective.position ?? { x: 0, y: 0, z: 0 });
      const radius = Math.max(2, objective.radius ?? 4.5);

      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 40),
        new THREE.MeshBasicMaterial({
          color: objective.id === "ZONE_A" ? 0x5fc5ff : 0xff9f6c,
          transparent: true,
          opacity: 0.22,
          side: THREE.DoubleSide,
        }),
      );

      mesh.position.set(position.x, 0.03, position.z);
      mesh.rotation.x = -Math.PI / 2;

      this.root.add(mesh);
      this.zones.push({ id: objective.id, mesh });
    }
  }

  setActiveZone(zoneId: string | null): void {
    this.activeZoneId = zoneId;
  }

  update(nowMs: number): void {
    const pulse = 0.3 + (Math.sin(nowMs * 0.004) * 0.5 + 0.5) * 0.28;

    for (const zone of this.zones) {
      const material = zone.mesh.material as THREE.MeshBasicMaterial;
      if (zone.id === this.activeZoneId) {
        material.opacity = pulse;
      } else {
        material.opacity = 0.12;
      }
    }
  }
}
