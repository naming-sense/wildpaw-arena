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
  backend: "cpu" | "stencil";
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
  stencilArcSegments: number;
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

interface StencilFogState {
  darkMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  maskMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  maskGeometry: THREE.BufferGeometry;
  maskPositions: Float32Array;
  maskPositionAttribute: THREE.BufferAttribute;
  segmentCount: number;
}

const LOS_PADDING = 0.02;

const QUALITY_PROFILES: Record<FogOfWarQuality, FogOfWarQualityProfile> = {
  low: {
    backend: "stencil",
    resolution: 128,
    updateIntervalMs: 100,
    moveUpdateThreshold: 0.12,
    yawUpdateThresholdRad: (2.5 * Math.PI) / 180,
    edgeBlurEnabled: false,
    occlusionEnabled: false,
    fovFeatherRad: (8 * Math.PI) / 180,
    rangeFeatherRatio: 0.18,
    darkAlpha: 0.64,
    visibleCenterAlpha: 0.05,
    visibleEdgeAlpha: 0.21,
    stencilArcSegments: 42,
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
    stencilArcSegments: 42,
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
    stencilArcSegments: 48,
  },
};

function isLosObstacle(collider: LevelStaticCollider): boolean {
  return collider.blocksLineOfSight || collider.blocksMovement || collider.blocksProjectile;
}

function profileForQuality(quality: FogOfWarQuality): FogOfWarQualityProfile {
  return QUALITY_PROFILES[quality] ?? QUALITY_PROFILES.medium;
}

export class FogOfWarOverlay {
  private readonly root = new THREE.Group();
  private readonly resolution: number;
  private readonly losColliders: readonly LevelStaticCollider[];
  private readonly bounds: FogOfWarBounds;
  private readonly profile: FogOfWarQualityProfile;
  private readonly cpuState: CpuFogState | null;
  private readonly stencilState: StencilFogState | null;

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

    if (this.profile.backend === "stencil") {
      this.stencilState = this.createStencilState();
      this.cpuState = null;
      this.root.add(this.stencilState.maskMesh, this.stencilState.darkMesh);
    } else {
      this.cpuState = this.createCpuState();
      this.stencilState = null;
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

    if (this.stencilState) {
      this.updateStencilVision(originX, originZ, yaw, rangeMeters, halfFovRad);
      return;
    }

    if (this.cpuState) {
      this.updateCpuVision(originX, originZ, yaw, rangeMeters, halfFovRad);
    }
  }

  private updateStencilVision(
    originX: number,
    originZ: number,
    yaw: number,
    rangeMeters: number,
    halfFovRad: number,
  ): void {
    const state = this.stencilState;
    if (!state) {
      return;
    }

    const y = 0.061;
    const positions = state.maskPositions;
    positions[0] = originX;
    positions[1] = y;
    positions[2] = originZ;

    const segmentCount = state.segmentCount;
    const start = yaw - halfFovRad;
    const span = halfFovRad * 2;

    for (let i = 0; i <= segmentCount; i += 1) {
      const t = i / segmentCount;
      const angle = start + span * t;
      const offset = (i + 1) * 3;
      positions[offset] = originX + Math.sin(angle) * rangeMeters;
      positions[offset + 1] = y;
      positions[offset + 2] = originZ + Math.cos(angle) * rangeMeters;
    }

    state.maskPositionAttribute.needsUpdate = true;
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

  private createStencilState(): StencilFogState {
    const width = Math.max(1, this.bounds.maxX - this.bounds.minX);
    const depth = Math.max(1, this.bounds.maxZ - this.bounds.minZ);

    const darkMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCoverage: { value: Math.max(0, Math.min(1, this.profile.darkAlpha)) },
      },
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;

        uniform float uCoverage;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          float n = hash12(floor(gl_FragCoord.xy));
          if (n > uCoverage) {
            discard;
          }
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        }
      `,
      transparent: false,
      depthWrite: false,
      depthTest: false,
    });
    darkMaterial.stencilWrite = true;
    darkMaterial.stencilRef = 1;
    darkMaterial.stencilFunc = THREE.NotEqualStencilFunc;
    darkMaterial.stencilFail = THREE.KeepStencilOp;
    darkMaterial.stencilZFail = THREE.KeepStencilOp;
    darkMaterial.stencilZPass = THREE.KeepStencilOp;

    const darkMesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), darkMaterial);
    darkMesh.rotation.x = -Math.PI / 2;
    darkMesh.position.set(
      (this.bounds.minX + this.bounds.maxX) * 0.5,
      0.06,
      (this.bounds.minZ + this.bounds.maxZ) * 0.5,
    );
    darkMesh.renderOrder = 20;

    const segmentCount = Math.max(8, this.profile.stencilArcSegments);
    const maskPositions = new Float32Array((segmentCount + 2) * 3);
    const maskPositionAttribute = new THREE.BufferAttribute(maskPositions, 3);

    const indices = new Uint16Array(segmentCount * 3);
    for (let i = 0; i < segmentCount; i += 1) {
      const offset = i * 3;
      indices[offset] = 0;
      indices[offset + 1] = i + 1;
      indices[offset + 2] = i + 2;
    }

    const maskGeometry = new THREE.BufferGeometry();
    maskGeometry.setAttribute("position", maskPositionAttribute);
    maskGeometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const maskMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      depthWrite: false,
      depthTest: false,
    });
    maskMaterial.colorWrite = false;
    maskMaterial.stencilWrite = true;
    maskMaterial.stencilRef = 1;
    maskMaterial.stencilFunc = THREE.AlwaysStencilFunc;
    maskMaterial.stencilFail = THREE.KeepStencilOp;
    maskMaterial.stencilZFail = THREE.KeepStencilOp;
    maskMaterial.stencilZPass = THREE.ReplaceStencilOp;

    const maskMesh = new THREE.Mesh(maskGeometry, maskMaterial);
    maskMesh.renderOrder = 19;
    maskMesh.frustumCulled = false;

    return {
      darkMesh,
      maskMesh,
      maskGeometry,
      maskPositions,
      maskPositionAttribute,
      segmentCount,
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

    if (this.stencilState) {
      this.stencilState.maskGeometry.dispose();
      this.stencilState.maskMesh.material.dispose();
      this.stencilState.darkMesh.geometry.dispose();
      this.stencilState.darkMesh.material.dispose();
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
