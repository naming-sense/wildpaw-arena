import * as THREE from "three";
import { segmentIntersectsCollider2D, type LevelStaticCollider } from "./levelCollision";

export interface FogOfWarBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface FogOfWarVisionParams {
  originX: number;
  originZ: number;
  yaw: number;
  rangeMeters: number;
  halfFovRad: number;
  nowMs: number;
}

const DEFAULT_RESOLUTION = 192;
const UPDATE_INTERVAL_MS = 120;
const MOVE_UPDATE_THRESHOLD = 0.2;
const YAW_UPDATE_THRESHOLD_RAD = (4 * Math.PI) / 180;
const LOS_PADDING = 0.02;
const EDGE_BLUR_ENABLED = true;
const DARK_ALPHA = 0.72;
const VISIBLE_CENTER_ALPHA = 0.05;
const VISIBLE_EDGE_ALPHA = 0.24;

function isLosObstacle(collider: LevelStaticCollider): boolean {
  return (
    collider.blocksLineOfSight ||
    collider.blocksMovement ||
    collider.blocksProjectile
  );
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
  private readonly resolution: number;
  private readonly losColliders: readonly LevelStaticCollider[];
  private readonly bounds: FogOfWarBounds;

  private lastUpdateMs = Number.NEGATIVE_INFINITY;
  private lastOriginX = Number.NaN;
  private lastOriginZ = Number.NaN;
  private lastYaw = Number.NaN;

  constructor(
    scene: THREE.Scene,
    bounds: FogOfWarBounds,
    colliders: readonly LevelStaticCollider[],
    resolution = DEFAULT_RESOLUTION,
  ) {
    this.bounds = bounds;
    this.resolution = Math.max(128, Math.min(512, Math.round(resolution)));
    this.losColliders = colliders.filter(isLosObstacle);

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
    // 바닥면에 밀착시켜 떠 있는 느낌/캐릭터 가림 현상을 방지한다.
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

    const shouldSkipByTime = nowMs - this.lastUpdateMs < UPDATE_INTERVAL_MS;
    const shouldSkipByMove = movedDistanceSq < MOVE_UPDATE_THRESHOLD * MOVE_UPDATE_THRESHOLD;
    const shouldSkipByYaw = yawDelta < YAW_UPDATE_THRESHOLD_RAD;
    if (shouldSkipByTime && shouldSkipByMove && shouldSkipByYaw) {
      return;
    }

    this.lastUpdateMs = nowMs;
    this.lastOriginX = originX;
    this.lastOriginZ = originZ;
    this.lastYaw = yaw;

    const data = this.imageData.data;
    const rangeSq = rangeMeters * rangeMeters;
    const cosHalfFov = Math.cos(halfFovRad);
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);

    const darkAlpha255 = Math.round(DARK_ALPHA * 255);
    const visibleCenterAlpha255 = Math.round(VISIBLE_CENTER_ALPHA * 255);
    const visibleEdgeAlpha255 = Math.round(VISIBLE_EDGE_ALPHA * 255);

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

    const finalAlpha = EDGE_BLUR_ENABLED
      ? this.applyBoxBlur3x3(this.alphaMask, this.alphaBlurScratch)
      : this.alphaMask;

    for (let i = 0; i < finalAlpha.length; i += 1) {
      const offset = i * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = finalAlpha[i] ?? darkAlpha255;
    }

    this.ctx.putImageData(this.imageData, 0, 0);
    this.texture.needsUpdate = true;
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

        // 가중치 [1 2 1; 2 4 2; 1 2 1] / 16
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
      // 캔버스 Y축(상→하)과 월드 Z축 투영을 맞춰 상/하 반전이 생기지 않도록 한다.
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
