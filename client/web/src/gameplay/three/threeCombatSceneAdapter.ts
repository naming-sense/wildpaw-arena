import * as THREE from "three";

import { CombatEventType } from "../../netcode/gen/wildpaw/protocol/combat-event-type";
import { ProjectilePhase } from "../../netcode/gen/wildpaw/protocol/projectile-phase";
import type {
  CombatEventPacket,
  PlayerSnapshot,
  ProjectileEventPacket,
} from "../../netcode";
import type { EcsRenderAdapter } from "../ecs/realtimeEcsRuntime";

type TimedFx = {
  mesh: THREE.Object3D;
  expireAtMs: number;
};

export class ThreeCombatSceneAdapter implements EcsRenderAdapter {
  private readonly playerMeshes = new Map<number, THREE.Mesh>();
  private readonly projectileMeshes = new Map<number, THREE.Mesh>();
  private readonly timedFx: TimedFx[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  onSnapshot(players: PlayerSnapshot[]): void {
    const seen = new Set<number>();

    for (const player of players) {
      seen.add(player.playerId);
      let mesh = this.playerMeshes.get(player.playerId);

      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.45, 0.8, 4, 8),
          new THREE.MeshStandardMaterial({ color: 0x9bd4ff }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        this.scene.add(mesh);
        this.playerMeshes.set(player.playerId, mesh);
      }

      mesh.visible = player.alive;
      mesh.position.set(player.position.x, 0.8, player.position.y);

      const hpRatio = player.hp / 100;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.setRGB(1.0 - hpRatio * 0.4, 0.4 + hpRatio * 0.6, 1.0);
    }

    for (const [playerId, mesh] of this.playerMeshes.entries()) {
      if (seen.has(playerId)) {
        continue;
      }
      this.scene.remove(mesh);
      this.playerMeshes.delete(playerId);
    }
  }

  onCombatEvent(event: CombatEventPacket): void {
    if (event.eventType === CombatEventType.DamageApplied) {
      this.spawnPulse(event.position.x, event.position.y, 0xff5b5b, 180);
      return;
    }

    if (event.eventType === CombatEventType.SkillCast) {
      this.spawnPulse(event.position.x, event.position.y, 0x68d4ff, 220);
      return;
    }

    if (event.eventType === CombatEventType.Knockout) {
      this.spawnPulse(event.position.x, event.position.y, 0xffd166, 380, 0.8);
    }
  }

  onProjectileEvent(event: ProjectileEventPacket): void {
    if (event.phase === ProjectilePhase.Spawn) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffee88 }),
      );
      mesh.position.set(event.position.x, 0.6, event.position.y);
      this.scene.add(mesh);
      this.projectileMeshes.set(event.projectileId, mesh);
      return;
    }

    const mesh = this.projectileMeshes.get(event.projectileId);
    if (!mesh) {
      return;
    }

    mesh.position.set(event.position.x, 0.6, event.position.y);

    if (event.phase === ProjectilePhase.Hit || event.phase === ProjectilePhase.Despawn) {
      this.scene.remove(mesh);
      this.projectileMeshes.delete(event.projectileId);
      this.spawnPulse(event.position.x, event.position.y, 0xffffff, 120, 0.35);
    }
  }

  tick(nowMs: number): void {
    for (let i = this.timedFx.length - 1; i >= 0; i -= 1) {
      const fx = this.timedFx[i];
      if (nowMs < fx.expireAtMs) {
        continue;
      }

      this.scene.remove(fx.mesh);
      this.timedFx.splice(i, 1);
    }
  }

  private spawnPulse(
    x: number,
    y: number,
    color: number,
    ttlMs: number,
    radius = 0.45,
  ): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.75, radius, 16),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
      }),
    );

    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.05, y);
    this.scene.add(mesh);

    this.timedFx.push({
      mesh,
      expireAtMs: performance.now() + ttlMs,
    });
  }
}
