import {
  RealtimeClient,
  SnapshotInterpolationBuffer,
  RingBuffer,
  applyInput,
  reconcile,
  type CombatEventPacket,
  type InputFrame,
  type PlayerSnapshot,
  type ProjectileEventPacket,
  type WorldSnapshot,
} from "../../netcode";

export interface RuntimeInputState {
  moveX: -1 | 0 | 1;
  moveY: -1 | 0 | 1;
  fire: boolean;
  aimRadian: number;
  skillQ: boolean;
  skillE: boolean;
  skillR: boolean;
}

export interface EcsRenderAdapter {
  onSnapshot(players: PlayerSnapshot[], serverTick: number): void;
  onCombatEvent(event: CombatEventPacket): void;
  onProjectileEvent(event: ProjectileEventPacket): void;
  onLocalHud?(state: {
    ammo: number;
    maxAmmo: number;
    reloading: boolean;
    reloadRemainingTicks: number;
    skillQCooldownTicks: number;
    skillECooldownTicks: number;
    skillRCooldownTicks: number;
    castingSkill: number;
    castRemainingTicks: number;
  }): void;
}

export interface RealtimeEcsRuntimeOptions {
  url: string;
  roomToken: string;
  profileId?: string;
  renderAdapter: EcsRenderAdapter;
  interpolationDelayMs?: number;
  fixedDtSeconds?: number;
}

export class RealtimeEcsRuntime {
  private readonly interpolationBuffer = new SnapshotInterpolationBuffer(96);
  private readonly pendingInputs = new RingBuffer<InputFrame>(180);
  private readonly client: RealtimeClient;

  private readonly interpolationDelayMs: number;
  private readonly fixedDtSeconds: number;

  private localPlayerId: number | null = null;
  private localPredicted: PlayerSnapshot | null = null;

  private inputSeq = 1;
  private localTick = 0;
  private profileRequested = false;

  constructor(private readonly options: RealtimeEcsRuntimeOptions) {
    this.interpolationDelayMs = options.interpolationDelayMs ?? 100;
    this.fixedDtSeconds = options.fixedDtSeconds ?? 1 / 30;

    this.client = new RealtimeClient({
      url: options.url,
      onSnapshot: (snapshot) => this.onSnapshot(snapshot),
      onCombatEvent: (event) => {
        options.renderAdapter.onCombatEvent(event);
      },
      onProjectileEvent: (event) => {
        options.renderAdapter.onProjectileEvent(event);
      },
      onEvent: (eventName, payload) => {
        if (eventName === "S2C_WELCOME") {
          const body = payload as { playerId?: number };
          if (typeof body.playerId === "number") {
            this.localPlayerId = body.playerId;

            if (this.options.profileId && !this.profileRequested) {
              this.client.selectProfile(this.options.profileId);
              this.profileRequested = true;
            }
          }
        }
      },
    });
  }

  start(): void {
    this.client.connect(this.options.roomToken);
  }

  stop(): void {
    this.client.disconnect();
  }

  sendInput(state: RuntimeInputState): void {
    const input: InputFrame = {
      inputSeq: this.inputSeq++,
      localTick: this.localTick++,
      moveX: state.moveX,
      moveY: state.moveY,
      fire: state.fire,
      aimRadian: state.aimRadian,
      skillQ: state.skillQ,
      skillE: state.skillE,
      skillR: state.skillR,
    };

    this.pendingInputs.push(input);
    this.client.sendInput(input);

    if (this.localPredicted) {
      const predicted = applyInput(
        {
          position: this.localPredicted.position,
          velocity: this.localPredicted.velocity,
          lastAppliedInputSeq: this.localPredicted.lastProcessedInputSeq,
        },
        input,
        this.fixedDtSeconds,
      );

      this.localPredicted = {
        ...this.localPredicted,
        position: predicted.position,
        velocity: predicted.velocity,
        lastProcessedInputSeq: predicted.lastAppliedInputSeq,
      };
    }
  }

  step(nowMs: number): void {
    const sampled = this.interpolationBuffer.sample(nowMs - this.interpolationDelayMs);
    if (!sampled) {
      return;
    }

    const players = sampled.players.map((player) => {
      if (this.localPlayerId != null && player.playerId === this.localPlayerId) {
        return this.localPredicted ?? player;
      }
      return player;
    });

    this.options.renderAdapter.onSnapshot(players, sampled.serverTick);

    if (this.localPlayerId != null) {
      const local = players.find((it) => it.playerId === this.localPlayerId);
      if (local) {
        this.options.renderAdapter.onLocalHud?.({
          ammo: local.ammo,
          maxAmmo: local.maxAmmo,
          reloading: local.reloading,
          reloadRemainingTicks: local.reloadRemainingTicks,
          skillQCooldownTicks: local.skillQCooldownTicks,
          skillECooldownTicks: local.skillECooldownTicks,
          skillRCooldownTicks: local.skillRCooldownTicks,
          castingSkill: local.castingSkill,
          castRemainingTicks: local.castRemainingTicks,
        });
      }
    }
  }

  private onSnapshot(snapshot: WorldSnapshot): void {
    this.interpolationBuffer.push(snapshot);

    if (this.localPlayerId == null) {
      return;
    }

    const authoritative = snapshot.players.find(
      (player) => player.playerId === this.localPlayerId,
    );
    if (!authoritative) {
      return;
    }

    const pending = this.pendingInputs
      .toArray()
      .filter((input) => input.inputSeq > authoritative.lastProcessedInputSeq);

    const reconciled = reconcile(authoritative, pending, this.fixedDtSeconds);
    this.localPredicted = {
      ...authoritative,
      position: reconciled.position,
      velocity: reconciled.velocity,
      lastProcessedInputSeq: reconciled.lastAppliedInputSeq,
    };
  }
}
