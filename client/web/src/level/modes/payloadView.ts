import * as THREE from "three";
import type { ObjectiveDef } from "../data/levelSchema";
import { mapCoordToWorld } from "../data/levelSchema";

export class PayloadView {
  readonly root = new THREE.Group();
  private readonly payloadMesh: THREE.Mesh;
  private readonly pathPoints: THREE.Vector3[];
  private progress = 0;

  constructor(payloadObjective: ObjectiveDef) {
    this.root.name = "mode:payload";

    this.pathPoints = (payloadObjective.pathNodes ?? []).map((node) => {
      const world = mapCoordToWorld(node);
      return new THREE.Vector3(world.x, 0.08, world.z);
    });

    if (this.pathPoints.length >= 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(this.pathPoints);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xffbc62, transparent: true, opacity: 0.86 }),
      );
      this.root.add(line);
    }

    this.payloadMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.75, 0.84, 16),
      new THREE.MeshStandardMaterial({
        color: 0xffcb77,
        emissive: 0x6a4100,
        emissiveIntensity: 0.35,
        roughness: 0.42,
        metalness: 0.28,
      }),
    );
    this.payloadMesh.castShadow = true;
    this.payloadMesh.position.set(0, 0.55, 0);
    this.root.add(this.payloadMesh);

    this.setProgress(0);
  }

  setProgress(nextProgress: number): void {
    this.progress = THREE.MathUtils.clamp(nextProgress, 0, 1);

    if (this.pathPoints.length === 0) {
      this.payloadMesh.position.set(0, 0.55, 0);
      return;
    }

    if (this.pathPoints.length === 1) {
      const p = this.pathPoints[0]!;
      this.payloadMesh.position.set(p.x, 0.55, p.z);
      return;
    }

    const segmentProgress = this.progress * (this.pathPoints.length - 1);
    const index = Math.floor(segmentProgress);
    const frac = segmentProgress - index;

    const start = this.pathPoints[index] ?? this.pathPoints[this.pathPoints.length - 1]!;
    const end = this.pathPoints[Math.min(index + 1, this.pathPoints.length - 1)] ?? start;

    const x = THREE.MathUtils.lerp(start.x, end.x, frac);
    const z = THREE.MathUtils.lerp(start.z, end.z, frac);

    this.payloadMesh.position.set(x, 0.55, z);
  }

  update(nowMs: number): void {
    this.payloadMesh.rotation.y = nowMs * 0.0012;
  }
}
