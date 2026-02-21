import * as THREE from "three";
import { segmentIntersectsCollider2D, type LevelStaticCollider } from "./levelCollision";

export interface FogOfWarBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type FogOfWarQuality = "low" | "medium" | "high";

export interface FogOfWarVisionParams {
  originX: number;
  originZ: number;
  yaw: number;
  rangeMeters: number;
  halfFovRad: number;
  nowMs: number;
}

interface FogOfWarQualityProfile {
  backend: "cpu" | "cone";
  resolution: number;
  updateIntervalMs: number;
  moveUpdateThreshold: number;
  yawUpdateThresholdRad: number;
  edgeBlurEnabled: boolean;
  occlusionEnabled: boolean;
  fovFeatherRad: number;
  rangeFeatherRatio: number;
  darkAlpha: number;
  visibleCenterAlpha: number;
  visibleEdgeAlpha: number;
  coneSegments: number;
  coneFillOpacity: number;
  coneEdgeOpacity: number;
}

interface CpuFogState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  imageData: ImageData;
  worldXByPixel: Float32Array;
  worldZByPixel: Float32Array;
  alphaMask: Uint8ClampedArray;
  alphaBlurScratch: Uint8ClampedArray;
}

interface ConeFogState {
  fillMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  fillEnabled: boolean;
  edgeLine: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  segmentCount: number;
  halfFovRad: number;
}

const LOS_PADDING = 0.02;

const QUALITY_PROFILES: Record<FogOfWarQuality, FogOfWarQualityProfile> = {
  low: {
    backend: "cone",
    resolution: 128,
    updateIntervalMs: 90,
    moveUpdateThreshold: 0.1,
    yawUpdateThresholdRad: (2 * Math.PI) / 180,
    edgeBlurEnabled: false,
    occlusionEnabled: false,
    fovFeatherRad: (6 * Math.PI) / 180,
    rangeFeatherRatio: 0.14,
    darkAlpha: 0.64,
    visibleCenterAlpha: 0.05,
    visibleEdgeAlpha: 0.21,
    coneSegments: 24,
    coneFillOpacity: 0,
    coneEdgeOpacity: 1,
  },
  medium: {
    backend: "cpu",
    resolution: 192,
    updateIntervalMs: 120,
    moveUpdateThreshold: 0.2,
    yawUpdateThresholdRad: (4 * Math.PI) / 180,
    edgeBlurEnabled: true,
    occlusionEnabled: true,
    fovFeatherRad: (4.5 * Math.PI) / 180,
    rangeFeatherRatio: 0.1,
    darkAlpha: 0.72,
    visibleCenterAlpha: 0.05,
    visibleEdgeAlpha: 0.24,
    coneSegments: 34,
    coneFillOpacity: 0.16,
    coneEdgeOpacity: 0.42,
  },
  high: {
    backend: "cpu",
    resolution: 256,
    updateIntervalMs: 90,
    moveUpdateThreshold: 0.12,
    yawUpdateThresholdRad: (2.5 * Math.PI) / 180,
    edgeBlurEnabled: true,
    occlusionEnabled: true,
    fovFeatherRad: (3 * Math.PI) / 180,
    rangeFeatherRatio: 0.08,
    darkAlpha: 0.74,
    visibleCenterAlpha: 0.05,
    visibleEdgeAlpha: 0.24,
    coneSegments: 40,
    coneFillOpacity: 0.16,
    coneEdgeOpacity: 0.42,
  },
};

function isLosObstacle(collider: LevelStaticCollider): boolean {
  return collider.blocksLineOfSight || collider.blocksMovement || collider.blocksProjectile;
}

function profileForQuality(quality: FogOfWarQuality): FogOfWarQualityProfile {
  return QUALITY_PROFILES[quality] ?? QUALITY_PROFILES.medium;
}

function createConeFillGeometry(
  segmentCount: number,
  halfFovRad: number,
  y: number,
): THREE.BufferGeometry {
  const positions = new Float32Array((segmentCount + 2) * 3);
  positions[0] = 0;
  positions[1] = y;
  positions[2] = 0;

  for (let i = 0; i <= segmentCount; i += 1) {
    const t = i / segmentCount;
    const angle = -halfFovRad + halfFovRad * 2 * t;
    const offset = (i + 1) * 3;
    positions[offset] = Math.sin(angle);
    positions[offset + 1] = y;
    positions[offset + 2] = Math.cos(angle);
  }

  const indices = new Uint16Array(segmentCount * 3);
  for (let i = 0; i < segmentCount; i += 1) {
    const offset = i * 3;
    indices[offset] = 0;
    indices[offset + 1] = i + 1;
    indices[offset + 2] = i + 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function createConeEdgeGeometry(
  segmentCount: number,
  halfFovRad: number,
  y: number,
): THREE.BufferGeometry {
  const positions = new Float32Array((segmentCount + 2) * 3);
  positions[0] = 0;
  positions[1] = y;
  positions[2] = 0;

  for (let i = 0; i <= segmentCount; i += 1) {
    const t = i / segmentCount;
    const angle = -halfFovRad + halfFovRad * 2 * t;
    const offset = (i + 1) * 3;
    positions[offset] = Math.sin(angle);
    positions[offset + 1] = y;
    positions[offset + 2] = Math.cos(angle);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export class FogOfWarOverlay {
  private readonly root = new THREE.Group();
  private readonly resolution: number;
  private readonly losColliders: readonly LevelStaticCollider[];
  private readonly bounds: FogOfWarBounds;
  private readonly profile: FogOfWarQualityProfile;
  private readonly cpuState: CpuFogState | null;
  private readonly coneState: ConeFogState | null;

  private lastUpdateMs = Number.NEGATIVE_INFINITY;
  private lastOriginX = Number.NaN;
  private lastOriginZ = Number.NaN;
  private lastYaw = Number.NaN;

  constructor(
    scene: THREE.Scene,
    bounds: FogOfWarBounds,
    colliders: readonly LevelStaticCollider[],
    quality: FogOfWarQuality = "low",
  ) {
    this.bounds = bounds;
    this.profile = profileForQuality(quality);
    this.resolution = this.profile.resolution;
    this.losColliders = this.profile.occlusionEnabled ? colliders.filter(isLosObstacle) : [];

    if (this.profile.backend === "cone") {
      this.coneState = this.createConeState();
      this.cpuState = null;
      this.root.add(this.coneState.fillMesh, this.coneState.edgeLine);
    } else {
      this.cpuState = this.createCpuState();
      this.coneState = null;
      this.root.add(this.cpuState.mesh);
    }

    this.root.name = "fow-overlay";
    scene.add(this.root);
  }

  updateVision(params: FogOfWarVisionParams): void {
    const { originX, originZ, yaw, rangeMeters, halfFovRad, nowMs } = params;

    if (!Number.isFinite(originX) || !Number.isFinite(originZ) || !Number.isFinite(yaw)) {
      return;
    }

    if (!Number.isFinite(rangeMeters) || rangeMeters <= 0) {
      return;
    }

    if (!Number.isFinite(halfFovRad) || halfFovRad <= 0 || halfFovRad >= Math.PI) {
      return;
    }

    const movedDistanceSq =
      (originX - this.lastOriginX) * (originX - this.lastOriginX) +
      (originZ - this.lastOriginZ) * (originZ - this.lastOriginZ);

    const yawDelta = Number.isFinite(this.lastYaw)
      ? Math.abs(Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)))
      : Number.POSITIVE_INFINITY;

    const shouldSkipByTime = nowMs - this.lastUpdateMs < this.profile.updateIntervalMs;
    const shouldSkipByMove =
      movedDistanceSq < this.profile.moveUpdateThreshold * this.profile.moveUpdateThreshold;
    const shouldSkipByYaw = yawDelta < this.profile.yawUpdateThresholdRad;
    if (shouldSkipByTime && shouldSkipByMove && shouldSkipByYaw) {
      return;
    }

    this.lastUpdateMs = nowMs;
    this.lastOriginX = originX;
    this.lastOriginZ = originZ;
    this.lastYaw = yaw;

    if (this.coneState) {
      this.updateConeVision(originX, originZ, yaw, rangeMeters, halfFovRad);
      return;
    }

    if (this.cpuState) {
      this.updateCpuVision(originX, originZ, yaw, rangeMeters, halfFovRad);
    }
  }

  private updateConeVision(
    originX: number,
    originZ: number,
    yaw: number,
    rangeMeters: number,
    halfFovRad: number,
  ): void {
    const cone = this.coneState;
    if (!cone) {
      return;
    }

    if (Math.abs(halfFovRad - cone.halfFovRad) > 1e-4) {
      cone.fillMesh.geometry.dispose();
      cone.edgeLine.geometry.dispose();
      cone.fillMesh.geometry = createConeFillGeometry(cone.segmentCount, halfFovRad, 0.08);
      cone.edgeLine.geometry = createConeEdgeGeometry(cone.segmentCount, halfFovRad, 0.082);
      cone.halfFovRad = halfFovRad;
    }

    cone.fillMesh.position.set(originX, 0, originZ);
    cone.fillMesh.rotation.y = yaw;
    cone.fillMesh.scale.set(rangeMeters, 1, rangeMeters);

    cone.edgeLine.position.set(originX, 0, originZ);
    cone.edgeLine.rotation.y = yaw;
    cone.edgeLine.scale.set(rangeMeters, 1, rangeMeters);
  }

  private updateCpuVision(
    originX: number,
    originZ: number,
    yaw: number,
    rangeMeters: number,
    halfFovRad: number,
  ): void {
    const cpu = this.cpuState;
    if (!cpu) {
      return;
    }

    const data = cpu.imageData.data;
    const rangeSq = rangeMeters * rangeMeters;
    const rangeFeatherMeters = Math.max(0, rangeMeters * this.profile.rangeFeatherRatio);
    const rangeInner = Math.max(0.001, rangeMeters - rangeFeatherMeters);
    const rangeOuter = Math.max(rangeInner + 0.001, rangeMeters);
    const invRangeSpan = 1 / Math.max(1e-5, rangeOuter - rangeInner);
    const invRangeMeters = 1 / Math.max(0.001, rangeMeters);
    const fovInner = Math.max(0.001, halfFovRad - this.profile.fovFeatherRad);
    const fovOuter = Math.min(Math.PI - 0.001, halfFovRad + this.profile.fovFeatherRad);
    const cosFovInner = Math.cos(fovInner);
    const cosFovOuter = Math.cos(fovOuter);
    const invFovSpan = 1 / Math.max(1e-5, cosFovInner - cosFovOuter);
    const enableOcclusion = this.profile.occlusionEnabled;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);

    const darkAlpha255 = Math.round(this.profile.darkAlpha * 255);
    const visibleCenterAlpha255 = Math.round(this.profile.visibleCenterAlpha * 255);
    const visibleEdgeAlpha255 = Math.round(this.profile.visibleEdgeAlpha * 255);

    for (let i = 0; i < cpu.worldXByPixel.length; i += 1) {
      const worldX = cpu.worldXByPixel[i];
      const worldZ = cpu.worldZByPixel[i];

      const dx = worldX - originX;
      const dz = worldZ - originZ;
      const distSq = dx * dx + dz * dz;

      let alpha = darkAlpha255;

      if (distSq <= rangeSq) {
        const forwardProjection = dx * forwardX + dz * forwardZ;
        if (forwardProjection > 0) {
          const dist = Math.sqrt(distSq);
          const forwardDot = forwardProjection / Math.max(1e-6, dist);

          const angularWeight =
            forwardDot >= cosFovInner
              ? 1
              : forwardDot <= cosFovOuter
                ? 0
                : (forwardDot - cosFovOuter) * invFovSpan;

          if (angularWeight > 0) {
            const radialWeight =
              dist <= rangeInner
                ? 1
                : dist >= rangeOuter
                  ? 0
                  : 1 - (dist - rangeInner) * invRangeSpan;

            const visibilityWeight = Math.max(0, Math.min(1, angularWeight * radialWeight));

            if (visibilityWeight > 0) {
              let blocked = false;

              if (enableOcclusion) {
                for (const collider of this.losColliders) {
                  if (
                    segmentIntersectsCollider2D(
                      originX,
                      originZ,
                      worldX,
                      worldZ,
                      collider,
                      LOS_PADDING,
                    )
                  ) {
                    blocked = true;
                    break;
                  }
                }
              }

              if (!blocked) {
                const edgeT = Math.min(1, dist * invRangeMeters);
                const visibleAlpha = Math.round(
                  visibleCenterAlpha255 +
                    (visibleEdgeAlpha255 - visibleCenterAlpha255) * edgeT,
                );
                alpha = Math.round(
                  darkAlpha255 + (visibleAlpha - darkAlpha255) * visibilityWeight,
                );
              }
            }
          }
        }
      }

      cpu.alphaMask[i] = alpha;
    }

    const finalAlpha = this.profile.edgeBlurEnabled
      ? this.applyBoxBlur3x3(cpu.alphaMask, cpu.alphaBlurScratch)
      : cpu.alphaMask;

    for (let i = 0; i < finalAlpha.length; i += 1) {
      const offset = i * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = finalAlpha[i] ?? darkAlpha255;
    }

    cpu.ctx.putImageData(cpu.imageData, 0, 0);
    cpu.texture.needsUpdate = true;
  }

  private createCpuState(): CpuFogState {
    const canvas = document.createElement("canvas");
    canvas.width = this.resolution;
    canvas.height = this.resolution;

    const ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!ctx) {
      throw new Error("fog-of-war canvas context unavailable");
    }

    const imageData = ctx.createImageData(this.resolution, this.resolution);
    const pixelCount = this.resolution * this.resolution;

    const worldXByPixel = new Float32Array(pixelCount);
    const worldZByPixel = new Float32Array(pixelCount);
    this.precomputeWorldCoords(worldXByPixel, worldZByPixel);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    const width = Math.max(1, this.bounds.maxX - this.bounds.minX);
    const depth = Math.max(1, this.bounds.maxZ - this.bounds.minZ);

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: true,
      }),
    );

    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(
      (this.bounds.minX + this.bounds.maxX) * 0.5,
      0.06,
      (this.bounds.minZ + this.bounds.maxZ) * 0.5,
    );
    mesh.renderOrder = 20;

    return {
      canvas,
      ctx,
      texture,
      mesh,
      imageData,
      worldXByPixel,
      worldZByPixel,
      alphaMask: new Uint8ClampedArray(pixelCount),
      alphaBlurScratch: new Uint8ClampedArray(pixelCount),
    };
  }

  private createConeState(): ConeFogState {
    const segmentCount = Math.max(8, this.profile.coneSegments);
    const halfFovRad = (55 * Math.PI) / 180;

    const fillEnabled = this.profile.coneFillOpacity > 0.001;
    const fillGeometry = createConeFillGeometry(segmentCount, halfFovRad, 0.08);

    const fillMaterial = new THREE.MeshBasicMaterial({
      color: 0x0f1d2b,
      transparent: fillEnabled,
      opacity: fillEnabled ? this.profile.coneFillOpacity : 1,
      depthWrite: false,
      depthTest: false,
    });

    const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);
    fillMesh.visible = fillEnabled;
    fillMesh.renderOrder = 20;
    fillMesh.frustumCulled = false;

    const edgeGeometry = createConeEdgeGeometry(segmentCount, halfFovRad, 0.082);
    const edgeTransparent = this.profile.coneEdgeOpacity < 0.999;
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x7fc4ff,
      transparent: edgeTransparent,
      opacity: edgeTransparent ? this.profile.coneEdgeOpacity : 1,
      depthWrite: false,
      depthTest: false,
    });

    const edgeLine = new THREE.LineLoop(edgeGeometry, edgeMaterial);
    edgeLine.renderOrder = 21;
    edgeLine.frustumCulled = false;

    return {
      fillMesh,
      fillEnabled,
      edgeLine,
      segmentCount,
      halfFovRad,
    };
  }

  private applyBoxBlur3x3(
    source: Uint8ClampedArray,
    target: Uint8ClampedArray,
  ): Uint8ClampedArray {
    const width = this.resolution;
    const height = this.resolution;

    for (let y = 0; y < height; y += 1) {
      const yPrev = y > 0 ? y - 1 : 0;
      const yNext = y + 1 < height ? y + 1 : height - 1;

      for (let x = 0; x < width; x += 1) {
        const xPrev = x > 0 ? x - 1 : 0;
        const xNext = x + 1 < width ? x + 1 : width - 1;

        const i00 = yPrev * width + xPrev;
        const i01 = yPrev * width + x;
        const i02 = yPrev * width + xNext;
        const i10 = y * width + xPrev;
        const i11 = y * width + x;
        const i12 = y * width + xNext;
        const i20 = yNext * width + xPrev;
        const i21 = yNext * width + x;
        const i22 = yNext * width + xNext;

        const weighted =
          (source[i00] ?? 0) +
          (source[i01] ?? 0) * 2 +
          (source[i02] ?? 0) +
          (source[i10] ?? 0) * 2 +
          (source[i11] ?? 0) * 4 +
          (source[i12] ?? 0) * 2 +
          (source[i20] ?? 0) +
          (source[i21] ?? 0) * 2 +
          (source[i22] ?? 0);

        target[y * width + x] = Math.round(weighted / 16);
      }
    }

    return target;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.root);

    if (this.cpuState) {
      this.cpuState.mesh.geometry.dispose();
      this.cpuState.mesh.material.dispose();
      this.cpuState.texture.dispose();
    }

    if (this.coneState) {
      this.coneState.fillMesh.geometry.dispose();
      this.coneState.fillMesh.material.dispose();
      this.coneState.edgeLine.geometry.dispose();
      this.coneState.edgeLine.material.dispose();
    }

    this.root.clear();
  }

  private precomputeWorldCoords(worldXByPixel: Float32Array, worldZByPixel: Float32Array): void {
    const width = Math.max(0.001, this.bounds.maxX - this.bounds.minX);
    const depth = Math.max(0.001, this.bounds.maxZ - this.bounds.minZ);

    for (let py = 0; py < this.resolution; py += 1) {
      const v = (py + 0.5) / this.resolution;
      const worldZ = this.bounds.minZ + depth * v;

      for (let px = 0; px < this.resolution; px += 1) {
        const u = (px + 0.5) / this.resolution;
        const worldX = this.bounds.minX + width * u;
        const index = py * this.resolution + px;
        worldXByPixel[index] = worldX;
        worldZByPixel[index] = worldZ;
      }
    }
  }
}
