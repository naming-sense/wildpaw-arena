import * as THREE from "three";
import { segmentIntersectsCollider2D, type LevelStaticCollider } from "./levelCollision";

export interface FogOfWarBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const DEFAULT_RESOLUTION = 192;
const UPDATE_INTERVAL_MS = 90;
const MOVE_UPDATE_THRESHOLD = 0.12;
const LOS_PADDING = 0.02;
const DARK_ALPHA = 0.74;
const VISIBLE_CENTER_ALPHA = 0.08;
const VISIBLE_EDGE_ALPHA = 0.28;

export class FogOfWarOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly imageData: ImageData;
  private readonly worldXByPixel: Float32Array;
  private readonly worldZByPixel: Float32Array;
  private readonly resolution: number;
  private readonly losColliders: readonly LevelStaticCollider[];
  private readonly bounds: FogOfWarBounds;

  private lastUpdateMs = Number.NEGATIVE_INFINITY;
  private lastOriginX = Number.NaN;
  private lastOriginZ = Number.NaN;

  constructor(
    scene: THREE.Scene,
    bounds: FogOfWarBounds,
    colliders: readonly LevelStaticCollider[],
    resolution = DEFAULT_RESOLUTION,
  ) {
    this.bounds = bounds;
    this.resolution = Math.max(96, Math.min(320, Math.round(resolution)));
    this.losColliders = colliders.filter((collider) => collider.blocksLineOfSight);

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
        depthTest: false,
      }),
    );

    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(
      (this.bounds.minX + this.bounds.maxX) * 0.5,
      3.8,
      (this.bounds.minZ + this.bounds.maxZ) * 0.5,
    );
    this.mesh.renderOrder = 9000;

    scene.add(this.mesh);
  }

  updateVision(originX: number, originZ: number, rangeMeters: number, nowMs: number): void {
    if (!Number.isFinite(originX) || !Number.isFinite(originZ)) {
      return;
    }

    if (!Number.isFinite(rangeMeters) || rangeMeters <= 0) {
      return;
    }

    const movedDistanceSq =
      (originX - this.lastOriginX) * (originX - this.lastOriginX) +
      (originZ - this.lastOriginZ) * (originZ - this.lastOriginZ);

    const shouldSkipByTime = nowMs - this.lastUpdateMs < UPDATE_INTERVAL_MS;
    const shouldSkipByMove = movedDistanceSq < MOVE_UPDATE_THRESHOLD * MOVE_UPDATE_THRESHOLD;
    if (shouldSkipByTime && shouldSkipByMove) {
      return;
    }

    this.lastUpdateMs = nowMs;
    this.lastOriginX = originX;
    this.lastOriginZ = originZ;

    const data = this.imageData.data;
    const rangeSq = rangeMeters * rangeMeters;

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
          const edgeT = Math.min(1, Math.sqrt(distSq) / Math.max(0.001, rangeMeters));
          alpha = Math.round(
            visibleCenterAlpha255 +
              (visibleEdgeAlpha255 - visibleCenterAlpha255) * edgeT,
          );
        }
      }

      const offset = i * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = alpha;
    }

    this.ctx.putImageData(this.imageData, 0, 0);
    this.texture.needsUpdate = true;
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
      const worldZ = this.bounds.maxZ - depth * v;

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
