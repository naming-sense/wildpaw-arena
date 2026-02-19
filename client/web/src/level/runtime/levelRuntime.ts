import * as THREE from "three";
import { loadLevelMapDefinition } from "../data/levelLoader";
import { getMapBounds2D, mapCoordToWorld, type LevelMapDefinition } from "../data/levelSchema";
import { buildMinimapLayers, type MinimapSymbol } from "../minimap/minimapLayers";
import { CrystalRushView } from "../modes/crystalRushView";
import { PayloadView } from "../modes/payloadView";
import { SwitchZoneView } from "../modes/switchZoneView";
import { getPrefabCatalogItem } from "../prefab/prefabCatalog";
import { buildPrefab } from "../prefab/prefabFactory";
import { createLaneOverlayGroup } from "./levelNavOverlay";
import { createLineOfSightDebugGroup } from "./lineOfSightDebug";
import { runSpawnSafetyCheck, type SpawnFallbackOffset } from "./spawnSafetyCheck";
import type { LevelStaticCollider } from "./levelCollision";

export interface LevelRuntimeWorldBounds {
  min: number;
  max: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((node) => {
    const maybeMesh = node as THREE.Mesh;
    if (maybeMesh.isMesh) {
      maybeMesh.geometry?.dispose();

      if (Array.isArray(maybeMesh.material)) {
        for (const material of maybeMesh.material) {
          material.dispose();
        }
      } else {
        maybeMesh.material?.dispose();
      }
    }

    const maybeLine = node as THREE.Line;
    if (maybeLine.isLine) {
      maybeLine.geometry?.dispose();
      const lineMaterial = maybeLine.material;
      if (Array.isArray(lineMaterial)) {
        for (const material of lineMaterial) {
          material.dispose();
        }
      } else {
        lineMaterial?.dispose();
      }
    }
  });
}

function createMissingPrefabPlaceholder(code: string): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({
      color: 0xff3ea8,
      emissive: 0x53102f,
      emissiveIntensity: 0.45,
      roughness: 0.45,
      metalness: 0.15,
    }),
  );

  mesh.name = `missing-prefab:${code}`;
  mesh.position.y = 0.6;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createColliderDebugMesh(collider: LevelStaticCollider): THREE.Object3D {
  const sizeX = Math.max(0.05, collider.maxX - collider.minX);
  const sizeY = Math.max(0.05, collider.maxY - collider.minY);
  const sizeZ = Math.max(0.05, collider.maxZ - collider.minZ);

  const color = collider.blocksMovement ? 0xff9c7a : 0x5ddf98;
  const opacity = collider.blocksMovement ? 0.12 : 0.08;

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(sizeX, sizeY, sizeZ),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      wireframe: true,
    }),
  );

  mesh.position.set(
    (collider.minX + collider.maxX) * 0.5,
    (collider.minY + collider.maxY) * 0.5,
    (collider.minZ + collider.maxZ) * 0.5,
  );

  return mesh;
}

function createSpawnSafetyDebug(
  map: LevelMapDefinition,
  fallbackOffsets: Record<string, SpawnFallbackOffset>,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "debug:spawn-safety";

  for (const spawn of map.spawnPoints) {
    const pos = mapCoordToWorld(spawn.position);
    const hasOffset = Boolean(fallbackOffsets[spawn.id]);

    const marker = new THREE.Mesh(
      new THREE.RingGeometry(spawn.radius * 0.55, spawn.radius * 0.75, 20),
      new THREE.MeshBasicMaterial({
        color: hasOffset ? 0xff8e7a : 0x72d9a6,
        transparent: true,
        opacity: 0.68,
        side: THREE.DoubleSide,
      }),
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.set(pos.x, 0.04, pos.z);
    group.add(marker);
  }

  return group;
}

export class LevelRuntime {
  readonly map: LevelMapDefinition;
  readonly colliders: readonly LevelStaticCollider[];
  readonly worldBounds: LevelRuntimeWorldBounds;
  readonly minimapSymbols: readonly MinimapSymbol[];
  readonly spawnFallbackOffsets: Readonly<Record<string, SpawnFallbackOffset>>;
  readonly warnings: readonly string[];

  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly staticLayer = new THREE.Group();
  private readonly objectiveLayer = new THREE.Group();
  private readonly debugLayer = new THREE.Group();

  private crystalRushView: CrystalRushView | null = null;
  private switchZoneView: SwitchZoneView | null = null;
  private payloadView: PayloadView | null = null;

  constructor(scene: THREE.Scene, mapId?: string | null, debugVisible = false) {
    this.scene = scene;
    this.map = loadLevelMapDefinition(mapId);

    this.root.name = `level:${this.map.mapId}`;
    this.staticLayer.name = "level:static";
    this.objectiveLayer.name = "level:objective";
    this.debugLayer.name = "level:debug";

    this.root.add(this.staticLayer, this.objectiveLayer, this.debugLayer);

    const colliders: LevelStaticCollider[] = [];

    for (const prefab of this.map.prefabs) {
      const catalog = getPrefabCatalogItem(prefab.prefabCode);
      if (!catalog) {
        const fallbackWorld = mapCoordToWorld({ x: prefab.x, y: prefab.y, z: prefab.z });
        const fallbackRoot = new THREE.Group();
        fallbackRoot.position.set(fallbackWorld.x, fallbackWorld.y, fallbackWorld.z);
        fallbackRoot.add(createMissingPrefabPlaceholder(prefab.prefabCode));
        this.staticLayer.add(fallbackRoot);
        console.warn(`[level] missing prefab catalog item code=${prefab.prefabCode} id=${prefab.id}`);
        continue;
      }

      const built = buildPrefab(prefab, catalog);
      this.staticLayer.add(built.root);
      colliders.push(...built.colliders);
    }

    this.colliders = colliders;

    this.setupModeVisuals();

    const minimap = buildMinimapLayers(this.map);
    this.minimapSymbols = minimap.symbols;

    const spawnSafety = runSpawnSafetyCheck(this.map, this.colliders);
    this.spawnFallbackOffsets = spawnSafety.fallbackOffsetsBySpawnId;
    this.warnings = spawnSafety.warnings;

    for (const warning of this.warnings) {
      console.warn(`[level] ${warning}`);
    }

    this.setupDebugLayer();
    this.setDebugVisible(debugVisible);

    const bounds = getMapBounds2D(this.map);
    this.worldBounds = {
      min: Math.min(bounds.minX, bounds.minZ),
      max: Math.max(bounds.maxX, bounds.maxZ),
      minX: bounds.minX,
      maxX: bounds.maxX,
      minZ: bounds.minZ,
      maxZ: bounds.maxZ,
    };

    this.scene.add(this.root);
  }

  setDebugVisible(visible: boolean): void {
    this.debugLayer.visible = visible;
  }

  setSwitchActiveZone(zoneId: string | null): void {
    this.switchZoneView?.setActiveZone(zoneId);
  }

  setPayloadProgress(progress: number): void {
    this.payloadView?.setProgress(progress);
  }

  update(nowMs: number): void {
    this.crystalRushView?.update(nowMs);
    this.switchZoneView?.update(nowMs);
    this.payloadView?.update(nowMs);
  }

  dispose(): void {
    this.scene.remove(this.root);
    disposeObject3D(this.root);
    this.root.clear();
  }

  private setupModeVisuals(): void {
    if (this.map.mode === "CRYSTAL_RUSH") {
      const core = this.map.objectives.find((objective) => objective.type === "CORE");
      if (core) {
        this.crystalRushView = new CrystalRushView(core);
        this.objectiveLayer.add(this.crystalRushView.root);
      }
      return;
    }

    if (this.map.mode === "SWITCH_ZONE") {
      const zones = this.map.objectives.filter((objective) => objective.type === "ZONE");
      if (zones.length > 0) {
        this.switchZoneView = new SwitchZoneView(zones);
        this.objectiveLayer.add(this.switchZoneView.root);
      }
      return;
    }

    if (this.map.mode === "PAYLOAD_HOWL") {
      const payload = this.map.objectives.find((objective) => objective.type === "PAYLOAD_PATH");
      if (payload) {
        this.payloadView = new PayloadView(payload);
        this.objectiveLayer.add(this.payloadView.root);
      }

      const checkpoints = this.map.objectives.filter((objective) => objective.type === "CHECKPOINT" && objective.position);
      for (const checkpoint of checkpoints) {
        const world = mapCoordToWorld(checkpoint.position!);
        const marker = new THREE.Mesh(
          new THREE.TorusGeometry(Math.max(1.2, checkpoint.radius ?? 2.5), 0.06, 8, 32),
          new THREE.MeshBasicMaterial({ color: 0xffde8a, transparent: true, opacity: 0.8 }),
        );
        marker.rotation.x = Math.PI / 2;
        marker.position.set(world.x, 0.05, world.z);
        this.objectiveLayer.add(marker);
      }
    }
  }

  private setupDebugLayer(): void {
    this.debugLayer.add(createLaneOverlayGroup(this.map));
    this.debugLayer.add(createLineOfSightDebugGroup(this.map, this.colliders));

    const colliderGroup = new THREE.Group();
    colliderGroup.name = "debug:colliders";
    for (const collider of this.colliders) {
      colliderGroup.add(createColliderDebugMesh(collider));
    }
    this.debugLayer.add(colliderGroup);

    this.debugLayer.add(createSpawnSafetyDebug(this.map, this.spawnFallbackOffsets));
  }
}
