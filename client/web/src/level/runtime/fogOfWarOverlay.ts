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
  resolution: number;
  updateIntervalMs: number;
  moveUpdateThreshold: number;
  yawUpdateThresholdRad: number;
  edgeBlurEnabled: boolean;
  blurPasses: number;
  occlusionEnabled: boolean;
  darkAlpha: number;
  visibleCenterAlpha: number;
  visibleEdgeAlpha: number;
  transitionMs: number;
}

const LOS_PADDING = 0.02;

const QUALITY_PROFILES: Record<FogOfWarQuality, FogOfWarQualityProfile> = {
  low: {
    resolution: 160,
    updateIntervalMs: 190,
    moveUpdateThreshold: 0.3,
    yawUpdateThresholdRad: (6 * Math.PI) / 180,
    edgeBlurEnabled: true,
    blurPasses: 2,
    occlusionEnabled: true,
    darkAlpha: 0.7,
    visibleCenterAlpha: 0.05,
    visibleEdgeAlpha: 0.24,
    transitionMs: 120,
  },
  medium: {
    resolution: 224,
    updateIntervalMs: 115,
    moveUpdateThreshold: 0.18,
    yawUpdateThresholdRad: (3 * Math.PI) / 180,
    edgeBlurEnabled: true,
    blurPasses: 3,
    occlusionEnabled: true,
    darkAlpha: 0.72,
    visibleCenterAlpha: 0.05,
    visibleEdgeAlpha: 0.24,
    transitionMs: 92,
  },
  high: {
    resolution: 288,
    updateIntervalMs: 90,
    moveUpdateThreshold: 0.12,
    yawUpdateThresholdRad: (2 * Math.PI) / 180,
    edgeBlurEnabled: true,
    blurPasses: 3,
    occlusionEnabled: true,
    darkAlpha: 0.74,
    visibleCenterAlpha: 0.05,
    visibleEdgeAlpha: 0.24,
    transitionMs: 74,
  },
};

function isLosObstacle(collider: LevelStaticCollider): boolean {
  return collider.blocksLineOfSight || collider.blocksMovement || collider.blocksProjectile;
}

function profileForQuality(quality: FogOfWarQuality): FogOfWarQualityProfile {
  return QUALITY_PROFILES[quality] ?? QUALITY_PROFILES.medium;
}

export class FogOfWarOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly imageData: ImageData;
  private readonly worldXByPixel: Float32Array;
  private readonly worldZByPixel: Float32Array;
  private readonly alphaMask: Uint8ClampedArray;
  private readonly alphaBlurScratch: Uint8ClampedArray;
  private readonly alphaTarget: Uint8ClampedArray;
  private readonly alphaCurrent: Uint8ClampedArray;
  private readonly alphaTransitionFrom: Uint8ClampedArray;
  private readonly occlusionCandidates: LevelStaticCollider[] = [];
  private readonly resolution: number;
  private readonly losColliders: readonly LevelStaticCollider[];
  private readonly bounds: FogOfWarBounds;
  private readonly profile: FogOfWarQualityProfile;

  private lastUpdateMs = Number.NEGATIVE_INFINITY;
  private lastOriginX = Number.NaN;
  private lastOriginZ = Number.NaN;
  private lastYaw = Number.NaN;
  private dynamicUpdateIntervalMs: number;
  private transitionStartedAtMs = Number.NEGATIVE_INFINITY;
  private transitionActive = false;
  private hasInitialFrame = false;

  constructor(
    scene: THREE.Scene,
    bounds: FogOfWarBounds,
    colliders: readonly LevelStaticCollider[],
    quality: FogOfWarQuality = "low",
  ) {
    this.bounds = bounds;
    this.profile = profileForQuality(quality);
    this.resolution = this.profile.resolution;
    this.dynamicUpdateIntervalMs = this.profile.updateIntervalMs;
    this.losColliders = this.profile.occlusionEnabled ? colliders.filter(isLosObstacle) : [];

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.resolution;
    this.canvas.height = this.resolution;

    const ctx = this.canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!ctx) {
      throw new Error("fog-of-war canvas context unavailable");
    }

    this.ctx = ctx;
    this.imageData = this.ctx.createImageData(this.resolution, this.resolution);

    const pixelCount = this.resolution * this.resolution;
    this.worldXByPixel = new Float32Array(pixelCount);
    this.worldZByPixel = new Float32Array(pixelCount);
    this.alphaMask = new Uint8ClampedArray(pixelCount);
    this.alphaBlurScratch = new Uint8ClampedArray(pixelCount);
    this.alphaTarget = new Uint8ClampedArray(pixelCount);
    this.alphaCurrent = new Uint8ClampedArray(pixelCount);
    this.alphaTransitionFrom = new Uint8ClampedArray(pixelCount);
    this.precomputeWorldCoords();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    const width = Math.max(1, this.bounds.maxX - this.bounds.minX);
    const depth = Math.max(1, this.bounds.maxZ - this.bounds.minZ);

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
        depthTest: true,
      }),
    );

    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(
      (this.bounds.minX + this.bounds.maxX) * 0.5,
      0.06,
      (this.bounds.minZ + this.bounds.maxZ) * 0.5,
    );
    this.mesh.renderOrder = 20;

    scene.add(this.mesh);
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

    const shouldSkipByTime = nowMs - this.lastUpdateMs < this.dynamicUpdateIntervalMs;
    const shouldSkipByMove =
      movedDistanceSq < this.profile.moveUpdateThreshold * this.profile.moveUpdateThreshold;
    const shouldSkipByYaw = yawDelta < this.profile.yawUpdateThresholdRad;

    const shouldRecompute = !(shouldSkipByTime && shouldSkipByMove && shouldSkipByYaw);

    if (shouldRecompute) {
      const computeStartedAt = typeof performance !== "undefined" ? performance.now() : nowMs;

      this.lastUpdateMs = nowMs;
      this.lastOriginX = originX;
      this.lastOriginZ = originZ;
      this.lastYaw = yaw;

      const rangeSq = rangeMeters * rangeMeters;
      const cosHalfFov = Math.cos(halfFovRad);
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);

      const darkAlpha255 = Math.round(this.profile.darkAlpha * 255);
      const visibleCenterAlpha255 = Math.round(this.profile.visibleCenterAlpha * 255);
      const visibleEdgeAlpha255 = Math.round(this.profile.visibleEdgeAlpha * 255);
      const occlusionCandidates = this.profile.occlusionEnabled
        ? this.collectOcclusionCandidates(originX, originZ, rangeMeters)
        : null;

      for (let i = 0; i < this.worldXByPixel.length; i += 1) {
        const worldX = this.worldXByPixel[i];
        const worldZ = this.worldZByPixel[i];

        const dx = worldX - originX;
        const dz = worldZ - originZ;
        const distSq = dx * dx + dz * dz;

        let alpha = darkAlpha255;

        if (distSq <= rangeSq) {
          const dist = Math.sqrt(distSq);
          const invDist = dist > 1e-6 ? 1 / dist : 0;
          const dirX = dist > 1e-6 ? dx * invDist : forwardX;
          const dirZ = dist > 1e-6 ? dz * invDist : forwardZ;
          const forwardDot = dirX * forwardX + dirZ * forwardZ;

          if (forwardDot >= cosHalfFov) {
            let blocked = false;

            if (occlusionCandidates && occlusionCandidates.length > 0) {
              for (const collider of occlusionCandidates) {
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
              const edgeT = Math.min(1, dist / Math.max(0.001, rangeMeters));
              alpha = Math.round(
                visibleCenterAlpha255 +
                  (visibleEdgeAlpha255 - visibleCenterAlpha255) * edgeT,
              );
            }
          }
        }

        this.alphaMask[i] = alpha;
      }

      const finalAlpha = this.applyBlurPasses(this.alphaMask);

      this.alphaTarget.set(finalAlpha);

      if (!this.hasInitialFrame) {
        this.alphaCurrent.set(this.alphaTarget);
        this.hasInitialFrame = true;
        this.transitionActive = false;
      } else if (this.profile.transitionMs <= 1) {
        this.alphaCurrent.set(this.alphaTarget);
        this.transitionActive = false;
      } else {
        this.alphaTransitionFrom.set(this.alphaCurrent);
        this.transitionStartedAtMs = nowMs;
        this.transitionActive = true;
      }

      const computeEndedAt = typeof performance !== "undefined" ? performance.now() : nowMs;
      this.tuneUpdateInterval(computeEndedAt - computeStartedAt);
    }

    if (!this.hasInitialFrame) {
      return;
    }

    let needsPresent = shouldRecompute;

    if (this.transitionActive) {
      const rawT = (nowMs - this.transitionStartedAtMs) / Math.max(1, this.profile.transitionMs);
      const t = THREE.MathUtils.clamp(rawT, 0, 1);

      if (t >= 1) {
        this.alphaCurrent.set(this.alphaTarget);
        this.transitionActive = false;
      } else {
        for (let i = 0; i < this.alphaCurrent.length; i += 1) {
          const from = this.alphaTransitionFrom[i] ?? 0;
          const to = this.alphaTarget[i] ?? 0;
          this.alphaCurrent[i] = Math.round(from + (to - from) * t);
        }
      }

      needsPresent = true;
    }

    if (needsPresent) {
      this.presentAlpha(this.alphaCurrent);
    }
  }

  private presentAlpha(alphaValues: Uint8ClampedArray): void {
    const data = this.imageData.data;
    const darkAlpha255 = Math.round(this.profile.darkAlpha * 255);

    for (let i = 0; i < alphaValues.length; i += 1) {
      const offset = i * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = alphaValues[i] ?? darkAlpha255;
    }

    this.ctx.putImageData(this.imageData, 0, 0);
    this.texture.needsUpdate = true;
  }

  private collectOcclusionCandidates(
    originX: number,
    originZ: number,
    rangeMeters: number,
  ): readonly LevelStaticCollider[] {
    this.occlusionCandidates.length = 0;

    const paddedRange = rangeMeters + 0.75;
    const rangeSq = paddedRange * paddedRange;

    for (const collider of this.losColliders) {
      const nearestX = THREE.MathUtils.clamp(originX, collider.minX, collider.maxX);
      const nearestZ = THREE.MathUtils.clamp(originZ, collider.minZ, collider.maxZ);
      const dx = nearestX - originX;
      const dz = nearestZ - originZ;

      if (dx * dx + dz * dz <= rangeSq) {
        this.occlusionCandidates.push(collider);
      }
    }

    return this.occlusionCandidates;
  }

  private tuneUpdateInterval(lastComputeMs: number): void {
    if (!Number.isFinite(lastComputeMs) || lastComputeMs <= 0) {
      return;
    }

    const minInterval = this.profile.updateIntervalMs;
    const maxInterval = Math.round(this.profile.updateIntervalMs * 1.8);
    const budgetMs = this.profile.updateIntervalMs * 0.42;

    if (lastComputeMs > budgetMs) {
      this.dynamicUpdateIntervalMs = Math.min(
        maxInterval,
        this.dynamicUpdateIntervalMs * 1.1 + 1,
      );
      return;
    }

    this.dynamicUpdateIntervalMs = Math.max(
      minInterval,
      this.dynamicUpdateIntervalMs * 0.94 - 0.5,
    );
  }

  private applyBlurPasses(source: Uint8ClampedArray): Uint8ClampedArray {
    if (!this.profile.edgeBlurEnabled || this.profile.blurPasses <= 0) {
      return source;
    }

    let from = source;
    let to = source === this.alphaMask ? this.alphaBlurScratch : this.alphaMask;

    for (let pass = 0; pass < this.profile.blurPasses; pass += 1) {
      this.applyBoxBlur3x3(from, to);
      const nextFrom = to;
      to = from;
      from = nextFrom;
    }

    return from;
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
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }

  private precomputeWorldCoords(): void {
    const width = Math.max(0.001, this.bounds.maxX - this.bounds.minX);
    const depth = Math.max(0.001, this.bounds.maxZ - this.bounds.minZ);

    for (let py = 0; py < this.resolution; py += 1) {
      const v = (py + 0.5) / this.resolution;
      const worldZ = this.bounds.minZ + depth * v;

      for (let px = 0; px < this.resolution; px += 1) {
        const u = (px + 0.5) / this.resolution;
        const worldX = this.bounds.minX + width * u;
        const index = py * this.resolution + px;
        this.worldXByPixel[index] = worldX;
        this.worldZByPixel[index] = worldZ;
      }
    }
  }
}
