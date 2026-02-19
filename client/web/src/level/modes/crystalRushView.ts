import * as THREE from "three";
import type { ObjectiveDef } from "../data/levelSchema";
import { mapCoordToWorld } from "../data/levelSchema";

export class CrystalRushView {
  readonly root = new THREE.Group();
  private readonly coreMesh: THREE.Mesh;
  private readonly ringMesh: THREE.Mesh;

  constructor(coreObjective: ObjectiveDef) {
    this.root.name = "mode:crystal-rush";

    const corePosition = mapCoordToWorld(coreObjective.position ?? { x: 0, y: 0, z: 0 });
    const radius = Math.max(1.8, coreObjective.radius ?? 3.5);

    this.coreMesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(radius * 0.36, 1),
      new THREE.MeshStandardMaterial({
        color: 0xb88bff,
        emissive: 0x5f3db5,
        emissiveIntensity: 0.55,
        roughness: 0.2,
        metalness: 0.35,
      }),
    );
    this.coreMesh.position.set(corePosition.x, corePosition.y + 1.15, corePosition.z);
    this.coreMesh.castShadow = true;

    this.ringMesh = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.8, radius, 40),
      new THREE.MeshBasicMaterial({
        color: 0xcfb1ff,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      }),
    );
    this.ringMesh.rotation.x = -Math.PI / 2;
    this.ringMesh.position.set(corePosition.x, 0.04, corePosition.z);

    this.root.add(this.coreMesh, this.ringMesh);
  }

  update(nowMs: number): void {
    const t = nowMs * 0.001;
    this.coreMesh.rotation.y = t * 0.9;
    this.coreMesh.position.y = 1.1 + Math.sin(t * 2.1) * 0.08;
    const pulse = 0.45 + (Math.sin(t * 3) * 0.5 + 0.5) * 0.25;
    (this.ringMesh.material as THREE.MeshBasicMaterial).opacity = pulse;
  }
}
