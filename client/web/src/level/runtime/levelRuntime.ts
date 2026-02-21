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
import { FogOfWarOverlay } from "./fogOfWarOverlay";
import { segmentIntersectsCollider2D, type LevelStaticCollider } from "./levelCollision";

export interface LevelRuntimeWorldBounds {
  min: number;
  max: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface LosObstacleVisual {
  root: THREE.Object3D;
  colliders: readonly LevelStaticCollider[];
  ownColliderIds: ReadonlySet<string>;
  samplePoints: ReadonlyArray<{ x: number; z: number }>;
  lastVisible: boolean | null;
}

const HIDDEN_OBSTACLE_OPACITY_FACTOR = 0.38;
const OBSTACLE_VISIBILITY_UPDATE_INTERVAL_MS = 120;
const OBSTACLE_VISIBILITY_MOVE_THRESHOLD = 0.22;
const OBSTACLE_VISIBILITY_YAW_THRESHOLD_RAD = (4 * Math.PI) / 180;

function isLosObstacle(collider: LevelStaticCollider): boolean {
  return (
    collider.blocksLineOfSight ||
    collider.blocksMovement ||
    collider.blocksProjectile
  );
}

function buildObstacleSamplePoints(
  colliders: readonly LevelStaticCollider[],
): ReadonlyArray<{ x: number; z: number }> {
  const points: { x: number; z: number }[] = [];
  const seen = new Set<string>();

  for (const collider of colliders) {
    const centerX = (collider.minX + collider.maxX) * 0.5;
    const centerZ = (collider.minZ + collider.maxZ) * 0.5;

    const candidates = [
      { x: centerX, z: centerZ },
      { x: collider.minX, z: collider.minZ },
      { x: collider.minX, z: collider.maxZ },
      { x: collider.maxX, z: collider.minZ },
      { x: collider.maxX, z: collider.maxZ },
    ];

    for (const point of candidates) {
      const key = `${point.x.toFixed(3)}:${point.z.toFixed(3)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      points.push(point);
    }
  }

  return points;
}

function applyOpacityToObject(root: THREE.Object3D, opacityFactor: number): void {
  root.traverse((node) => {
    const maybeMesh = node as THREE.Mesh;
    if (!maybeMesh.isMesh) {
      return;
    }

    const materials = Array.isArray(maybeMesh.material)
      ? maybeMesh.material
      : [maybeMesh.material];

    for (const material of materials) {
      const userData = material.userData as {
        fowBaseOpacity?: number;
        fowBaseTransparent?: boolean;
      };

      if (typeof userData.fowBaseOpacity !== "number") {
        userData.fowBaseOpacity = material.opacity;
        userData.fowBaseTransparent = material.transparent;
      }

      const baseOpacity = userData.fowBaseOpacity;
      const baseTransparent = Boolean(userData.fowBaseTransparent);

      if (opacityFactor >= 0.999) {
        material.opacity = baseOpacity;
        material.transparent = baseTransparent || baseOpacity < 0.999;
      } else {
        material.opacity = Math.max(0.05, baseOpacity * opacityFactor);
        material.transparent = true;
      }

      material.needsUpdate = true;
    }
  });
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
  private fogOfWarOverlay: FogOfWarOverlay | null = null;
  private readonly losObstacleVisuals: LosObstacleVisual[] = [];

  private lastObstacleVisibilityUpdateMs = Number.NEGATIVE_INFINITY;
  private lastObstacleOriginX = Number.NaN;
  private lastObstacleOriginZ = Number.NaN;
  private lastObstacleYaw = Number.NaN;

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

      const losColliders = built.colliders.filter(isLosObstacle);
      if (losColliders.length > 0) {
        this.losObstacleVisuals.push({
          root: built.root,
          colliders: losColliders,
          ownColliderIds: new Set(losColliders.map((collider) => collider.id)),
          samplePoints: buildObstacleSamplePoints(losColliders),
          lastVisible: null,
        });
      }
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
    this.fogOfWarOverlay = new FogOfWarOverlay(this.scene, this.worldBounds, this.colliders);
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

  updateFogOfWar(
    originX: number,
    originZ: number,
    yaw: number,
    rangeMeters: number,
    halfFovRad: number,
    nowMs: number,
  ): void {
    this.fogOfWarOverlay?.updateVision({
      originX,
      originZ,
      yaw,
      rangeMeters,
      halfFovRad,
      nowMs,
    });

    this.updateObstacleVisibility(originX, originZ, yaw, rangeMeters, halfFovRad, nowMs);
  }

  private updateObstacleVisibility(
    originX: number,
    originZ: number,
    yaw: number,
    rangeMeters: number,
    halfFovRad: number,
    nowMs: number,
  ): void {
    const movedDistanceSq =
      (originX - this.lastObstacleOriginX) * (originX - this.lastObstacleOriginX) +
      (originZ - this.lastObstacleOriginZ) * (originZ - this.lastObstacleOriginZ);

    const yawDelta = Number.isFinite(this.lastObstacleYaw)
      ? Math.abs(
        Math.atan2(
          Math.sin(yaw - this.lastObstacleYaw),
          Math.cos(yaw - this.lastObstacleYaw),
        ),
      )
      : Number.POSITIVE_INFINITY;

    const shouldSkipByTime =
      nowMs - this.lastObstacleVisibilityUpdateMs < OBSTACLE_VISIBILITY_UPDATE_INTERVAL_MS;
    const shouldSkipByMove =
      movedDistanceSq <
      OBSTACLE_VISIBILITY_MOVE_THRESHOLD * OBSTACLE_VISIBILITY_MOVE_THRESHOLD;
    const shouldSkipByYaw = yawDelta < OBSTACLE_VISIBILITY_YAW_THRESHOLD_RAD;

    if (shouldSkipByTime && shouldSkipByMove && shouldSkipByYaw) {
      return;
    }

    this.lastObstacleVisibilityUpdateMs = nowMs;
    this.lastObstacleOriginX = originX;
    this.lastObstacleOriginZ = originZ;
    this.lastObstacleYaw = yaw;

    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const cosHalfFov = Math.cos(halfFovRad);
    const rangeSq = rangeMeters * rangeMeters;

    for (const visual of this.losObstacleVisuals) {
      let hasVisibleSample = false;

      for (const point of visual.samplePoints) {
        const dx = point.x - originX;
        const dz = point.z - originZ;
        const distSq = dx * dx + dz * dz;
        if (distSq > rangeSq) {
          continue;
        }

        const dist = Math.sqrt(distSq);
        const dirX = dist > 1e-6 ? dx / dist : forwardX;
        const dirZ = dist > 1e-6 ? dz / dist : forwardZ;
        const forwardDot = dirX * forwardX + dirZ * forwardZ;
        if (forwardDot < cosHalfFov) {
          continue;
        }

        let blocked = false;
        for (const collider of this.colliders) {
          if (!isLosObstacle(collider) || visual.ownColliderIds.has(collider.id)) {
            continue;
          }

          if (
            segmentIntersectsCollider2D(
              originX,
              originZ,
              point.x,
              point.z,
              collider,
              0.02,
            )
          ) {
            blocked = true;
            break;
          }
        }

        if (!blocked) {
          hasVisibleSample = true;
          break;
        }
      }

      if (visual.lastVisible === hasVisibleSample) {
        continue;
      }

      visual.lastVisible = hasVisibleSample;
      applyOpacityToObject(
        visual.root,
        hasVisibleSample ? 1 : HIDDEN_OBSTACLE_OPACITY_FACTOR,
      );
    }
  }

  update(nowMs: number): void {
    this.crystalRushView?.update(nowMs);
    this.switchZoneView?.update(nowMs);
    this.payloadView?.update(nowMs);
  }

  dispose(): void {
    if (this.fogOfWarOverlay) {
      this.fogOfWarOverlay.dispose(this.scene);
      this.fogOfWarOverlay = null;
    }

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
