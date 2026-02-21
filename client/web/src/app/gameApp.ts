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
import { HERO_DEFS, HERO_DEF_BY_ID, type HeroDef } from "../gameplay/hero/heroDefs";
import { WEAPON_DEFS, WEAPON_DEF_BY_ID } from "../gameplay/weapon/weaponDefs";
import { LevelRuntime } from "../level/runtime/levelRuntime";
import type { FogOfWarQuality } from "../level/runtime/fogOfWarOverlay";
import { segmentIntersectsCollider2D } from "../level/runtime/levelCollision";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

interface GameAppOptions {
  wsUrl?: string;
  heroId?: string;
  roomToken?: string;
  mapId?: string;
  fowQuality?: FogOfWarQuality;
}

const HERO_MOVE_ANIM_THRESHOLD = 0.15;
const LOCAL_MODE_STATE = "Local (No Server)";
const LOCAL_MARKER_COLOR = 0x4ad8ff;
const DEFAULT_HERO_ID = "coral_cat";
const BULLET_TRAIL_MUZZLE_HEIGHT = 1.05;
const BULLET_PROJECTILE_SPEED = 28;
const BULLET_TRAIL_LENGTH = 1.35;
const BULLET_TRAIL_RADIUS = 0.053;
const BULLET_IMPACT_RADIUS = 0.09;
const BULLET_TRAIL_LIFE_MS = 460;
const MUZZLE_FLASH_LIFE_MS = 90;
const MUZZLE_FLASH_RADIUS = 0.17;
const MUZZLE_FLASH_LENGTH = 0.38;
const DAMAGE_TEXT_LIFE_MS = 680;
const DAMAGE_TEXT_FLOAT_SPEED = 1.35;
const HIT_MARKER_LIFE_MS = 130;
const DAMAGE_OVERLAY_LIFE_MS = 220;
const LOS_VISION_RANGE_METERS = 22;
const LOS_HALF_FOV_RAD = (55 * Math.PI) / 180;
const LOS_COLLIDER_PADDING = 0.02;
const FOW_QUALITY_STORAGE_KEY = "wildpaw.fowQuality";

function normalizeHeroId(rawHeroId: string): string {
  const normalized = rawHeroId.trim();
  if (normalized === "whitecat_commando") {
    return DEFAULT_HERO_ID;
  }
  return normalized;
}

function resolvePreferredHeroId(explicitHeroId?: string): string {
  if (explicitHeroId && explicitHeroId.trim().length > 0) {
    return normalizeHeroId(explicitHeroId);
  }

  if (typeof window === "undefined") {
    return DEFAULT_HERO_ID;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("hero");
    if (fromQuery && fromQuery.trim().length > 0) {
      return normalizeHeroId(fromQuery);
    }
  } catch {
    // ignore parse errors
  }

  return DEFAULT_HERO_ID;
}

function resolvePreferredMapId(explicitMapId?: string): string | undefined {
  if (explicitMapId && explicitMapId.trim().length > 0) {
    return explicitMapId.trim();
  }

  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("map");
    if (fromQuery && fromQuery.trim().length > 0) {
      return fromQuery.trim();
    }
  } catch {
    // ignore parse errors
  }

  return undefined;
}

function normalizeFogOfWarQuality(raw: unknown): FogOfWarQuality | null {
  if (typeof raw !== "string") {
    return null;
  }

  const value = raw.trim().toLowerCase();
  if (value === "low" || value === "l" || value === "performance") {
    return "low";
  }
  if (value === "medium" || value === "m" || value === "balanced") {
    return "medium";
  }
  if (value === "high" || value === "h" || value === "quality") {
    return "high";
  }
  return null;
}

function resolvePreferredFogOfWarQuality(explicit?: string): FogOfWarQuality {
  const fromExplicit = normalizeFogOfWarQuality(explicit);
  if (fromExplicit) {
    return fromExplicit;
  }

  if (typeof window === "undefined") {
    return "low";
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = normalizeFogOfWarQuality(
      params.get("fow") ?? params.get("fowQuality"),
    );

    if (fromQuery) {
      try {
        window.localStorage.setItem(FOW_QUALITY_STORAGE_KEY, fromQuery);
      } catch {
        // ignore storage failures
      }
      return fromQuery;
    }

    const fromStorage = normalizeFogOfWarQuality(
      window.localStorage.getItem(FOW_QUALITY_STORAGE_KEY),
    );
    if (fromStorage) {
      return fromStorage;
    }
  } catch {
    // ignore parse/storage errors
  }

  return "low";
}

function isLosFeatureEnabled(quality: FogOfWarQuality): boolean {
  return quality !== "low";
}

function pickHeroDef(heroId: string): HeroDef {
  return HERO_DEF_BY_ID.get(heroId) ?? HERO_DEF_BY_ID.get(DEFAULT_HERO_ID) ?? HERO_DEFS[0]!;
}

function pickHeroAsset(heroId: string): HeroAssetManifest {
  return (
    HERO_ASSET_MANIFEST.find((hero) => hero.heroId === heroId) ??
    HERO_ASSET_MANIFEST.find((hero) => hero.heroId === DEFAULT_HERO_ID) ??
    HERO_ASSET_MANIFEST[0]!
  );
}

function getTeamTrailColor(teamId: number): number {
  if (teamId === 1) return 0x7ce7ff; // ally/cyan
  if (teamId === 2) return 0xffc36a; // enemy/amber
  return 0xf2f5ff;
}

interface BulletTrailEffect {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  maxDistance: number;
  traveledDistance: number;
  trailLength: number;
  trail: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  trailGeometry: THREE.CylinderGeometry;
  trailMaterial: THREE.MeshBasicMaterial;
  glowTrail: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  glowTrailGeometry: THREE.CylinderGeometry;
  glowTrailMaterial: THREE.MeshBasicMaterial;
  impact: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  impactGeometry: THREE.SphereGeometry;
  impactMaterial: THREE.MeshBasicMaterial;
  ageMs: number;
  lifeMs: number;
}

interface MuzzleFlashEffect {
  flashCone: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  flashConeGeometry: THREE.ConeGeometry;
  flashConeMaterial: THREE.MeshBasicMaterial;
  flashGlow: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  flashGlowGeometry: THREE.SphereGeometry;
  flashGlowMaterial: THREE.MeshBasicMaterial;
  ageMs: number;
  lifeMs: number;
}

interface DamageNumberEffect {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  ageMs: number;
  lifeMs: number;
  velocityY: number;
  drift: THREE.Vector3;
  baseScale: number;
}

interface ImpactBurstEffect {
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  ringGeometry: THREE.RingGeometry;
  ringMaterial: THREE.MeshBasicMaterial;
  ageMs: number;
  lifeMs: number;
}

interface CombatEventPayload {
  kind?: unknown;
  attackerPlayerId?: unknown;
  targetPlayerId?: unknown;
  damage?: unknown;
  critical?: unknown;
  targetX?: unknown;
  targetY?: unknown;
  attackerX?: unknown;
  attackerY?: unknown;
}

export class GameApp {
  private readonly config = createRuntimeConfig();
  private readonly world = new World();
  private readonly fixedStep = new FixedStepRunner(this.config.simulation.fixedDtMs);
  private readonly input: KeyboardMouseInput;
  private readonly commands = new CommandBuffer();

  private readonly sceneRoot = createSceneRoot();
  private readonly renderer: GameRenderer;
  private readonly cameraRig: CameraRig;
  private readonly levelRuntime: LevelRuntime;
  private readonly worldBounds: {
    min: number;
    max: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };

  private readonly socket: RealtimeSocketClient;
  private readonly hasRealtimeServer: boolean;
  private readonly roomToken: string;
  private readonly interpolationBuffer = new SnapshotInterpolationBuffer(
    this.config.net.interpolationDelayMs,
    this.config.net.maxExtrapolationMs,
  );

  private readonly perf = new PerfTracker();
  private readonly netMetrics = new NetMetricsTracker();
  private readonly replay = new ReplayLogger();
  private readonly gltfLoader = createGltfLoader();
  private readonly selectedHeroId: string;
  private readonly localHeroDef: HeroDef;
  private readonly localHeroAsset: HeroAssetManifest;
  private readonly localHeroAssetPath: string;
  private readonly losFeatureEnabled: boolean;

  private readonly remoteEntities = new Map<number, EntityId>();
  private readonly remoteVisibilityByPlayerId = new Map<number, boolean>();
  private localPlayerEntityId: EntityId;
  private localNetworkPlayerId = 1;
  private running = false;
  private rafId = 0;
  private lastFrameMs = 0;
  private lastPingAt = 0;
  private lastInputSentAt = Number.NEGATIVE_INFINITY;
  private serverTimeOffsetMs = 0;
  private hasServerTimeOffset = false;
  private readonly snapshotAmmoByPlayerId = new Map<number, number>();
  private readonly bulletTrailEffects: BulletTrailEffect[] = [];
  private readonly muzzleFlashEffects: MuzzleFlashEffect[] = [];
  private readonly damageNumberEffects: DamageNumberEffect[] = [];
  private readonly impactBurstEffects: ImpactBurstEffect[] = [];
  private hitMarkerElement: HTMLDivElement | null = null;
  private hitMarkerAgeMs = Number.POSITIVE_INFINITY;
  private hitMarkerLifeMs = HIT_MARKER_LIFE_MS;
  private damageOverlayElement: HTMLDivElement | null = null;
  private damageOverlayAgeMs = Number.POSITIVE_INFINITY;
  private damageOverlayLifeMs = DAMAGE_OVERLAY_LIFE_MS;
  private stickyFacingAim: { x: number; y: number } | null = null;

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

    const resolvedMapId = resolvePreferredMapId(options.mapId);
    const fogOfWarQuality = resolvePreferredFogOfWarQuality(options.fowQuality);
    this.losFeatureEnabled = isLosFeatureEnabled(fogOfWarQuality);
    const levelDebugEnabled =
      typeof window !== "undefined" &&
      (new URLSearchParams(window.location.search).get("levelDebug") === "1" ||
        new URLSearchParams(window.location.search).get("debugLevel") === "1");
    this.levelRuntime = new LevelRuntime(this.sceneRoot.scene, resolvedMapId, {
      debugVisible: levelDebugEnabled,
      fogOfWarQuality,
    });
    this.worldBounds = this.levelRuntime.worldBounds;
    console.info(
      `[level] loaded map=${this.levelRuntime.map.mapId} mode=${this.levelRuntime.map.mode} prefabs=${this.levelRuntime.map.prefabs.length}`,
    );

    this.input = new KeyboardMouseInput(canvas);
    this.ensureHitMarkerElement();
    this.ensureDamageOverlayElement();

    this.selectedHeroId = resolvePreferredHeroId(options.heroId);
    this.localHeroDef = pickHeroDef(this.selectedHeroId);
    this.localHeroAsset = pickHeroAsset(this.selectedHeroId);
    this.localHeroAssetPath = this.localHeroAsset.gltfPath;

    this.hasRealtimeServer = Boolean(options.wsUrl);
    this.roomToken = options.roomToken?.trim() ? options.roomToken : "dev-room";

    this.socket = new RealtimeSocketClient({
      url: options.wsUrl,
      reconnectMinMs: this.config.net.reconnectMinMs,
      reconnectMaxMs: this.config.net.reconnectMaxMs,
      heroId: this.localHeroDef.id,
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

    const localWeapon = WEAPON_DEF_BY_ID.get(this.localHeroDef.weaponId) ?? WEAPON_DEFS[0]!;
    useUiStore.getState().setHud({
      heroName: this.localHeroDef.displayName,
      hp: this.localHeroDef.baseHp,
      maxHp: this.localHeroDef.baseHp,
      ammo: localWeapon.ammo,
      maxAmmo: localWeapon.ammo,
      reloading: false,
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
      this.socket.connect(this.roomToken);
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
    this.clearBulletEffects();
    this.clearMuzzleFlashEffects();
    this.clearDamageNumberEffects();
    this.clearImpactBurstEffects();
    this.removeHitMarkerElement();
    this.removeDamageOverlayElement();
    this.levelRuntime.dispose();
    this.renderer.dispose();
  }

  private setupSystems(): void {
    this.world.addSystem(new InputSystem(this.localHeroDef.moveSpeed));
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

    try {
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
      this.updateBulletTrailEffects(frameMs);
      this.updateMuzzleFlashEffects(frameMs);
      this.updateDamageNumberEffects(frameMs);
      this.updateImpactBurstEffects(frameMs);
      this.updateHitMarker(frameMs);
      this.updateDamageTakenOverlay(frameMs);

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

      const localTransformForLos = this.world.transforms.get(this.localPlayerEntityId);
      if (this.losFeatureEnabled && localTransformForLos) {
        this.levelRuntime.updateFogOfWar(
          localTransformForLos.x,
          localTransformForLos.z,
          localTransformForLos.yaw,
          LOS_VISION_RANGE_METERS,
          LOS_HALF_FOV_RAD,
          nowMs,
        );
      }

      this.syncCameraAspectToCanvas();

      if (nowMs - this.lastPingAt > 1000) {
        this.lastPingAt = nowMs;
        this.socket.sendPing();
      }

      this.levelRuntime.update(nowMs);
      this.renderer.render(this.sceneRoot.scene, this.sceneRoot.camera);
    } catch (error) {
      console.error("[GameApp] frame error", error);
    } finally {
      if (this.running) {
        this.rafId = requestAnimationFrame(this.frame);
      }
    }
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
    this.applyFacingIntentToCommand(command, rawInput);

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
      const localTransform = this.world.transforms.get(this.localPlayerEntityId);
      if (localTransform) {
        const aimDx = command.aimX - localTransform.x;
        const aimDy = command.aimY - localTransform.z;

        command.originX = localTransform.x;
        command.originY = localTransform.z;
        if (Math.hypot(aimDx, aimDy) > 0.0001) {
          command.aimRadian = Math.atan2(aimDx, aimDy);
        }
      }

      const sent = this.socket.sendInput(command);
      if (sent) {
        this.commands.markSent(command);
        this.lastInputSentAt = nowMs;
      }
    }

    this.replay.logInput(command);

    const localWeaponBeforeAmmo = this.world.weapons.get(this.localPlayerEntityId)?.ammo ?? null;

    this.world.update({
      nowMs,
      dtMs,
      localPlayerId: this.localPlayerEntityId,
      command,
      worldBounds: this.worldBounds,
      staticColliders: this.levelRuntime.colliders,
    });

    this.syncLocalFacingFromCommand(command, rawInput);

    const health = this.world.healths.get(this.localPlayerEntityId);
    const weapon = this.world.weapons.get(this.localPlayerEntityId);

    if (localWeaponBeforeAmmo !== null && weapon && weapon.ammo < localWeaponBeforeAmmo) {
      const shotCount = Math.max(1, localWeaponBeforeAmmo - weapon.ammo);
      this.spawnLocalShotTrails(shotCount);
    }
    if (health) {
      useUiStore.getState().setHud({
        hp: health.current,
        maxHp: health.max,
        ammo: weapon?.ammo ?? 0,
      });
    }
  }

  private applyFacingIntentToCommand(
    command: { moveX: number; moveY: number; aimX: number; aimY: number },
    rawInput: { preferMoveFacing: boolean; hasAimControl: boolean },
  ): void {
    const transform = this.world.transforms.get(this.localPlayerEntityId);
    if (!transform) return;

    const moveLen = Math.hypot(command.moveX, command.moveY);
    const hasMoveInput = moveLen > 0.04;
    const shouldFaceMove = hasMoveInput;

    if (shouldFaceMove) {
      const inv = 1 / Math.max(moveLen, 0.001);
      const dirX = command.moveX * inv;
      const dirY = command.moveY * inv;
      const lookAhead = 6;

      command.aimX = transform.x + dirX * lookAhead;
      command.aimY = transform.z + dirY * lookAhead;
      this.stickyFacingAim = { x: command.aimX, y: command.aimY };
      return;
    }

    if (rawInput.hasAimControl) {
      this.stickyFacingAim = { x: command.aimX, y: command.aimY };
      return;
    }

    if (this.stickyFacingAim) {
      command.aimX = this.stickyFacingAim.x;
      command.aimY = this.stickyFacingAim.y;
      return;
    }

    command.aimX = transform.x + Math.sin(transform.yaw) * 6;
    command.aimY = transform.z + Math.cos(transform.yaw) * 6;
    this.stickyFacingAim = { x: command.aimX, y: command.aimY };
  }

  private syncLocalFacingFromCommand(
    command: { moveX: number; moveY: number; aimX: number; aimY: number },
    rawInput: { preferMoveFacing: boolean; hasAimControl: boolean },
  ): void {
    const transform = this.world.transforms.get(this.localPlayerEntityId);
    if (!transform) return;

    const moveLen = Math.hypot(command.moveX, command.moveY);
    const hasMoveInput = moveLen > 0.04;
    const shouldFaceMove = hasMoveInput;

    if (shouldFaceMove) {
      transform.yaw = Math.atan2(command.moveX, command.moveY);
      return;
    }

    // No move/aim control: keep last facing exactly.
    if (!rawInput.hasAimControl && !hasMoveInput) {
      return;
    }

    const aimDx = command.aimX - transform.x;
    const aimDz = command.aimY - transform.z;
    if (Math.hypot(aimDx, aimDz) > 0.001) {
      transform.yaw = Math.atan2(aimDx, aimDz);
      return;
    }

    if (hasMoveInput) {
      transform.yaw = Math.atan2(command.moveX, command.moveY);
    }
  }

  private onSocketEvent(name: string, payload: unknown): void {

    if (!payload || typeof payload !== "object") return;

    if (name === "S2C_WELCOME") {
      const playerId = (payload as { playerId?: unknown }).playerId;
      if (typeof playerId === "number" && Number.isFinite(playerId)) {
        this.localNetworkPlayerId = playerId;
      }

      const serverTimeMs = (payload as { serverTimeMs?: unknown }).serverTimeMs;
      if (typeof serverTimeMs === "number" && Number.isFinite(serverTimeMs)) {
        this.updateServerTimeOffset(serverTimeMs);
      }

      const heroId = (payload as { heroId?: unknown }).heroId;
      if (typeof heroId === "string" && heroId.trim().length > 0) {
        const hero = pickHeroDef(heroId);
        useUiStore.getState().setHud({ heroName: hero.displayName });
      }
      return;
    }

    if (name === "S2C_EVENT") {
      this.handleServerEvent(payload as CombatEventPayload);
    }
  }

  private handleServerEvent(payload: CombatEventPayload): void {
    const kind = typeof payload.kind === "string" ? payload.kind : "";

    if (kind === "hit-confirm") {
      const attackerPlayerId =
        typeof payload.attackerPlayerId === "number" && Number.isFinite(payload.attackerPlayerId)
          ? payload.attackerPlayerId
          : null;

      if (attackerPlayerId !== null && attackerPlayerId !== this.localNetworkPlayerId) {
        return;
      }

      const rawDamage =
        typeof payload.damage === "number" && Number.isFinite(payload.damage)
          ? Math.round(payload.damage)
          : null;
      if (rawDamage === null || rawDamage <= 0) return;

      const critical = Boolean(payload.critical);

      let worldX: number | null = null;
      let worldZ: number | null = null;

      if (typeof payload.targetX === "number" && Number.isFinite(payload.targetX)) {
        worldX = payload.targetX;
      }
      if (typeof payload.targetY === "number" && Number.isFinite(payload.targetY)) {
        worldZ = payload.targetY;
      }

      if (worldX === null || worldZ === null) {
        const targetPlayerId =
          typeof payload.targetPlayerId === "number" && Number.isFinite(payload.targetPlayerId)
            ? payload.targetPlayerId
            : null;

        if (targetPlayerId !== null) {
          const entityId = this.remoteEntities.get(targetPlayerId);
          if (entityId !== undefined) {
            const transform = this.world.transforms.get(entityId);
            if (transform) {
              worldX = transform.x;
              worldZ = transform.z;
            }
          }
        }
      }

      this.triggerHitMarker(critical);

      if (worldX !== null && worldZ !== null) {
        this.spawnDamageNumber(worldX, worldZ, rawDamage, critical, "outgoing");
      }
      return;
    }

    if (kind === "damage-taken") {
      const targetPlayerId =
        typeof payload.targetPlayerId === "number" && Number.isFinite(payload.targetPlayerId)
          ? payload.targetPlayerId
          : null;
      if (targetPlayerId !== null && targetPlayerId !== this.localNetworkPlayerId) {
        return;
      }

      const rawDamage =
        typeof payload.damage === "number" && Number.isFinite(payload.damage)
          ? Math.round(payload.damage)
          : null;
      if (rawDamage === null || rawDamage <= 0) return;

      const critical = Boolean(payload.critical);
      this.triggerDamageTakenOverlay(critical);

      const localTransform = this.world.transforms.get(this.localPlayerEntityId);
      if (localTransform) {
        const fallbackX = localTransform.x;
        const fallbackZ = localTransform.z;

        const worldX =
          typeof payload.targetX === "number" && Number.isFinite(payload.targetX)
            ? payload.targetX
            : fallbackX;
        const worldZ =
          typeof payload.targetY === "number" && Number.isFinite(payload.targetY)
            ? payload.targetY
            : fallbackZ;

        this.spawnDamageNumber(worldX, worldZ, rawDamage, critical, "incoming");
        this.spawnImpactBurst(worldX, worldZ, critical);
      }
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
      moveSpeed: this.localHeroDef.moveSpeed,
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

    if (Number.isFinite(authoritative.rot)) {
      const yawDelta = Math.atan2(
        Math.sin(authoritative.rot - transform.yaw),
        Math.cos(authoritative.rot - transform.yaw),
      );
      transform.yaw += yawDelta * 0.45;
    }

    const localTeam = this.world.teams.get(this.localPlayerEntityId);
    if (localTeam) {
      localTeam.id = authoritative.team === 2 ? 2 : 1;
    }

    const health = this.world.healths.get(this.localPlayerEntityId);
    if (health) {
      if (typeof authoritative.maxHp === "number" && Number.isFinite(authoritative.maxHp)) {
        health.max = Math.max(1, authoritative.maxHp);
      }
      health.current = authoritative.hp;
      health.shield = authoritative.shield;
      useUiStore.getState().setHud({ hp: health.current, maxHp: health.max });
    }

    const weapon = this.world.weapons.get(this.localPlayerEntityId);
    const nextAmmo =
      typeof authoritative.ammo === "number" && Number.isFinite(authoritative.ammo)
        ? Math.max(0, Math.round(authoritative.ammo))
        : weapon?.ammo ?? 0;
    const nextMaxAmmo =
      typeof authoritative.maxAmmo === "number" && Number.isFinite(authoritative.maxAmmo)
        ? Math.max(1, Math.round(authoritative.maxAmmo))
        : weapon?.ammo ?? 0;

    if (weapon) {
      weapon.ammo = nextAmmo;
    }

    const nextHeroName =
      typeof authoritative.heroName === "string" && authoritative.heroName.trim().length > 0
        ? authoritative.heroName
        : typeof authoritative.heroId === "string"
          ? pickHeroDef(authoritative.heroId).displayName
          : this.localHeroDef.displayName;

    useUiStore.getState().setHud({
      heroName: nextHeroName,
      ammo: nextAmmo,
      maxAmmo: nextMaxAmmo,
      reloading: Boolean(authoritative.reloading),
    });
  }

  private isRemoteVisibleToLocal(player: NetworkPlayerState): boolean {
    if (!this.losFeatureEnabled) {
      return true;
    }

    const localTransform = this.world.transforms.get(this.localPlayerEntityId);
    if (!localTransform) {
      return true;
    }

    const localTeamId = this.world.teams.get(this.localPlayerEntityId)?.id ?? 1;
    if (player.team === localTeamId) {
      return true;
    }

    const dx = player.x - localTransform.x;
    const dz = player.y - localTransform.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > LOS_VISION_RANGE_METERS * LOS_VISION_RANGE_METERS) {
      return false;
    }

    const dist = Math.sqrt(distSq);
    const dirX = dist > 1e-6 ? dx / dist : 0;
    const dirZ = dist > 1e-6 ? dz / dist : 1;
    const forwardX = Math.sin(localTransform.yaw);
    const forwardZ = Math.cos(localTransform.yaw);
    if (dirX * forwardX + dirZ * forwardZ < Math.cos(LOS_HALF_FOV_RAD)) {
      return false;
    }

    for (const collider of this.levelRuntime.colliders) {
      if (!collider.blocksLineOfSight && !collider.blocksMovement && !collider.blocksProjectile) {
        continue;
      }

      if (
        segmentIntersectsCollider2D(
          localTransform.x,
          localTransform.z,
          player.x,
          player.y,
          collider,
          LOS_COLLIDER_PADDING,
        )
      ) {
        return false;
      }
    }

    return true;
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

      const team = this.world.teams.get(entityId);
      if (team) {
        team.id = player.team === 2 ? 2 : 1;
      }

      const visible = this.isRemoteVisibleToLocal(player);
      this.remoteVisibilityByPlayerId.set(player.playerId, visible);
      const renderProxy = this.world.renderProxies.get(entityId);
      if (renderProxy) {
        renderProxy.object3d.visible = visible;
      }

      if (typeof player.ammo === "number" && Number.isFinite(player.ammo)) {
        const nextAmmo = Math.max(0, Math.round(player.ammo));
        const prevAmmo = this.snapshotAmmoByPlayerId.get(player.playerId);

        if (visible && typeof prevAmmo === "number" && nextAmmo < prevAmmo) {
          this.spawnRemoteShotTrails(player, prevAmmo - nextAmmo);
        }

        this.snapshotAmmoByPlayerId.set(player.playerId, nextAmmo);
      }

      const health = this.world.healths.get(entityId);
      if (health) {
        if (typeof player.maxHp === "number" && Number.isFinite(player.maxHp)) {
          health.max = Math.max(1, player.maxHp);
        }
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
    this.remoteVisibilityByPlayerId.delete(networkPlayerId);
    this.snapshotAmmoByPlayerId.delete(networkPlayerId);

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

    const heroDef = args.isLocal
      ? this.localHeroDef
      : HERO_DEFS[(args.networkPlayerId - 1 + HERO_DEFS.length) % HERO_DEFS.length] ?? this.localHeroDef;
    const weaponDef = WEAPON_DEF_BY_ID.get(heroDef.weaponId) ?? WEAPON_DEFS[0]!;

    this.world.transforms.set(entityId, { x: spawnX, y: 0, z: spawnZ, yaw: 0 });
    this.world.velocities.set(entityId, { x: 0, y: 0, z: 0 });
    this.world.healths.set(entityId, {
      current: heroDef.baseHp,
      max: heroDef.baseHp,
      shield: 0,
    });
    this.world.teams.set(entityId, { id: args.isLocal ? 1 : 2 });
    this.world.weapons.set(entityId, {
      weaponId: weaponDef.id,
      cooldownMs: Math.round(1000 / Math.max(1, weaponDef.fireRate)),
      lastFiredAtMs: -1,
      ammo: weaponDef.ammo,
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

  private spawnLocalShotTrails(shotCount: number): void {
    const transform = this.world.transforms.get(this.localPlayerEntityId);
    const weapon = this.world.weapons.get(this.localPlayerEntityId);
    const team = this.world.teams.get(this.localPlayerEntityId);
    if (!transform || !weapon) return;

    const weaponDef = WEAPON_DEF_BY_ID.get(weapon.weaponId) ?? WEAPON_DEFS[0]!;
    const range = Math.max(4, weaponDef.range);

    const dir = new THREE.Vector2(Math.sin(transform.yaw), Math.cos(transform.yaw));
    if (dir.lengthSq() < 1e-6) {
      dir.set(0, 1);
    }

    const origin = new THREE.Vector3(transform.x, BULLET_TRAIL_MUZZLE_HEIGHT, transform.z);
    const trailColor = getTeamTrailColor(team?.id ?? 1);
    for (let i = 0; i < shotCount; i += 1) {
      this.spawnMuzzleFlash(origin, dir, trailColor);
      this.spawnBulletTrail(origin, dir, range, trailColor);
    }
  }

  private spawnRemoteShotTrails(player: NetworkPlayerState, shotCount: number): void {
    const heroId = typeof player.heroId === "string" ? normalizeHeroId(player.heroId) : DEFAULT_HERO_ID;
    const heroDef = pickHeroDef(heroId);
    const weaponDef = WEAPON_DEF_BY_ID.get(heroDef.weaponId) ?? WEAPON_DEFS[0]!;
    const range = Math.max(4, weaponDef.range);

    const dir = new THREE.Vector2(Math.sin(player.rot), Math.cos(player.rot));
    if (dir.lengthSq() < 1e-6) {
      dir.set(0, 1);
    }

    const origin = new THREE.Vector3(player.x, BULLET_TRAIL_MUZZLE_HEIGHT, player.y);
    const trailColor = getTeamTrailColor(player.team);
    for (let i = 0; i < shotCount; i += 1) {
      this.spawnMuzzleFlash(origin, dir, trailColor);
      this.spawnBulletTrail(origin, dir, range, trailColor);
    }
  }

  private spawnMuzzleFlash(origin: THREE.Vector3, directionXZ: THREE.Vector2, flashColor: number): void {
    const dir2 = directionXZ.clone();
    if (dir2.lengthSq() < 1e-6) {
      return;
    }

    dir2.normalize();
    const direction = new THREE.Vector3(dir2.x, 0, dir2.y).normalize();

    const muzzleCenter = origin.clone().addScaledVector(direction, 0.34);

    const flashConeGeometry = new THREE.ConeGeometry(
      MUZZLE_FLASH_RADIUS,
      MUZZLE_FLASH_LENGTH,
      10,
      1,
      true,
    );
    const flashConeMaterial = new THREE.MeshBasicMaterial({
      color: flashColor,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const flashCone = new THREE.Mesh(flashConeGeometry, flashConeMaterial);
    flashCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    flashCone.position.copy(muzzleCenter).addScaledVector(direction, MUZZLE_FLASH_LENGTH * 0.45);
    flashCone.renderOrder = 57;
    flashCone.frustumCulled = false;

    const flashGlowGeometry = new THREE.SphereGeometry(MUZZLE_FLASH_RADIUS * 0.9, 10, 10);
    const flashGlowMaterial = new THREE.MeshBasicMaterial({
      color: flashColor,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const flashGlow = new THREE.Mesh(flashGlowGeometry, flashGlowMaterial);
    flashGlow.position.copy(muzzleCenter);
    flashGlow.renderOrder = 58;
    flashGlow.frustumCulled = false;

    this.sceneRoot.scene.add(flashCone);
    this.sceneRoot.scene.add(flashGlow);

    this.muzzleFlashEffects.push({
      flashCone,
      flashConeGeometry,
      flashConeMaterial,
      flashGlow,
      flashGlowGeometry,
      flashGlowMaterial,
      ageMs: 0,
      lifeMs: MUZZLE_FLASH_LIFE_MS,
    });
  }

  private spawnBulletTrail(
    origin: THREE.Vector3,
    directionXZ: THREE.Vector2,
    distance: number,
    trailColor: number,
  ): void {
    const dir = directionXZ.clone();
    if (dir.lengthSq() < 1e-6) {
      return;
    }

    dir.normalize();

    const spread = (Math.random() - 0.5) * 0.015;
    const cos = Math.cos(spread);
    const sin = Math.sin(spread);
    const dx = dir.x * cos - dir.y * sin;
    const dz = dir.x * sin + dir.y * cos;

    const direction = new THREE.Vector3(dx, 0, dz).normalize();
    const maxDistance = Math.max(2.6, Math.min(distance, 11 + Math.random() * 2.2));
    const speed = BULLET_PROJECTILE_SPEED * (0.95 + Math.random() * 0.12);
    const trailLength = BULLET_TRAIL_LENGTH * (0.92 + Math.random() * 0.2);

    const trailGeometry = new THREE.CylinderGeometry(
      BULLET_TRAIL_RADIUS * 0.74,
      BULLET_TRAIL_RADIUS,
      trailLength,
      12,
      1,
      true,
    );
    const trailMaterial = new THREE.MeshBasicMaterial({
      color: trailColor,
      transparent: true,
      opacity: 0.97,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const trail = new THREE.Mesh(trailGeometry, trailMaterial);
    trail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    trail.renderOrder = 50;
    trail.frustumCulled = false;

    const glowTrailGeometry = new THREE.CylinderGeometry(
      BULLET_TRAIL_RADIUS * 1.95,
      BULLET_TRAIL_RADIUS * 2.2,
      trailLength,
      12,
      1,
      true,
    );
    const glowTrailMaterial = new THREE.MeshBasicMaterial({
      color: trailColor,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const glowTrail = new THREE.Mesh(glowTrailGeometry, glowTrailMaterial);
    glowTrail.quaternion.copy(trail.quaternion);
    glowTrail.renderOrder = 49;
    glowTrail.frustumCulled = false;

    const impactGeometry = new THREE.SphereGeometry(BULLET_IMPACT_RADIUS, 10, 10);
    const impactMaterial = new THREE.MeshBasicMaterial({
      color: trailColor,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const impact = new THREE.Mesh(impactGeometry, impactMaterial);
    impact.renderOrder = 51;

    this.sceneRoot.scene.add(glowTrail);
    this.sceneRoot.scene.add(trail);
    this.sceneRoot.scene.add(impact);

    const startOffset = Math.min(0.24, maxDistance * 0.1);
    const lifeMs = Math.max(BULLET_TRAIL_LIFE_MS, (maxDistance / speed) * 1000 + 120);

    const effect: BulletTrailEffect = {
      origin: origin.clone(),
      direction,
      speed,
      maxDistance,
      traveledDistance: startOffset,
      trailLength,
      trail,
      trailGeometry,
      trailMaterial,
      glowTrail,
      glowTrailGeometry,
      glowTrailMaterial,
      impact,
      impactGeometry,
      impactMaterial,
      ageMs: 0,
      lifeMs,
    };

    this.bulletTrailEffects.push(effect);
  }

  private updateBulletTrailEffects(frameMs: number): void {
    const dtSec = Math.max(0, frameMs) / 1000;

    for (let i = this.bulletTrailEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.bulletTrailEffects[i]!;
      effect.ageMs += frameMs;
      effect.traveledDistance = Math.min(
        effect.maxDistance,
        effect.traveledDistance + effect.speed * dtSec,
      );

      const headDistance = effect.traveledDistance;
      const tailDistance = Math.max(0, headDistance - effect.trailLength);
      const visibleLength = Math.max(0.06, headDistance - tailDistance);

      const headPos = effect.origin
        .clone()
        .addScaledVector(effect.direction, headDistance);
      const tailPos = effect.origin
        .clone()
        .addScaledVector(effect.direction, tailDistance);
      const center = headPos.clone().add(tailPos).multiplyScalar(0.5);

      const lengthScale = visibleLength / effect.trailLength;
      const widthScale = 1 + Math.min(1, headDistance / effect.maxDistance) * 0.25;

      effect.trail.position.copy(center);
      effect.trail.scale.set(widthScale, lengthScale, widthScale);

      effect.glowTrail.position.copy(center);
      effect.glowTrail.scale.set(widthScale * 1.35, lengthScale, widthScale * 1.35);

      effect.impact.position.copy(headPos);
      const tipPulse = 1 + 0.18 * Math.sin(effect.ageMs * 0.045);
      effect.impact.scale.setScalar(tipPulse);

      const progress = Math.min(1, headDistance / effect.maxDistance);
      const ageT = Math.min(1, effect.ageMs / effect.lifeMs);
      const fadeByProgress = progress < 0.86 ? 1 : Math.max(0, 1 - (progress - 0.86) / 0.14);
      const fadeByAge = ageT < 0.82 ? 1 : Math.max(0, 1 - (ageT - 0.82) / 0.18);
      const fade = Math.min(fadeByProgress, fadeByAge);

      effect.trailMaterial.opacity = 0.97 * fade;
      effect.glowTrailMaterial.opacity = 0.42 * fade;
      effect.impactMaterial.opacity = 0.95 * fade;

      if (fade <= 0.01 || (headDistance >= effect.maxDistance && effect.ageMs > effect.lifeMs * 0.9)) {
        this.sceneRoot.scene.remove(effect.trail);
        this.sceneRoot.scene.remove(effect.glowTrail);
        this.sceneRoot.scene.remove(effect.impact);
        effect.trailGeometry.dispose();
        effect.trailMaterial.dispose();
        effect.glowTrailGeometry.dispose();
        effect.glowTrailMaterial.dispose();
        effect.impactGeometry.dispose();
        effect.impactMaterial.dispose();
        this.bulletTrailEffects.splice(i, 1);
      }
    }
  }

  private updateMuzzleFlashEffects(frameMs: number): void {
    for (let i = this.muzzleFlashEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.muzzleFlashEffects[i]!;
      effect.ageMs += frameMs;
      const t = Math.min(1, effect.ageMs / effect.lifeMs);
      const fade = 1 - t;

      effect.flashConeMaterial.opacity = 0.95 * fade;
      effect.flashGlowMaterial.opacity = 0.65 * fade;

      const coneScale = 1 + t * 0.55;
      effect.flashCone.scale.set(1 + t * 0.2, coneScale, 1 + t * 0.2);

      const glowScale = 0.85 + t * 1.15;
      effect.flashGlow.scale.setScalar(glowScale);

      if (t >= 1 || fade <= 0.01) {
        this.sceneRoot.scene.remove(effect.flashCone);
        this.sceneRoot.scene.remove(effect.flashGlow);
        effect.flashConeGeometry.dispose();
        effect.flashConeMaterial.dispose();
        effect.flashGlowGeometry.dispose();
        effect.flashGlowMaterial.dispose();
        this.muzzleFlashEffects.splice(i, 1);
      }
    }
  }

  private clearBulletEffects(): void {
    for (const effect of this.bulletTrailEffects) {
      this.sceneRoot.scene.remove(effect.trail);
      this.sceneRoot.scene.remove(effect.glowTrail);
      this.sceneRoot.scene.remove(effect.impact);
      effect.trailGeometry.dispose();
      effect.trailMaterial.dispose();
      effect.glowTrailGeometry.dispose();
      effect.glowTrailMaterial.dispose();
      effect.impactGeometry.dispose();
      effect.impactMaterial.dispose();
    }

    this.bulletTrailEffects.length = 0;
  }

  private clearMuzzleFlashEffects(): void {
    for (const effect of this.muzzleFlashEffects) {
      this.sceneRoot.scene.remove(effect.flashCone);
      this.sceneRoot.scene.remove(effect.flashGlow);
      effect.flashConeGeometry.dispose();
      effect.flashConeMaterial.dispose();
      effect.flashGlowGeometry.dispose();
      effect.flashGlowMaterial.dispose();
    }

    this.muzzleFlashEffects.length = 0;
  }

  private spawnDamageNumber(
    worldX: number,
    worldZ: number,
    damage: number,
    critical: boolean,
    mode: "outgoing" | "incoming",
  ): void {
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 136;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const isIncoming = mode === "incoming";
    const text = isIncoming ? `-${damage}` : critical ? `CRIT ${damage}` : String(damage);

    const fill = isIncoming ? (critical ? "#ff9f9f" : "#ff6a6a") : critical ? "#ffe77d" : "#ffffff";

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = critical ? "900 64px Inter, Pretendard, sans-serif" : "800 58px Inter, Pretendard, sans-serif";
    ctx.lineWidth = critical ? 12 : 10;
    ctx.strokeStyle = isIncoming ? "rgba(43,0,0,0.82)" : "rgba(0,0,0,0.78)";
    ctx.fillStyle = fill;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      opacity: 1,
    });

    const sprite = new THREE.Sprite(material);
    const baseScale = isIncoming ? (critical ? 1.4 : 1.18) : critical ? 1.35 : 1.05;
    sprite.scale.set(baseScale, baseScale * 0.5, 1);
    sprite.position.set(
      worldX + (Math.random() - 0.5) * (isIncoming ? 0.12 : 0.2),
      BULLET_TRAIL_MUZZLE_HEIGHT + (isIncoming ? 1.0 : 0.78),
      worldZ + (Math.random() - 0.5) * (isIncoming ? 0.12 : 0.2),
    );
    sprite.renderOrder = 60;

    this.sceneRoot.scene.add(sprite);

    this.damageNumberEffects.push({
      sprite,
      material,
      texture,
      ageMs: 0,
      lifeMs: isIncoming ? DAMAGE_TEXT_LIFE_MS + 70 : DAMAGE_TEXT_LIFE_MS,
      velocityY: DAMAGE_TEXT_FLOAT_SPEED * (isIncoming ? 1.08 : 1) * (0.9 + Math.random() * 0.3),
      drift: new THREE.Vector3((Math.random() - 0.5) * 0.2, 0, (Math.random() - 0.5) * 0.2),
      baseScale,
    });
  }

  private updateDamageNumberEffects(frameMs: number): void {
    const dtSec = Math.max(0, frameMs) / 1000;

    for (let i = this.damageNumberEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.damageNumberEffects[i]!;
      effect.ageMs += frameMs;

      effect.sprite.position.y += effect.velocityY * dtSec;
      effect.sprite.position.x += effect.drift.x * dtSec;
      effect.sprite.position.z += effect.drift.z * dtSec;

      const t = Math.min(1, effect.ageMs / effect.lifeMs);
      const fade = 1 - t;
      effect.material.opacity = fade;

      const scale = effect.baseScale * (1 + t * 0.28);
      effect.sprite.scale.set(scale, scale * 0.52, 1);

      if (t >= 1 || fade <= 0.01) {
        this.sceneRoot.scene.remove(effect.sprite);
        effect.material.dispose();
        effect.texture.dispose();
        this.damageNumberEffects.splice(i, 1);
      }
    }
  }

  private clearDamageNumberEffects(): void {
    for (const effect of this.damageNumberEffects) {
      this.sceneRoot.scene.remove(effect.sprite);
      effect.material.dispose();
      effect.texture.dispose();
    }

    this.damageNumberEffects.length = 0;
  }

  private ensureHitMarkerElement(): void {
    if (this.hitMarkerElement || typeof document === "undefined") return;

    const parent = this.renderer.renderer.domElement.parentElement;
    if (!parent) return;

    const marker = document.createElement("div");
    marker.textContent = "✕";
    marker.setAttribute("aria-hidden", "true");
    marker.style.position = "absolute";
    marker.style.left = "50%";
    marker.style.top = "50%";
    marker.style.transform = "translate(-50%, -50%) scale(0.72)";
    marker.style.opacity = "0";
    marker.style.pointerEvents = "none";
    marker.style.userSelect = "none";
    marker.style.fontSize = "42px";
    marker.style.fontWeight = "900";
    marker.style.lineHeight = "1";
    marker.style.color = "rgba(255,255,255,0.95)";
    marker.style.textShadow = "0 0 9px rgba(255,255,255,0.72), 0 0 18px rgba(255,255,255,0.35)";
    marker.style.zIndex = "16";

    parent.appendChild(marker);
    this.hitMarkerElement = marker;
  }

  private removeHitMarkerElement(): void {
    if (this.hitMarkerElement?.parentElement) {
      this.hitMarkerElement.parentElement.removeChild(this.hitMarkerElement);
    }
    this.hitMarkerElement = null;
    this.hitMarkerAgeMs = Number.POSITIVE_INFINITY;
  }

  private triggerHitMarker(critical: boolean): void {
    this.ensureHitMarkerElement();
    if (!this.hitMarkerElement) return;

    this.hitMarkerLifeMs = critical ? HIT_MARKER_LIFE_MS + 40 : HIT_MARKER_LIFE_MS;
    this.hitMarkerAgeMs = 0;
    this.hitMarkerElement.style.opacity = "1";
    this.hitMarkerElement.style.transform = "translate(-50%, -50%) scale(0.72)";

    if (critical) {
      this.hitMarkerElement.style.color = "rgba(255, 233, 140, 0.98)";
      this.hitMarkerElement.style.textShadow = "0 0 10px rgba(255,231,125,0.95), 0 0 22px rgba(255,201,90,0.56)";
    } else {
      this.hitMarkerElement.style.color = "rgba(255,255,255,0.95)";
      this.hitMarkerElement.style.textShadow = "0 0 9px rgba(255,255,255,0.72), 0 0 18px rgba(255,255,255,0.35)";
    }
  }

  private updateHitMarker(frameMs: number): void {
    if (!this.hitMarkerElement) return;
    if (!Number.isFinite(this.hitMarkerAgeMs)) return;

    this.hitMarkerAgeMs += frameMs;
    const t = Math.min(1, this.hitMarkerAgeMs / this.hitMarkerLifeMs);
    const fade = 1 - t;
    const scale = 0.72 + t * 0.32;

    this.hitMarkerElement.style.opacity = `${fade}`;
    this.hitMarkerElement.style.transform = `translate(-50%, -50%) scale(${scale})`;

    if (t >= 1 || fade <= 0.01) {
      this.hitMarkerElement.style.opacity = "0";
      this.hitMarkerAgeMs = Number.POSITIVE_INFINITY;
    }
  }

  private spawnImpactBurst(worldX: number, worldZ: number, critical: boolean): void {
    const innerRadius = critical ? 0.26 : 0.22;
    const outerRadius = critical ? 0.49 : 0.42;
    const ringGeometry = new THREE.RingGeometry(innerRadius, outerRadius, 28);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: critical ? 0xffb0b0 : 0xff6f6f,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(worldX, 0.06, worldZ);
    ring.renderOrder = 59;
    ring.frustumCulled = false;

    this.sceneRoot.scene.add(ring);

    this.impactBurstEffects.push({
      ring,
      ringGeometry,
      ringMaterial,
      ageMs: 0,
      lifeMs: critical ? 260 : 210,
    });
  }

  private updateImpactBurstEffects(frameMs: number): void {
    for (let i = this.impactBurstEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.impactBurstEffects[i]!;
      effect.ageMs += frameMs;
      const t = Math.min(1, effect.ageMs / effect.lifeMs);
      const fade = 1 - t;

      effect.ringMaterial.opacity = 0.92 * fade;
      const scale = 1 + t * 1.8;
      effect.ring.scale.setScalar(scale);

      if (t >= 1 || fade <= 0.01) {
        this.sceneRoot.scene.remove(effect.ring);
        effect.ringGeometry.dispose();
        effect.ringMaterial.dispose();
        this.impactBurstEffects.splice(i, 1);
      }
    }
  }

  private clearImpactBurstEffects(): void {
    for (const effect of this.impactBurstEffects) {
      this.sceneRoot.scene.remove(effect.ring);
      effect.ringGeometry.dispose();
      effect.ringMaterial.dispose();
    }

    this.impactBurstEffects.length = 0;
  }

  private ensureDamageOverlayElement(): void {
    if (this.damageOverlayElement || typeof document === "undefined") return;

    const parent = this.renderer.renderer.domElement.parentElement;
    if (!parent) return;

    const overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.opacity = "0";
    overlay.style.background =
      "radial-gradient(circle at center, rgba(255,40,40,0.0) 38%, rgba(255,54,54,0.25) 68%, rgba(180,0,0,0.48) 100%)";
    overlay.style.mixBlendMode = "screen";
    overlay.style.zIndex = "14";

    parent.appendChild(overlay);
    this.damageOverlayElement = overlay;
  }

  private removeDamageOverlayElement(): void {
    if (this.damageOverlayElement?.parentElement) {
      this.damageOverlayElement.parentElement.removeChild(this.damageOverlayElement);
    }
    this.damageOverlayElement = null;
    this.damageOverlayAgeMs = Number.POSITIVE_INFINITY;
  }

  private triggerDamageTakenOverlay(critical: boolean): void {
    this.ensureDamageOverlayElement();
    if (!this.damageOverlayElement) return;

    this.damageOverlayLifeMs = critical ? DAMAGE_OVERLAY_LIFE_MS + 80 : DAMAGE_OVERLAY_LIFE_MS;
    this.damageOverlayAgeMs = 0;
    this.damageOverlayElement.style.opacity = critical ? "0.9" : "0.72";
  }

  private updateDamageTakenOverlay(frameMs: number): void {
    if (!this.damageOverlayElement) return;
    if (!Number.isFinite(this.damageOverlayAgeMs)) return;

    this.damageOverlayAgeMs += frameMs;
    const t = Math.min(1, this.damageOverlayAgeMs / this.damageOverlayLifeMs);
    const fade = 1 - t;
    this.damageOverlayElement.style.opacity = `${fade * fade * 0.9}`;

    if (t >= 1 || fade <= 0.01) {
      this.damageOverlayElement.style.opacity = "0";
      this.damageOverlayAgeMs = Number.POSITIVE_INFINITY;
    }
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
