import * as THREE from "three";
import { createRuntimeConfig } from "../core/config/runtimeConfig";
import { FixedStepRunner } from "../core/time/fixedStep";
import { CommandBuffer } from "../input/commandBuffer";
import { KeyboardMouseInput } from "../input/keyboardMouse";
import { resolveAimOnGround } from "../input/aim";
import { World, type EntityId } from "../ecs/world";
import type { RenderAnimationState } from "../ecs/components";
import {
  AnimationSystem,
  BuffDebuffSystem,
  CollisionSystem,
  InputSystem,
  MovementSystem,
  ProjectileSystem,
  SkillSystem,
  WeaponFireSystem,
} from "../ecs/systems";
import { createSceneRoot } from "../render/sceneRoot";
import { GameRenderer } from "../render/renderer";
import { createMainLights } from "../render/lights";
import { CameraRig } from "../render/cameraRig";
import { RealtimeSocketClient } from "../net/socketClient";
import { SnapshotInterpolationBuffer } from "../net/interpolation/snapshotInterpolationBuffer";
import { reconcileLocalState } from "../net/reconciliation/reconcile";
import type { NetworkPlayerState, WorldSnapshot } from "../net/protocol/schemas";
import { PerfTracker } from "../debug/perfOverlay";
import { NetMetricsTracker } from "../debug/netOverlay";
import { ReplayLogger } from "../debug/replay/replayLogger";
import { useUiStore } from "../ui/store/useUiStore";
import { createGltfLoader } from "../assets/loaders/gltfLoader";
import { HERO_ASSET_MANIFEST, type HeroAssetManifest } from "../assets/manifests/heroes";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

interface GameAppOptions {
  wsUrl?: string;
}

const HERO_MOVE_ANIM_THRESHOLD = 0.15;
const LOCAL_MODE_STATE = "Local (No Server)";
const LOCAL_MARKER_COLOR = 0x4ad8ff;

export class GameApp {
  private readonly config = createRuntimeConfig();
  private readonly world = new World();
  private readonly fixedStep = new FixedStepRunner(this.config.simulation.fixedDtMs);
  private readonly input: KeyboardMouseInput;
  private readonly commands = new CommandBuffer();

  private readonly sceneRoot = createSceneRoot();
  private readonly renderer: GameRenderer;
  private readonly cameraRig: CameraRig;

  private readonly socket: RealtimeSocketClient;
  private readonly hasRealtimeServer: boolean;
  private readonly interpolationBuffer = new SnapshotInterpolationBuffer(
    this.config.net.interpolationDelayMs,
    this.config.net.maxExtrapolationMs,
  );

  private readonly perf = new PerfTracker();
  private readonly netMetrics = new NetMetricsTracker();
  private readonly replay = new ReplayLogger();
  private readonly gltfLoader = createGltfLoader();
  private readonly localHeroAsset: HeroAssetManifest =
    HERO_ASSET_MANIFEST.find((hero) => hero.heroId === "whitecat_commando") ?? {
      heroId: "whitecat_commando",
      gltfPath: "/assets/heroes/cat-soldier-variant-regen-50k-webp2k-safe-nogun-anim-pack-mixamo-directrig-png.glb",
      idleClip: "Idle",
      walkClip: "Walk",
      runClip: "Run",
    };
  private readonly localHeroAssetPath = this.localHeroAsset.gltfPath;

  private readonly remoteEntities = new Map<number, EntityId>();
  private localPlayerEntityId: EntityId;
  private localNetworkPlayerId = 1;
  private running = false;
  private rafId = 0;
  private lastFrameMs = 0;
  private lastPingAt = 0;
  private lastInputSentAt = Number.NEGATIVE_INFINITY;
  private serverTimeOffsetMs = 0;
  private hasServerTimeOffset = false;

  constructor(
    canvas: HTMLCanvasElement,
    options: GameAppOptions,
  ) {
    this.renderer = new GameRenderer(canvas, this.config.render.shadowMapSize);
    this.cameraRig = new CameraRig(
      this.sceneRoot.camera,
      this.config.render.cameraHeight,
      this.config.render.cameraTiltDeg,
    );
    createMainLights(this.sceneRoot.scene);

    this.input = new KeyboardMouseInput(canvas);

    this.hasRealtimeServer = Boolean(options.wsUrl);

    this.socket = new RealtimeSocketClient({
      url: options.wsUrl,
      reconnectMinMs: this.config.net.reconnectMinMs,
      reconnectMaxMs: this.config.net.reconnectMaxMs,
      onSnapshot: (snapshot) => this.onSnapshot(snapshot),
      onStateChange: (state) => useUiStore.getState().setHud({ reconnectState: state }),
      onEvent: (name, payload) => this.onSocketEvent(name, payload),
      onPing: (pingMs) => {
        this.netMetrics.onPing(pingMs);
        useUiStore.getState().setHud({ pingMs, jitterMs: this.netMetrics.jitterMs });
      },
    });

    this.localPlayerEntityId = this.createPlayerEntity({
      networkPlayerId: 1,
      isLocal: true,
      color: 0x8ac0ff,
    });

    this.loadHeroModel(this.localPlayerEntityId).catch((error) => {
      console.error("[GameApp] Failed to load local hero GLB:", error);
    });

    this.setupSystems();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.input.attach();

    if (this.hasRealtimeServer) {
      this.socket.connect();
    } else {
      useUiStore.getState().setHud({ reconnectState: LOCAL_MODE_STATE, pingMs: 0, jitterMs: 0 });
    }

    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.input.detach();
    this.socket.disconnect();
    this.renderer.dispose();
  }

  private setupSystems(): void {
    this.world.addSystem(new InputSystem(this.config.simulation.playerSpeed));
    this.world.addSystem(new MovementSystem());
    this.world.addSystem(new CollisionSystem());
    this.world.addSystem(new WeaponFireSystem());
    this.world.addSystem(new ProjectileSystem());
    this.world.addSystem(new SkillSystem());
    this.world.addSystem(new BuffDebuffSystem());
    this.world.addSystem(new AnimationSystem());
  }

  private frame = (nowMs: number): void => {
    if (!this.running) return;

    const frameMs = nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;

    this.perf.recordFrame(frameMs);
    useUiStore.getState().setHud({
      fps: this.perf.fps,
      frameMs: this.perf.frameMs,
      drawCalls: this.renderer.drawCalls,
      packetLossPct: this.netMetrics.packetLossPct,
    });

    this.fixedStep.advance(frameMs, (dtMs) => this.simulationTick(nowMs, dtMs));

    const estimatedServerNowMs = Date.now() + (this.hasServerTimeOffset ? this.serverTimeOffsetMs : 0);
    this.applyInterpolatedRemoteState(estimatedServerNowMs);
    this.syncRenderProxies(frameMs);

    const localProxy = this.world.renderProxies.get(this.localPlayerEntityId);
    if (localProxy) {
      this.cameraRig.setFollowTarget(localProxy.object3d.position.x, localProxy.object3d.position.z);
    } else {
      const localTransform = this.world.transforms.get(this.localPlayerEntityId);
      if (localTransform) {
        this.cameraRig.setFollowTarget(localTransform.x, localTransform.z);
      }
    }
    this.cameraRig.update(frameMs);

    this.syncCameraAspectToCanvas();

    if (nowMs - this.lastPingAt > 1000) {
      this.lastPingAt = nowMs;
      this.socket.sendPing();
    }

    this.renderer.render(this.sceneRoot.scene, this.sceneRoot.camera);
    this.rafId = requestAnimationFrame(this.frame);
  };

  private syncRenderProxies(frameMs: number): void {
    const remotePosAlpha = 1 - Math.exp(-frameMs / 42);
    const remoteYawAlpha = 1 - Math.exp(-frameMs / 30);
    const localPosAlpha = 1 - Math.exp(-frameMs / 24);
    const localYawAlpha = 1 - Math.exp(-frameMs / 20);

    for (const [entityId, proxy] of this.world.renderProxies) {
      const transform = this.world.transforms.get(entityId);
      if (!transform) continue;

      const isLocal = entityId === this.localPlayerEntityId;
      const positionAlpha = isLocal ? localPosAlpha : remotePosAlpha;
      const yawAlpha = isLocal ? localYawAlpha : remoteYawAlpha;

      const current = proxy.object3d.position;
      const dx = transform.x - current.x;
      const dy = transform.y - current.y;
      const dz = transform.z - current.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const snap = distSq > (isLocal ? 1 : 4);
      const alpha = snap ? 1 : positionAlpha;

      current.x += dx * alpha;
      current.y += dy * alpha;
      current.z += dz * alpha;

      const currentYaw = proxy.object3d.rotation.y;
      const yawDelta = Math.atan2(
        Math.sin(transform.yaw - currentYaw),
        Math.cos(transform.yaw - currentYaw),
      );
      proxy.object3d.rotation.y = currentYaw + yawDelta * (snap ? 1 : yawAlpha);
    }
  }

  private simulationTick(nowMs: number, dtMs: number): void {
    const rawInput = this.input.sample();
    const aim = resolveAimOnGround(this.sceneRoot.camera, rawInput.aimNdcX, rawInput.aimNdcY);
    const command = this.commands.create(nowMs, rawInput, aim);

    const inputChanged = this.commands.shouldSend(command);
    const sendIntervalMs = 1000 / this.config.net.sendHz;
    const hasContinuousInput =
      Math.abs(command.moveX) > 0.001 ||
      Math.abs(command.moveY) > 0.001 ||
      command.fire ||
      command.skillQ ||
      command.skillE ||
      command.skillR;
    const periodicSendDue = hasContinuousInput && nowMs - this.lastInputSentAt >= sendIntervalMs;

    if (inputChanged || periodicSendDue) {
      const sent = this.socket.sendInput(command);
      if (sent) {
        this.commands.markSent(command);
        this.lastInputSentAt = nowMs;
      }
    }

    this.replay.logInput(command);

    this.world.update({
      nowMs,
      dtMs,
      localPlayerId: this.localPlayerEntityId,
      command,
      worldBounds: this.config.simulation.worldBounds,
    });

    const health = this.world.healths.get(this.localPlayerEntityId);
    if (health) {
      useUiStore.getState().setHud({ hp: health.current, maxHp: health.max });
    }
  }

  private onSocketEvent(name: string, payload: unknown): void {
    if (name !== "S2C_WELCOME") return;
    if (!payload || typeof payload !== "object") return;

    const playerId = (payload as { playerId?: unknown }).playerId;
    if (typeof playerId === "number" && Number.isFinite(playerId)) {
      this.localNetworkPlayerId = playerId;
    }

    const serverTimeMs = (payload as { serverTimeMs?: unknown }).serverTimeMs;
    if (typeof serverTimeMs === "number" && Number.isFinite(serverTimeMs)) {
      this.updateServerTimeOffset(serverTimeMs);
    }
  }

  private onSnapshot(snapshot: WorldSnapshot): void {
    this.replay.logSnapshot(snapshot);
    this.netMetrics.onSnapshotTick(snapshot.serverTick);
    this.updateServerTimeOffset(snapshot.serverTimeMs);

    const local = snapshot.players.find((player) => player.playerId === this.localNetworkPlayerId);
    if (local) {
      this.applyReconciliation(local);
    }

    this.commands.consumeAck(snapshot.ackSeq);
    this.interpolationBuffer.push(snapshot);

    useUiStore.getState().setHud({
      reconnectState: "Connected",
      packetLossPct: this.netMetrics.packetLossPct,
    });
  }

  private updateServerTimeOffset(serverTimeMs: number): void {
    const measuredOffset = serverTimeMs - Date.now();

    if (!this.hasServerTimeOffset) {
      this.serverTimeOffsetMs = measuredOffset;
      this.hasServerTimeOffset = true;
      return;
    }

    // Smooth clock-skew estimation to avoid sudden jumps while tracking drift.
    const alpha = 0.08;
    this.serverTimeOffsetMs += (measuredOffset - this.serverTimeOffsetMs) * alpha;
  }

  private applyReconciliation(authoritative: NetworkPlayerState): void {
    const transform = this.world.transforms.get(this.localPlayerEntityId);
    const velocity = this.world.velocities.get(this.localPlayerEntityId);
    if (!transform || !velocity) return;

    const pending = this.commands.pendingAfter(authoritative.lastProcessedInputSeq);
    const reconciled = reconcileLocalState({
      authoritative,
      currentPredicted: {
        position: { x: transform.x, y: transform.z },
        velocity: { x: velocity.x, y: velocity.z },
        lastSeq: authoritative.lastProcessedInputSeq,
      },
      pendingCommands: pending,
      dtSeconds: this.config.simulation.fixedDtMs / 1000,
      moveSpeed: this.config.simulation.playerSpeed,
      hardSnapThreshold: this.config.simulation.hardSnapThreshold,
      smoothCorrectionAlpha: this.config.simulation.smoothCorrectionAlpha,
    });

    const correctionX = reconciled.position.x - transform.x;
    const correctionZ = reconciled.position.y - transform.z;
    const correctionSq = correctionX * correctionX + correctionZ * correctionZ;

    // Ignore tiny correction jitter from network quantization/timing drift.
    if (correctionSq > 0.0004) {
      transform.x = reconciled.position.x;
      transform.z = reconciled.position.y;
    }

    velocity.x = reconciled.velocity.x;
    velocity.z = reconciled.velocity.y;
  }

  private applyInterpolatedRemoteState(nowMs: number): void {
    const sampled = this.interpolationBuffer.sample(nowMs);
    if (!sampled) return;

    const seenRemotePlayerIds = new Set<number>();

    for (const player of sampled.players) {
      if (player.playerId === this.localNetworkPlayerId) continue;
      seenRemotePlayerIds.add(player.playerId);

      const entityId = this.ensureRemoteEntity(player.playerId);
      const transform = this.world.transforms.get(entityId);
      if (!transform) continue;

      transform.x = player.x;
      transform.z = player.y;
      transform.yaw = player.rot;

      const velocity = this.world.velocities.get(entityId);
      if (velocity) {
        velocity.x = player.vx;
        velocity.z = player.vy;
      }

      const health = this.world.healths.get(entityId);
      if (health) {
        health.current = player.hp;
        health.shield = player.shield;
      }
    }

    for (const networkPlayerId of [...this.remoteEntities.keys()]) {
      if (seenRemotePlayerIds.has(networkPlayerId)) continue;
      this.removeRemoteEntity(networkPlayerId);
    }
  }

  private ensureRemoteEntity(networkPlayerId: number): EntityId {
    const existing = this.remoteEntities.get(networkPlayerId);
    if (existing) return existing;

    const entityId = this.createPlayerEntity({
      networkPlayerId,
      isLocal: false,
      color: 0xffb780,
    });

    this.remoteEntities.set(networkPlayerId, entityId);

    this.loadHeroModel(entityId).catch((error) => {
      console.error("[GameApp] Failed to load remote hero GLB:", error);
    });

    return entityId;
  }

  private removeRemoteEntity(networkPlayerId: number): void {
    const entityId = this.remoteEntities.get(networkPlayerId);
    if (!entityId) return;

    this.remoteEntities.delete(networkPlayerId);

    const proxy = this.world.renderProxies.get(entityId);
    if (proxy) {
      this.sceneRoot.scene.remove(proxy.object3d);
      this.disposeRenderProxy(proxy);
    }

    this.world.renderProxies.delete(entityId);
    this.world.transforms.delete(entityId);
    this.world.velocities.delete(entityId);
    this.world.healths.delete(entityId);
    this.world.teams.delete(entityId);
    this.world.weapons.delete(entityId);
    this.world.skills.delete(entityId);
    this.world.statusEffects.delete(entityId);
  }

  private createPlayerEntity(args: {
    networkPlayerId: number;
    isLocal: boolean;
    color: number;
  }): EntityId {
    const entityId = this.world.createEntity();

    const spawnX = args.isLocal ? 0 : ((args.networkPlayerId % 4) - 1.5) * 1.2;
    const spawnZ = args.isLocal ? 0 : 2.4;
    this.world.transforms.set(entityId, { x: spawnX, y: 0, z: spawnZ, yaw: 0 });
    this.world.velocities.set(entityId, { x: 0, y: 0, z: 0 });
    this.world.healths.set(entityId, { current: 100, max: 100, shield: 0 });
    this.world.teams.set(entityId, { id: args.isLocal ? 1 : 2 });
    this.world.weapons.set(entityId, {
      weaponId: "assault_rifle",
      cooldownMs: 100,
      lastFiredAtMs: -1,
      ammo: 30,
    });
    this.world.skills.set(entityId, {
      qCooldownEndMs: 0,
      eCooldownEndMs: 0,
      rCooldownEndMs: 0,
    });
    this.world.statusEffects.set(entityId, []);

    const fallbackVisual = this.createFallbackPlayerVisual(args.color, args.isLocal);
    this.sceneRoot.scene.add(fallbackVisual);

    this.world.renderProxies.set(entityId, { object3d: fallbackVisual });

    return entityId;
  }

  private createFallbackPlayerVisual(color: number, isLocal: boolean): THREE.Object3D {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.6,
      metalness: 0.08,
    });

    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.8, 4, 10), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.y = 0.85;

    const root = new THREE.Group();
    root.add(mesh);

    if (isLocal) {
      this.addLocalMarker(root);
    }

    return root;
  }

  private async loadHeroModel(entityId: EntityId): Promise<void> {
    const gltf = await this.loadGltf(this.localHeroAssetPath);
    const preparedModel = this.prepareModelRoot(gltf.scene);

    if (entityId === this.localPlayerEntityId) {
      this.addLocalMarker(preparedModel);
    }

    const animation = this.createAnimationState(gltf, preparedModel, this.localHeroAsset);

    const previous = this.world.renderProxies.get(entityId);
    if (previous) {
      this.sceneRoot.scene.remove(previous.object3d);
      this.disposeRenderProxy(previous);
    }

    this.sceneRoot.scene.add(preparedModel);
    this.world.renderProxies.set(entityId, {
      object3d: preparedModel,
      ...(animation ? { animation } : {}),
    });
  }

  private loadGltf(path: string): Promise<GLTF> {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(path, resolve, undefined, reject);
    });
  }

  private prepareModelRoot(scene: THREE.Object3D): THREE.Group {
    const model = scene;

    const helperMeshes: THREE.Object3D[] = [];

    model.traverse((node) => {
      const maybeMesh = node as THREE.Mesh;
      if (!maybeMesh.isMesh) return;

      const meshName = maybeMesh.name.toLowerCase();
      if (meshName.startsWith("ico") || meshName.includes("helper")) {
        helperMeshes.push(maybeMesh);
        return;
      }

      maybeMesh.castShadow = true;
      maybeMesh.receiveShadow = true;
      maybeMesh.frustumCulled = false;
    });

    for (const helper of helperMeshes) {
      helper.parent?.remove(helper);
    }

    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) {
      throw new Error("Hero model has no renderable mesh after helper cleanup.");
    }

    const size = box.getSize(new THREE.Vector3());
    const targetHeight = 1.7;
    const measuredHeight = Math.max(size.x, size.y, size.z);
    if (measuredHeight > 0.001) {
      const uniformScale = targetHeight / measuredHeight;
      const clampedScale = THREE.MathUtils.clamp(uniformScale, 0.35, 20);
      model.scale.setScalar(clampedScale);
    }

    model.position.set(0, 0, 0);

    const root = new THREE.Group();
    root.add(model);
    return root;
  }

  private addLocalMarker(root: THREE.Object3D): void {
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.58, 28),
      new THREE.MeshBasicMaterial({
        color: LOCAL_MARKER_COLOR,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    );

    marker.name = "local-player-marker";
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = 0.03;
    root.add(marker);
  }

  private createAnimationState(
    gltf: GLTF,
    modelRoot: THREE.Object3D,
    heroAsset: HeroAssetManifest,
  ): RenderAnimationState | undefined {
    if (gltf.animations.length === 0) {
      return undefined;
    }

    const mixer = new THREE.AnimationMixer(modelRoot);
    const actions = new Map<string, THREE.AnimationAction>();

    for (const sourceClip of gltf.animations) {
      const clip = this.lockClipRootMotion(sourceClip);
      const action = mixer.clipAction(clip);
      action.enabled = true;
      action.clampWhenFinished = false;
      action.setLoop(THREE.LoopRepeat, Infinity);
      actions.set(clip.name, action);
    }

    const firstClip = actions.keys().next().value as string | undefined;
    if (!firstClip) {
      return undefined;
    }

    const idleClip = actions.has(heroAsset.idleClip) ? heroAsset.idleClip : firstClip;
    const runClip = actions.has(heroAsset.runClip) ? heroAsset.runClip : idleClip;

    const activeClip = idleClip;
    actions.get(activeClip)?.reset().play();

    // Ensure the animated pose itself starts near world origin.
    // Some Mixamo exports keep large root offsets even after track freezing.
    mixer.update(0);
    this.recenterAnimatedModelRoot(modelRoot);

    return {
      mixer,
      actions,
      idleClip,
      runClip,
      activeClip,
      moveThreshold: HERO_MOVE_ANIM_THRESHOLD,
    };
  }

  private lockClipRootMotion(sourceClip: THREE.AnimationClip): THREE.AnimationClip {
    // Mixamo retarget clips in this pipeline can carry large per-bone translation curves
    // (especially hips), which can push the whole skinned mesh far away from the entity root.
    // Instead of stripping translation tracks (which caused skin collapse before),
    // freeze each position track to its first keyframe so bind offsets are preserved
    // while root-motion drift is removed.
    const clip = sourceClip.clone();
    const tracks = clip.tracks.map((track) => {
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

    return new THREE.AnimationClip(clip.name, clip.duration, tracks).optimize();
  }

  private recenterAnimatedModelRoot(modelRoot: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(modelRoot);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());

    // In runtime, modelRoot itself is synced by RenderSyncSystem every frame.
    // So persist the anchor offset on the first child container (actual model),
    // not on modelRoot.
    const modelContainer = modelRoot.children[0] ?? modelRoot;

    const footAnchor = this.sampleFootAnchor(modelRoot);
    if (footAnchor) {
      // Pivot target: midpoint between both feet on ground.
      modelContainer.position.x -= footAnchor.x;
      modelContainer.position.y -= footAnchor.y;
      modelContainer.position.z -= footAnchor.z;
      return;
    }

    // Fallback when foot bones are unavailable.
    modelContainer.position.x -= center.x;
    modelContainer.position.z -= center.z;
    modelContainer.position.y -= box.min.y;
  }

  private sampleFootAnchor(modelRoot: THREE.Object3D): THREE.Vector3 | null {
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

    modelRoot.updateMatrixWorld(true);
    modelRoot.traverse((node) => {
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

  private syncCameraAspectToCanvas(): void {
    const canvas = this.renderer.renderer.domElement;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const aspect = width / height;

    if (!Number.isFinite(aspect) || aspect <= 0) {
      return;
    }

    if (Math.abs(this.sceneRoot.camera.aspect - aspect) > 1e-4) {
      this.sceneRoot.camera.aspect = aspect;
      this.sceneRoot.camera.updateProjectionMatrix();
    }
  }

  private disposeRenderProxy(proxy: { object3d: THREE.Object3D; animation?: RenderAnimationState }): void {
    if (proxy.animation) {
      proxy.animation.mixer.stopAllAction();
      proxy.animation.mixer.uncacheRoot(proxy.object3d);
      proxy.animation.actions.clear();
    }

    this.disposeObjectResources(proxy.object3d);
  }

  private disposeObjectResources(object3d: THREE.Object3D): void {
    object3d.traverse((node) => {
      const maybeMesh = node as THREE.Mesh;
      if (!maybeMesh.isMesh) return;

      maybeMesh.geometry.dispose();
      if (Array.isArray(maybeMesh.material)) {
        for (const material of maybeMesh.material) {
          material.dispose();
        }
      } else {
        maybeMesh.material.dispose();
      }
    });
  }
}
