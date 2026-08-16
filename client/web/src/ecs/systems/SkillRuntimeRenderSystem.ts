import * as THREE from "three";
import type { SkillRuntime, SkillRuntimeAnchor } from "../components";
import type { EcsSystem, SimulationContext, World } from "../world";

interface SkillRuntimeVisual {
  root: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
}

const ARCHETYPE_COLOR: Record<SkillRuntime["archetype"], number> = {
  Dash: 0xffc45c,
  Projectile: 0x75e8ff,
  Zone: 0x7ee787,
  Channel: 0x6ba9ff,
  Buff: 0xc99cff,
  Shield: 0x75f1ff,
  Rescue: 0xffa6dd,
};

export class SkillRuntimeRenderSystem implements EcsSystem {
  readonly name = "SkillRuntimeRenderSystem";
  private readonly visuals = new Map<SkillRuntime, SkillRuntimeVisual>();

  constructor(private readonly scene: THREE.Scene) {}

  update(world: World, ctx: SimulationContext): void {
    const liveRuntimes = new Set<SkillRuntime>();

    for (const runtimes of world.skillRuntimes.values()) {
      for (const runtime of runtimes) {
        if (runtime.remainingMs <= 0) {
          continue;
        }

        liveRuntimes.add(runtime);
        let visual = this.visuals.get(runtime);
        if (!visual) {
          visual = this.createVisual(runtime);
          this.visuals.set(runtime, visual);
        }
        this.updateVisual(runtime, visual, ctx.nowMs);
      }
    }

    for (const [runtime, visual] of this.visuals) {
      if (!liveRuntimes.has(runtime)) {
        this.disposeVisual(runtime, visual);
      }
    }
  }

  clearOwner(ownerPlayerId: number): void {
    for (const [runtime, visual] of this.visuals) {
      if (runtime.ownerPlayerId === ownerPlayerId) {
        this.disposeVisual(runtime, visual);
      }
    }
  }

  clear(): void {
    for (const [runtime, visual] of this.visuals) {
      this.disposeVisual(runtime, visual);
    }
  }

  private createVisual(runtime: SkillRuntime): SkillRuntimeVisual {
    const geometry = this.createGeometry(runtime);
    const material = new THREE.MeshBasicMaterial({
      color: ARCHETYPE_COLOR[runtime.archetype],
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      wireframe: runtime.archetype === "Shield",
    });
    const mesh = new THREE.Mesh(geometry, material);
    const root = new THREE.Group();

    if (
      runtime.archetype === "Zone" ||
      runtime.archetype === "Buff" ||
      runtime.archetype === "Rescue"
    ) {
      mesh.rotation.x = -Math.PI / 2;
    }

    mesh.frustumCulled = false;
    mesh.renderOrder = 54;
    root.add(mesh);
    this.scene.add(root);
    return { root, mesh, geometry, material };
  }

  private createGeometry(runtime: SkillRuntime): THREE.BufferGeometry {
    switch (runtime.archetype) {
      case "Projectile":
        return new THREE.SphereGeometry(1, 10, 10);
      case "Dash":
      case "Channel":
        return new THREE.BoxGeometry(1, 1, 1);
      case "Zone":
      case "Rescue":
        return new THREE.RingGeometry(0.72, 1, 48);
      case "Buff":
        return new THREE.TorusGeometry(1, 0.07, 8, 40);
      case "Shield":
        return new THREE.SphereGeometry(1, 18, 12);
    }
  }

  private updateVisual(
    runtime: SkillRuntime,
    visual: SkillRuntimeVisual,
    nowMs: number,
  ): void {
    const lifeRatio = runtime.durationMs > 0
      ? THREE.MathUtils.clamp(runtime.remainingMs / runtime.durationMs, 0, 1)
      : 0;
    const fade = THREE.MathUtils.smoothstep(lifeRatio, 0, 0.18);
    const pulse = 1 + Math.sin(nowMs * 0.008) * 0.06;
    const radius = Math.max(0.45, runtime.radiusM);
    const authorityOpacity = runtime.authority === "ServerApproved" ? 0.26 : 0.4;

    visual.root.visible = runtime.remainingMs > 0;
    visual.root.position.set(
      runtime.currentX,
      this.resolveAnchorHeight(runtime.anchor),
      runtime.currentZ,
    );
    visual.root.rotation.set(0, 0, 0);
    visual.mesh.scale.set(1, 1, 1);
    visual.material.opacity = authorityOpacity * fade;

    switch (runtime.archetype) {
      case "Projectile":
        visual.mesh.scale.setScalar(0.16 * pulse);
        return;
      case "Dash": {
        const deltaX = runtime.currentX - runtime.originX;
        const deltaZ = runtime.currentZ - runtime.originZ;
        const distance = Math.max(0.12, Math.hypot(deltaX, deltaZ));
        const directionX = distance > 0.13 ? deltaX / distance : runtime.directionX;
        const directionZ = distance > 0.13 ? deltaZ / distance : runtime.directionZ;
        visual.root.position.set(
          runtime.originX + directionX * distance * 0.5,
          this.resolveAnchorHeight(runtime.anchor),
          runtime.originZ + directionZ * distance * 0.5,
        );
        visual.root.rotation.y = Math.atan2(directionX, directionZ);
        visual.mesh.scale.set(Math.max(0.18, runtime.radiusM * 0.5), 0.06, distance);
        return;
      }
      case "Channel": {
        const range = Math.max(0.8, runtime.rangeM);
        visual.root.position.x += runtime.directionX * range * 0.5;
        visual.root.position.z += runtime.directionZ * range * 0.5;
        visual.root.rotation.y = Math.atan2(runtime.directionX, runtime.directionZ);
        visual.mesh.scale.set(Math.max(0.09, runtime.radiusM * 0.12), 0.08, range);
        return;
      }
      case "Zone":
        visual.mesh.scale.set(radius * pulse, radius * pulse, 1);
        return;
      case "Buff":
        visual.mesh.scale.set(radius * pulse, radius * pulse, radius * pulse);
        return;
      case "Shield":
        visual.root.position.y += 0.82;
        visual.mesh.scale.setScalar(radius * pulse);
        return;
      case "Rescue":
        visual.mesh.scale.set(radius * pulse, radius * pulse, 1);
        return;
    }
  }

  private resolveAnchorHeight(anchor: SkillRuntimeAnchor): number {
    switch (anchor) {
      case "World":
        return 0.04;
      case "Owner":
        return 0.1;
      case "Trajectory":
        return 0.72;
    }
  }

  private disposeVisual(runtime: SkillRuntime, visual: SkillRuntimeVisual): void {
    this.scene.remove(visual.root);
    visual.geometry.dispose();
    visual.material.dispose();
    this.visuals.delete(runtime);
  }
}
