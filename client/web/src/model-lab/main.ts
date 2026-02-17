import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createGltfLoader } from "../assets/loaders/gltfLoader";
import "./style.css";

interface AssetPreset {
  readonly label: string;
  readonly path: string;
}

interface StaticStats {
  readonly meshCount: number;
  readonly skinnedMeshCount: number;
  readonly boneCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly clipSummaries: readonly string[];
}

interface ModelLabUI {
  readonly canvas: HTMLCanvasElement;
  readonly presetSelect: HTMLSelectElement;
  readonly assetInput: HTMLInputElement;
  readonly loadButton: HTMLButtonElement;
  readonly clipSelect: HTMLSelectElement;
  readonly playPauseButton: HTMLButtonElement;
  readonly resetButton: HTMLButtonElement;
  readonly fitCameraButton: HTMLButtonElement;
  readonly speedRange: HTMLInputElement;
  readonly speedLabel: HTMLSpanElement;
  readonly timelineRange: HTMLInputElement;
  readonly timelineLabel: HTMLSpanElement;
  readonly loopCheckbox: HTMLInputElement;
  readonly skeletonCheckbox: HTMLInputElement;
  readonly wireframeCheckbox: HTMLInputElement;
  readonly gridCheckbox: HTMLInputElement;
  readonly axesCheckbox: HTMLInputElement;
  readonly boundsCheckbox: HTMLInputElement;
  readonly freezePositionCheckbox: HTMLInputElement;
  readonly statusOutput: HTMLDivElement;
  readonly statsOutput: HTMLPreElement;
  readonly logsOutput: HTMLPreElement;
}

const ASSET_PRESETS: readonly AssetPreset[] = [
  {
    label: "Current (mixamo-directrig-png)",
    path: "/assets/heroes/cat-soldier-variant-regen-50k-webp2k-safe-nogun-anim-pack-mixamo-directrig-png.glb",
  },
  {
    label: "static mesh (baseline)",
    path: "/assets/heroes/cat-soldier-mobile-blender-6k-webp512.glb",
  },
  {
    label: "legacy (scale1-top4-png)",
    path: "/assets/heroes/cat-soldier-mobile-blender-6k-webp512-anim-pack-inplace-scale1-top4-png.glb",
  },
  {
    label: "scale1-top4 (webp)",
    path: "/assets/heroes/cat-soldier-mobile-blender-6k-webp512-anim-pack-inplace-scale1-top4.glb",
  },
  {
    label: "scale1 (webp)",
    path: "/assets/heroes/cat-soldier-mobile-blender-6k-webp512-anim-pack-inplace-scale1.glb",
  },
  {
    label: "inplace (webp)",
    path: "/assets/heroes/cat-soldier-mobile-blender-6k-webp512-anim-pack-inplace.glb",
  },
];

const TARGET_MODEL_SIZE = 1.7;
const MAX_LOG_LINES = 120;

function requiredElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element as T;
}

function createTemplate(): string {
  const options = ASSET_PRESETS.map(
    (preset) => `<option value="${preset.path}">${preset.label}</option>`,
  ).join("");

  return `
    <div class="lab-shell">
      <aside class="lab-panel">
        <h1>Wildpaw Model Lab</h1>
        <p class="lab-subtitle">모델/애니메이션 자산만 분리 검증하는 전용 페이지</p>
        <div id="status-output" class="lab-status">Ready</div>

        <label class="lab-label" for="preset-select">Preset</label>
        <select id="preset-select">${options}</select>

        <label class="lab-label" for="asset-input">GLB Path</label>
        <input id="asset-input" type="text" spellcheck="false" />

        <div class="lab-row">
          <button id="load-button" type="button">Load Asset</button>
          <button id="fit-camera-button" type="button">Fit Camera</button>
        </div>

        <label class="lab-label" for="clip-select">Clip</label>
        <select id="clip-select"></select>

        <div class="lab-row">
          <button id="play-pause-button" type="button">Pause</button>
          <button id="reset-button" type="button">Reset</button>
        </div>

        <label class="lab-label" for="speed-range">Speed <span id="speed-label">1.00x</span></label>
        <input id="speed-range" type="range" min="0" max="2" step="0.05" value="1" />

        <label class="lab-label" for="timeline-range">Timeline <span id="timeline-label">0.00s / 0.00s</span></label>
        <input id="timeline-range" type="range" min="0" max="0" step="0.001" value="0" />

        <div class="lab-options">
          <label><input id="loop-checkbox" type="checkbox" checked /> Loop</label>
          <label><input id="skeleton-checkbox" type="checkbox" /> Skeleton</label>
          <label><input id="wireframe-checkbox" type="checkbox" /> Wireframe</label>
          <label><input id="grid-checkbox" type="checkbox" checked /> Grid</label>
          <label><input id="axes-checkbox" type="checkbox" checked /> Axes</label>
          <label><input id="bounds-checkbox" type="checkbox" /> Bounds</label>
          <label><input id="freeze-position-checkbox" type="checkbox" checked /> Freeze *.position tracks</label>
        </div>

        <section class="lab-section">
          <h2>Diagnostics</h2>
          <pre id="stats-output"></pre>
        </section>

        <section class="lab-section">
          <h2>Logs</h2>
          <pre id="logs-output"></pre>
        </section>
      </aside>

      <main class="lab-viewport">
        <canvas id="lab-canvas"></canvas>
      </main>
    </div>
  `;
}

class ModelLabApp {
  private readonly ui: ModelLabUI;
  private readonly loader = createGltfLoader();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 300);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly grid = new THREE.GridHelper(16, 16, 0x5c6572, 0x2a3139);
  private readonly axes = new THREE.AxesHelper(1.5);
  private readonly modelBox = new THREE.Box3();
  private readonly frameCenter = new THREE.Vector3();
  private readonly frameSize = new THREE.Vector3();
  private readonly modelCenter = new THREE.Vector3();
  private readonly cameraDir = new THREE.Vector3();

  private rafId = 0;
  private isTimelineDragging = false;
  private isPlaying = true;

  private currentGltf: GLTF | null = null;
  private modelRoot: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private activeAction: THREE.AnimationAction | null = null;
  private clipSourceMap = new Map<string, THREE.AnimationClip>();
  private clipVariantCache = new Map<string, THREE.AnimationClip>();
  private skeletonHelpers: THREE.SkeletonHelper[] = [];
  private boundsHelper: THREE.Box3Helper | null = null;
  private staticStats: StaticStats | null = null;

  private frameCounter = 0;
  private fps = 0;
  private fpsWindowStart = performance.now();
  private lastStatsUpdate = 0;
  private readonly logs: string[] = [];

  constructor(root: HTMLElement) {
    root.innerHTML = createTemplate();

    this.ui = {
      canvas: requiredElement<HTMLCanvasElement>(root, "#lab-canvas"),
      presetSelect: requiredElement<HTMLSelectElement>(root, "#preset-select"),
      assetInput: requiredElement<HTMLInputElement>(root, "#asset-input"),
      loadButton: requiredElement<HTMLButtonElement>(root, "#load-button"),
      clipSelect: requiredElement<HTMLSelectElement>(root, "#clip-select"),
      playPauseButton: requiredElement<HTMLButtonElement>(root, "#play-pause-button"),
      resetButton: requiredElement<HTMLButtonElement>(root, "#reset-button"),
      fitCameraButton: requiredElement<HTMLButtonElement>(root, "#fit-camera-button"),
      speedRange: requiredElement<HTMLInputElement>(root, "#speed-range"),
      speedLabel: requiredElement<HTMLSpanElement>(root, "#speed-label"),
      timelineRange: requiredElement<HTMLInputElement>(root, "#timeline-range"),
      timelineLabel: requiredElement<HTMLSpanElement>(root, "#timeline-label"),
      loopCheckbox: requiredElement<HTMLInputElement>(root, "#loop-checkbox"),
      skeletonCheckbox: requiredElement<HTMLInputElement>(root, "#skeleton-checkbox"),
      wireframeCheckbox: requiredElement<HTMLInputElement>(root, "#wireframe-checkbox"),
      gridCheckbox: requiredElement<HTMLInputElement>(root, "#grid-checkbox"),
      axesCheckbox: requiredElement<HTMLInputElement>(root, "#axes-checkbox"),
      boundsCheckbox: requiredElement<HTMLInputElement>(root, "#bounds-checkbox"),
      freezePositionCheckbox: requiredElement<HTMLInputElement>(root, "#freeze-position-checkbox"),
      statusOutput: requiredElement<HTMLDivElement>(root, "#status-output"),
      statsOutput: requiredElement<HTMLPreElement>(root, "#stats-output"),
      logsOutput: requiredElement<HTMLPreElement>(root, "#logs-output"),
    };

    this.assetInputSync();
    this.setStatus("Ready", "info");

    this.scene.background = new THREE.Color(0x10131a);
    this.grid.position.y = 0;
    this.axes.position.y = 0.01;
    this.scene.add(this.grid, this.axes);

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x1d1d24, 0.8);
    const directional = new THREE.DirectionalLight(0xffffff, 1.1);
    directional.position.set(5, 8, 4);
    directional.castShadow = true;
    this.scene.add(hemisphere, directional);

    this.camera.position.set(2.1, 1.6, 2.4);
    this.camera.lookAt(0, 0.8, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.ui.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;

    this.controls = new OrbitControls(this.camera, this.ui.canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.8, 0);
    this.controls.update();

    this.bindEvents();
    this.handleResize();
    this.startRenderLoop();

    const initialAsset = this.ui.assetInput.value.trim();
    void this.loadAsset(initialAsset);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.clearCurrentModel();
    this.controls.dispose();
    this.renderer.dispose();
    window.removeEventListener("resize", this.handleResize);
  }

  private readonly handleResize = (): void => {
    const viewport = this.ui.canvas.parentElement;
    if (!viewport) return;

    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private bindEvents(): void {
    this.ui.presetSelect.addEventListener("change", () => {
      this.assetInputSync();
      void this.loadAsset(this.ui.assetInput.value.trim());
    });

    this.ui.loadButton.addEventListener("click", () => {
      void this.loadAsset(this.ui.assetInput.value.trim());
    });

    this.ui.assetInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.loadAsset(this.ui.assetInput.value.trim());
    });

    this.ui.clipSelect.addEventListener("change", () => {
      const clipName = this.ui.clipSelect.value;
      this.playClipByName(clipName, true);
    });

    this.ui.playPauseButton.addEventListener("click", () => {
      this.setPlaying(!this.isPlaying);
    });

    this.ui.resetButton.addEventListener("click", () => this.resetTimeline());
    this.ui.fitCameraButton.addEventListener("click", () => this.fitCameraToModel());

    this.ui.speedRange.addEventListener("input", () => {
      this.ui.speedLabel.textContent = `${this.playbackSpeed.toFixed(2)}x`;
    });

    this.ui.timelineRange.addEventListener("pointerdown", () => {
      this.isTimelineDragging = true;
    });
    this.ui.timelineRange.addEventListener("pointerup", () => {
      this.isTimelineDragging = false;
    });
    this.ui.timelineRange.addEventListener("input", () => {
      const targetTime = Number(this.ui.timelineRange.value);
      this.seekTo(targetTime);
    });

    this.ui.loopCheckbox.addEventListener("change", () => this.applyLoopMode());
    this.ui.skeletonCheckbox.addEventListener("change", () => this.updateSkeletonVisibility());
    this.ui.wireframeCheckbox.addEventListener("change", () => this.updateWireframe());
    this.ui.gridCheckbox.addEventListener("change", () => {
      this.grid.visible = this.ui.gridCheckbox.checked;
    });
    this.ui.axesCheckbox.addEventListener("change", () => {
      this.axes.visible = this.ui.axesCheckbox.checked;
    });
    this.ui.boundsCheckbox.addEventListener("change", () => this.updateBoundsHelperVisibility());

    this.ui.freezePositionCheckbox.addEventListener("change", () => {
      this.clipVariantCache.clear();
      const selected = this.ui.clipSelect.value;
      this.playClipByName(selected, true);
      this.log(`Freeze position tracks: ${this.ui.freezePositionCheckbox.checked ? "ON" : "OFF"}`);
    });

    window.addEventListener("resize", this.handleResize);
  }

  private assetInputSync(): void {
    this.ui.assetInput.value = this.ui.presetSelect.value || ASSET_PRESETS[0]!.path;
  }

  private startRenderLoop(): void {
    const step = () => {
      this.rafId = requestAnimationFrame(step);

      const now = performance.now();
      const delta = this.clock.getDelta();
      if (this.mixer && this.isPlaying) {
        this.mixer.update(delta * this.playbackSpeed);
      }

      if (!this.isTimelineDragging) {
        this.syncTimelineFromAction();
      }

      if (this.boundsHelper && this.modelRoot) {
        this.boundsHelper.box.setFromObject(this.modelRoot);
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);

      this.frameCounter += 1;
      if (now - this.fpsWindowStart >= 500) {
        this.fps = (this.frameCounter * 1000) / (now - this.fpsWindowStart);
        this.fpsWindowStart = now;
        this.frameCounter = 0;
      }

      if (now - this.lastStatsUpdate >= 180) {
        this.lastStatsUpdate = now;
        this.updateStatsPanel();
      }
    };

    this.setPlaying(true);
    this.rafId = requestAnimationFrame(step);
  }

  private async loadAsset(path: string): Promise<void> {
    if (!path) {
      this.log("Asset path is empty.", "error");
      this.setStatus("Asset path is empty.", "error");
      return;
    }

    const startMs = performance.now();
    this.ui.loadButton.disabled = true;
    this.setStatus(`Loading: ${path}`, "info");
    this.log(`Loading ${path} ...`);

    this.clearCurrentModel();

    try {
      const gltf = await this.loader.loadAsync(path);
      this.currentGltf = gltf;
      this.modelRoot = this.prepareModelRoot(gltf.scene);
      this.scene.add(this.modelRoot);

      this.mixer = new THREE.AnimationMixer(this.modelRoot);
      this.clipSourceMap = this.createClipSourceMap(gltf.animations);
      this.clipVariantCache.clear();
      this.populateClipSelect();
      this.captureStaticStats();

      this.updateWireframe();
      this.createSkeletonHelpers();
      this.updateBoundsHelperVisibility();
      this.fitCameraToModel();

      const preferredClip = this.clipSourceMap.has("Idle") ? "Idle" : this.ui.clipSelect.value;
      this.playClipByName(preferredClip, true);
      this.setPlaying(false);

      const elapsedMs = Math.round(performance.now() - startMs);
      this.setStatus(`Loaded (${elapsedMs} ms): ${path}`, "ok");
      this.log(`Loaded: ${path}`);
    } catch (error) {
      this.log(`Load failed: ${String(error)}`, "error");
      this.setStatus(`Load failed: ${String(error)}`, "error");
      this.ui.clipSelect.innerHTML = "";
      this.staticStats = null;
      this.updateTimelineLabel(0, 0);
    } finally {
      this.ui.loadButton.disabled = false;
    }
  }

  private clearCurrentModel(): void {
    if (this.boundsHelper) {
      this.scene.remove(this.boundsHelper);
      this.boundsHelper.geometry.dispose();
      (this.boundsHelper.material as THREE.Material).dispose();
      this.boundsHelper = null;
    }

    for (const helper of this.skeletonHelpers) {
      this.scene.remove(helper);
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    this.skeletonHelpers = [];

    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.modelRoot ?? this.scene);
    }

    if (this.modelRoot) {
      this.scene.remove(this.modelRoot);
      this.disposeObjectResources(this.modelRoot);
    }

    this.currentGltf = null;
    this.modelRoot = null;
    this.mixer = null;
    this.activeAction = null;
    this.staticStats = null;
    this.clipSourceMap.clear();
    this.clipVariantCache.clear();
    this.ui.clipSelect.innerHTML = "";
    this.updateTimelineLabel(0, 0);
  }

  private prepareModelRoot(source: THREE.Object3D): THREE.Object3D {
    const model = source;
    const helperMeshes: THREE.Object3D[] = [];

    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;

      const lowered = mesh.name.toLowerCase();
      if (lowered.startsWith("ico") || lowered.includes("helper")) {
        helperMeshes.push(mesh);
        return;
      }

      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    });

    for (const helper of helperMeshes) {
      helper.parent?.remove(helper);
    }

    this.modelBox.setFromObject(model);
    const size = this.modelBox.getSize(this.frameSize);
    const measuredSize = Math.max(size.x, size.y, size.z);
    if (measuredSize > 1e-4) {
      const scale = THREE.MathUtils.clamp(TARGET_MODEL_SIZE / measuredSize, 0.2, 25);
      model.scale.setScalar(scale);
    }

    this.modelCenter.set(0, 0, 0);
    model.position.set(0, 0, 0);

    return model;
  }

  private createClipSourceMap(clips: readonly THREE.AnimationClip[]): Map<string, THREE.AnimationClip> {
    const result = new Map<string, THREE.AnimationClip>();
    let unnamedCounter = 1;

    for (const clip of clips) {
      const baseName = clip.name.trim() || `Clip_${unnamedCounter++}`;
      let resolved = baseName;
      let suffix = 1;
      while (result.has(resolved)) {
        suffix += 1;
        resolved = `${baseName}_${suffix}`;
      }

      if (resolved !== clip.name) {
        const renamed = clip.clone();
        renamed.name = resolved;
        result.set(resolved, renamed);
      } else {
        result.set(resolved, clip);
      }
    }

    return result;
  }

  private populateClipSelect(): void {
    const names = [...this.clipSourceMap.keys()];
    this.ui.clipSelect.innerHTML = "";

    if (names.length === 0) {
      const fallbackOption = document.createElement("option");
      fallbackOption.value = "";
      fallbackOption.textContent = "(no animation clips)";
      this.ui.clipSelect.appendChild(fallbackOption);
      this.ui.clipSelect.disabled = true;
      this.setPlaying(false);
      return;
    }

    this.ui.clipSelect.disabled = false;
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      this.ui.clipSelect.appendChild(option);
    }
  }

  private get playbackSpeed(): number {
    return Number(this.ui.speedRange.value);
  }

  private buildClipVariant(clipName: string): THREE.AnimationClip | null {
    const source = this.clipSourceMap.get(clipName);
    if (!source) return null;

    const freezeEnabled = this.ui.freezePositionCheckbox.checked;
    const cacheKey = `${clipName}::freeze=${freezeEnabled ? "1" : "0"}`;
    const cached = this.clipVariantCache.get(cacheKey);
    if (cached) return cached;

    if (!freezeEnabled) {
      this.clipVariantCache.set(cacheKey, source);
      return source;
    }

    const clone = source.clone();
    const frozenTracks = clone.tracks.map((track) => {
      if (!(track instanceof THREE.VectorKeyframeTrack)) {
        return track;
      }
      if (!track.name.endsWith(".position")) {
        return track;
      }

      const values = track.values.slice();
      if (values.length < 3) {
        return track;
      }

      const baseX = values[0]!;
      const baseY = values[1]!;
      const baseZ = values[2]!;

      for (let i = 0; i + 2 < values.length; i += 3) {
        values[i] = baseX;
        values[i + 1] = baseY;
        values[i + 2] = baseZ;
      }

      return new THREE.VectorKeyframeTrack(
        track.name,
        track.times.slice(),
        values,
        track.getInterpolation(),
      );
    });

    const frozenClip = new THREE.AnimationClip(clone.name, clone.duration, frozenTracks).optimize();
    this.clipVariantCache.set(cacheKey, frozenClip);
    return frozenClip;
  }

  private recenterAnimatedModelRoot(): void {
    if (!this.modelRoot) return;

    this.modelBox.setFromObject(this.modelRoot);
    if (this.modelBox.isEmpty()) return;

    this.modelBox.getCenter(this.frameCenter);

    const footAnchor = this.sampleFootAnchor(this.modelRoot);
    if (footAnchor) {
      // Pivot target: midpoint between both feet on ground.
      this.modelRoot.position.x -= footAnchor.x;
      this.modelRoot.position.y -= footAnchor.y;
      this.modelRoot.position.z -= footAnchor.z;
      return;
    }

    this.modelRoot.position.x -= this.frameCenter.x;
    this.modelRoot.position.z -= this.frameCenter.z;
    this.modelRoot.position.y -= this.modelBox.min.y;
  }

  private sampleFootAnchor(root: THREE.Object3D): THREE.Vector3 | null {
    const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

    const temp = new THREE.Vector3();
    let minY = Number.POSITIVE_INFINITY;

    const leftAccum = new THREE.Vector3();
    const rightAccum = new THREE.Vector3();
    let leftCount = 0;
    let rightCount = 0;

    let anySumX = 0;
    let anySumZ = 0;
    let anyCount = 0;

    root.updateMatrixWorld(true);
    root.traverse((node) => {
      const skinned = node as THREE.SkinnedMesh;
      if (!skinned.isSkinnedMesh) return;

      for (const bone of skinned.skeleton.bones) {
        const n = normalize(bone.name);
        const isLeftFoot = n.includes("leftfoot");
        const isRightFoot = n.includes("rightfoot");
        const isToe = n.includes("toebase") || n.includes("toeend") || n.endsWith("toe");
        const isFootLike = isLeftFoot || isRightFoot || isToe;
        if (!isFootLike) continue;

        bone.getWorldPosition(temp);
        minY = Math.min(minY, temp.y);

        anySumX += temp.x;
        anySumZ += temp.z;
        anyCount += 1;

        if (isLeftFoot) {
          leftAccum.add(temp);
          leftCount += 1;
        }
        if (isRightFoot) {
          rightAccum.add(temp);
          rightCount += 1;
        }
      }
    });

    if (!Number.isFinite(minY) || anyCount === 0) {
      return null;
    }

    let anchorX: number;
    let anchorZ: number;

    if (leftCount > 0 && rightCount > 0) {
      const left = leftAccum.multiplyScalar(1 / leftCount);
      const right = rightAccum.multiplyScalar(1 / rightCount);
      anchorX = (left.x + right.x) * 0.5;
      anchorZ = (left.z + right.z) * 0.5;
    } else {
      anchorX = anySumX / anyCount;
      anchorZ = anySumZ / anyCount;
    }

    return new THREE.Vector3(anchorX, minY, anchorZ);
  }

  private sampleNamedBonePosition(root: THREE.Object3D, names: readonly string[]): THREE.Vector3 | null {
    const wanted = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const temp = new THREE.Vector3();

    root.updateMatrixWorld(true);
    let found: THREE.Vector3 | null = null;

    root.traverse((node) => {
      if (found) return;
      const skinned = node as THREE.SkinnedMesh;
      if (!skinned.isSkinnedMesh) return;

      for (const bone of skinned.skeleton.bones) {
        const norm = bone.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!wanted.some((w) => norm.includes(w))) continue;
        bone.getWorldPosition(temp);
        found = temp.clone();
        break;
      }
    });

    return found;
  }

  private playClipByName(clipName: string, resetTime: boolean): void {
    if (!this.mixer || !clipName) {
      return;
    }

    const clip = this.buildClipVariant(clipName);
    if (!clip) {
      return;
    }

    this.mixer.stopAllAction();

    const action = this.mixer.clipAction(clip);
    action.enabled = true;
    action.clampWhenFinished = !this.ui.loopCheckbox.checked;
    action.setLoop(this.ui.loopCheckbox.checked ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.reset();

    if (!resetTime && this.activeAction) {
      action.time = THREE.MathUtils.clamp(this.activeAction.time, 0, clip.duration);
    }

    action.play();
    this.activeAction = action;
    this.ui.clipSelect.value = clip.name;
    this.ui.timelineRange.max = clip.duration.toString();

    // Recenter based on animated pose so clip starts near world origin.
    this.mixer.update(0);
    this.recenterAnimatedModelRoot();

    this.setPlaying(true);
    this.syncTimelineFromAction();
  }

  private resetTimeline(): void {
    this.seekTo(0);
    this.setPlaying(false);
  }

  private seekTo(timeSeconds: number): void {
    if (!this.mixer || !this.activeAction) return;

    const duration = Math.max(0.0001, this.activeAction.getClip().duration);
    const clamped = THREE.MathUtils.clamp(timeSeconds, 0, duration);
    this.activeAction.time = clamped;
    this.mixer.setTime(clamped);
    this.ui.timelineRange.value = clamped.toFixed(3);
    this.updateTimelineLabel(clamped, duration);
  }

  private syncTimelineFromAction(): void {
    if (!this.activeAction) {
      this.updateTimelineLabel(0, 0);
      this.ui.timelineRange.value = "0";
      return;
    }

    const clipDuration = this.activeAction.getClip().duration;
    const safeDuration = Math.max(0.0001, clipDuration);
    const clipTime = this.ui.loopCheckbox.checked
      ? ((this.activeAction.time % safeDuration) + safeDuration) % safeDuration
      : THREE.MathUtils.clamp(this.activeAction.time, 0, safeDuration);

    this.ui.timelineRange.max = safeDuration.toString();
    this.ui.timelineRange.value = clipTime.toFixed(3);
    this.updateTimelineLabel(clipTime, safeDuration);
  }

  private applyLoopMode(): void {
    if (!this.activeAction) return;

    const shouldLoop = this.ui.loopCheckbox.checked;
    this.activeAction.clampWhenFinished = !shouldLoop;
    this.activeAction.setLoop(shouldLoop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  }

  private setPlaying(next: boolean): void {
    this.isPlaying = next;
    this.ui.playPauseButton.textContent = next ? "Pause" : "Play";
  }

  private createSkeletonHelpers(): void {
    for (const helper of this.skeletonHelpers) {
      this.scene.remove(helper);
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    this.skeletonHelpers = [];

    if (!this.modelRoot) return;

    this.modelRoot.traverse((node) => {
      const skinned = node as THREE.SkinnedMesh;
      if (!skinned.isSkinnedMesh) return;

      const helper = new THREE.SkeletonHelper(skinned);
      helper.visible = this.ui.skeletonCheckbox.checked;
      this.scene.add(helper);
      this.skeletonHelpers.push(helper);
    });
  }

  private updateSkeletonVisibility(): void {
    const visible = this.ui.skeletonCheckbox.checked;
    for (const helper of this.skeletonHelpers) {
      helper.visible = visible;
    }
  }

  private updateWireframe(): void {
    if (!this.modelRoot) return;

    const wireframe = this.ui.wireframeCheckbox.checked;
    this.modelRoot.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;

      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) {
          (material as THREE.MeshStandardMaterial).wireframe = wireframe;
        }
      } else {
        (mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
      }
    });
  }

  private updateBoundsHelperVisibility(): void {
    const shouldShow = this.ui.boundsCheckbox.checked;
    if (!this.modelRoot) {
      return;
    }

    if (shouldShow) {
      if (!this.boundsHelper) {
        this.modelBox.setFromObject(this.modelRoot);
        this.boundsHelper = new THREE.Box3Helper(this.modelBox.clone(), 0x44b3ff);
        this.scene.add(this.boundsHelper);
      }
      this.boundsHelper.visible = true;
      return;
    }

    if (this.boundsHelper) {
      this.boundsHelper.visible = false;
    }
  }

  private fitCameraToModel(): void {
    if (!this.modelRoot) return;

    this.modelBox.setFromObject(this.modelRoot);
    if (this.modelBox.isEmpty()) return;

    this.modelBox.getCenter(this.frameCenter);
    this.modelBox.getSize(this.frameSize);

    const radius = Math.max(this.frameSize.length() * 0.45, 0.3);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = Math.max(radius / Math.tan(fov * 0.5), 0.9);

    this.cameraDir.set(1, 0.8, 1).normalize();
    this.camera.position.copy(this.frameCenter).addScaledVector(this.cameraDir, distance * 1.15);
    this.controls.target.copy(this.frameCenter);
    this.controls.update();
  }

  private captureStaticStats(): void {
    if (!this.modelRoot) {
      this.staticStats = null;
      return;
    }

    let meshCount = 0;
    let skinnedMeshCount = 0;
    let vertexCount = 0;
    let triangleCount = 0;
    const bones = new Set<THREE.Bone>();

    this.modelRoot.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;

      meshCount += 1;
      const position = mesh.geometry.getAttribute("position");
      if (position) {
        vertexCount += position.count;
        triangleCount += mesh.geometry.index ? Math.floor(mesh.geometry.index.count / 3) : Math.floor(position.count / 3);
      }

      const skinned = node as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) {
        skinnedMeshCount += 1;
        for (const bone of skinned.skeleton.bones) {
          bones.add(bone);
        }
      }
    });

    const clipSummaries = [...this.clipSourceMap.values()].map(
      (clip) => `${clip.name} (${clip.duration.toFixed(2)}s)`,
    );

    this.staticStats = {
      meshCount,
      skinnedMeshCount,
      boneCount: bones.size,
      vertexCount,
      triangleCount,
      clipSummaries,
    };
  }

  private updateStatsPanel(): void {
    const lines: string[] = [];

    lines.push(`fps: ${this.fps.toFixed(1)}`);
    lines.push(`playing: ${this.isPlaying ? "yes" : "no"} @ ${this.playbackSpeed.toFixed(2)}x`);

    if (this.activeAction) {
      const clip = this.activeAction.getClip();
      const currentTime = THREE.MathUtils.clamp(this.activeAction.time, 0, clip.duration);
      lines.push(`active clip: ${clip.name} (${currentTime.toFixed(2)}s / ${clip.duration.toFixed(2)}s)`);
    } else {
      lines.push("active clip: (none)");
    }

    if (this.currentGltf) {
      lines.push(`raw clip count: ${this.currentGltf.animations.length}`);
    }

    if (this.staticStats) {
      lines.push("");
      lines.push(`[mesh stats]`);
      lines.push(`mesh: ${this.staticStats.meshCount}`);
      lines.push(`skinned mesh: ${this.staticStats.skinnedMeshCount}`);
      lines.push(`bones: ${this.staticStats.boneCount}`);
      lines.push(`vertices: ${this.staticStats.vertexCount.toLocaleString()}`);
      lines.push(`triangles: ${this.staticStats.triangleCount.toLocaleString()}`);
      lines.push(`clips: ${this.staticStats.clipSummaries.length}`);
      for (const summary of this.staticStats.clipSummaries) {
        lines.push(`  - ${summary}`);
      }
    }

    if (this.modelRoot) {
      this.modelBox.setFromObject(this.modelRoot);
      if (!this.modelBox.isEmpty()) {
        this.modelBox.getSize(this.frameSize);
        this.modelBox.getCenter(this.frameCenter);
        const centerDistance = this.frameCenter.length();
        lines.push("");
        lines.push(`[bounds]`);
        lines.push(
          `size: ${this.frameSize.x.toFixed(3)}, ${this.frameSize.y.toFixed(3)}, ${this.frameSize.z.toFixed(3)}`,
        );
        lines.push(
          `center: ${this.frameCenter.x.toFixed(3)}, ${this.frameCenter.y.toFixed(3)}, ${this.frameCenter.z.toFixed(3)} (dist ${centerDistance.toFixed(3)})`,
        );

        const footAnchor = this.sampleFootAnchor(this.modelRoot);
        const hips = this.sampleNamedBonePosition(this.modelRoot, ["mixamorig:Hips", "Hips", "hips"]);
        const leftFoot = this.sampleNamedBonePosition(this.modelRoot, ["mixamorig:LeftFoot", "LeftFoot"]);
        const rightFoot = this.sampleNamedBonePosition(this.modelRoot, ["mixamorig:RightFoot", "RightFoot"]);

        lines.push("");
        lines.push("[origin overlay]");
        lines.push(
          `root pos: ${this.modelRoot.position.x.toFixed(3)}, ${this.modelRoot.position.y.toFixed(3)}, ${this.modelRoot.position.z.toFixed(3)}`,
        );
        if (footAnchor) {
          lines.push(
            `foot anchor(world): ${footAnchor.x.toFixed(3)}, ${footAnchor.y.toFixed(3)}, ${footAnchor.z.toFixed(3)}`,
          );
        } else {
          lines.push("foot anchor(world): (not found)");
        }
        if (hips) {
          lines.push(`hips(world): ${hips.x.toFixed(3)}, ${hips.y.toFixed(3)}, ${hips.z.toFixed(3)}`);
        }
        if (leftFoot) {
          lines.push(`leftFoot(world): ${leftFoot.x.toFixed(3)}, ${leftFoot.y.toFixed(3)}, ${leftFoot.z.toFixed(3)}`);
        }
        if (rightFoot) {
          lines.push(`rightFoot(world): ${rightFoot.x.toFixed(3)}, ${rightFoot.y.toFixed(3)}, ${rightFoot.z.toFixed(3)}`);
        }
      }
    }

    this.ui.statsOutput.textContent = lines.join("\n");
  }

  private updateTimelineLabel(current: number, duration: number): void {
    this.ui.timelineLabel.textContent = `${current.toFixed(2)}s / ${duration.toFixed(2)}s`;
  }

  private log(message: string, level: "info" | "error" = "info"): void {
    const timestamp = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    const head = level === "error" ? "ERR" : "INFO";
    this.logs.push(`[${timestamp}] ${head} ${message}`);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }
    this.ui.logsOutput.textContent = this.logs.join("\n");
    this.ui.logsOutput.scrollTop = this.ui.logsOutput.scrollHeight;
  }

  private setStatus(message: string, tone: "info" | "ok" | "error" = "info"): void {
    this.ui.statusOutput.textContent = message;
    this.ui.statusOutput.dataset.tone = tone;
  }

  private disposeObjectResources(object3d: THREE.Object3D): void {
    object3d.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;

      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) {
          material.dispose();
        }
      } else {
        mesh.material.dispose();
      }
    });
  }
}

const root = document.getElementById("model-lab-root");
if (!root) {
  throw new Error("#model-lab-root not found");
}

let app: ModelLabApp | null = null;
try {
  app = new ModelLabApp(root);
} catch (error) {
  root.textContent = `Model Lab failed to start: ${String(error)}`;
}

window.addEventListener("beforeunload", () => {
  app?.dispose();
});
