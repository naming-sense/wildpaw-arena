import * as flatbuffers from "flatbuffers";

import { ActionCommandPayload } from "../netcode/gen/wildpaw/protocol/action-command-payload";
import { CombatEventPayload } from "../netcode/gen/wildpaw/protocol/combat-event-payload";
import { CombatEventType } from "../netcode/gen/wildpaw/protocol/combat-event-type";
import { SkillSlot } from "../netcode/gen/wildpaw/protocol/skill-slot";
import { Envelope } from "../netcode/gen/wildpaw/protocol/envelope";
import { EventPayload } from "../netcode/gen/wildpaw/protocol/event-payload";
import { HelloPayload } from "../netcode/gen/wildpaw/protocol/hello-payload";
import { MessagePayload } from "../netcode/gen/wildpaw/protocol/message-payload";
import { SelectProfilePayload } from "../netcode/gen/wildpaw/protocol/select-profile-payload";
import { PingPayload } from "../netcode/gen/wildpaw/protocol/ping-payload";
import { ProjectileEventPayload } from "../netcode/gen/wildpaw/protocol/projectile-event-payload";
import { SnapshotKind } from "../netcode/gen/wildpaw/protocol/snapshot-kind";
import { SnapshotPayload } from "../netcode/gen/wildpaw/protocol/snapshot-payload";
import { WelcomePayload } from "../netcode/gen/wildpaw/protocol/welcome-payload";
import type { InputCommand, NetworkPlayerState, WorldSnapshot } from "./protocol/schemas";

export type ConnectionState =
  | "Disconnected"
  | "Connected"
  | "Unstable"
  | "Reconnecting"
  | "Failed";

export interface RealtimeSocketClientOptions {
  url?: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  heroId?: string;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onStateChange?: (state: ConnectionState) => void;
  onEvent?: (name: string, payload: unknown) => void;
  onPing?: (pingMs: number) => void;
}

const HERO_ID_STORAGE_KEY = "wildpaw-hero-id";

function normalizeHeroId(rawHeroId: string): string {
  const heroId = rawHeroId.trim();
  return heroId === "whitecat_commando" ? "coral_cat" : heroId;
}

function getPreferredHeroId(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) {
    return normalizeHeroId(explicit);
  }

  if (typeof window === "undefined") {
    return "coral_cat";
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("hero");
    if (fromQuery && fromQuery.trim().length > 0) {
      const hero = normalizeHeroId(fromQuery);
      window.localStorage.setItem(HERO_ID_STORAGE_KEY, hero);
      return hero;
    }

    const stored = window.localStorage.getItem(HERO_ID_STORAGE_KEY);
    if (stored && stored.trim().length > 0) {
      return normalizeHeroId(stored);
    }
  } catch {
    // ignore localStorage/query parsing failures
  }

  return "coral_cat";
}

function resolveServerProfileId(heroId: string): string {
  switch (heroId) {
    case "bruno_bear":
      return "bruno_bear";
    case "coral_cat":
      return "coral_cat";
    case "rockhorn_rhino":
      return "bruiser";
    case "lumifox":
      return "skirmisher";
    default:
      return "ranger";
  }
}

class SequenceTracker {
  private nextLocalSeq = 1;
  private highestRemoteSeq = 0;
  private readonly remoteWindow: number[] = [];

  reset(): void {
    this.nextLocalSeq = 1;
    this.highestRemoteSeq = 0;
    this.remoteWindow.length = 0;
  }

  nextOutgoingMeta(): { seq: number; ack: number; ackBits: number } {
    return {
      seq: this.nextLocalSeq++,
      ack: this.highestRemoteSeq,
      ackBits: this.buildAckBits(),
    };
  }

  noteRemote(seq: number): void {
    if (!Number.isFinite(seq) || seq <= 0) {
      return;
    }

    if (!this.remoteWindow.includes(seq)) {
      this.remoteWindow.push(seq);
      if (this.remoteWindow.length > 128) {
        this.remoteWindow.shift();
      }
    }

    if (seq > this.highestRemoteSeq) {
      this.highestRemoteSeq = seq;
    }
  }

  private buildAckBits(): number {
    if (this.highestRemoteSeq === 0) {
      return 0;
    }

    let ackBits = 0;
    for (const seq of this.remoteWindow) {
      if (seq >= this.highestRemoteSeq) {
        continue;
      }
      const diff = this.highestRemoteSeq - seq - 1;
      if (diff >= 0 && diff < 32) {
        ackBits |= 1 << diff;
      }
    }

    return ackBits >>> 0;
  }
}

function normalizeMoveAxis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 0.1) return 1;
  if (value < -0.1) return -1;
  return 0;
}

interface CachedPlayerState {
  state: NetworkPlayerState;
  updatedAtMs: number;
}

export class RealtimeSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private state: ConnectionState = "Disconnected";
  private pingSentAt = 0;
  private keepAliveTimer: number | null = null;
  private manualDisconnect = false;
  private readonly heroId: string;

  private lastRoomToken = "dev-room";
  private readonly sequenceTracker = new SequenceTracker();
  private readonly seenRemoteEnvelopeSeqs: number[] = [];
  private readonly lastYawByPlayerId = new Map<number, number>();
  private readonly playerStateCache = new Map<number, CachedPlayerState>();
  private localNetworkPlayerId = 1;
  private localTeamId = 1;
  private lastAimRadian = 0;
  private lastAckSeq = 0;

  constructor(private readonly options: RealtimeSocketClientOptions) {
    this.heroId = getPreferredHeroId(options.heroId);
  }

  connect(roomToken = "dev-room"): void {
    this.lastRoomToken = roomToken;

    if (!this.options.url) {
      this.setState("Disconnected");
      return;
    }

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.manualDisconnect = false;
    this.clearKeepAliveTimer();
    this.playerStateCache.clear();
    this.lastYawByPlayerId.clear();
    this.lastAckSeq = 0;
    this.sequenceTracker.reset();
    this.seenRemoteEnvelopeSeqs.length = 0;

    this.ws = new WebSocket(this.options.url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("Connected");
      this.sendHello(this.lastRoomToken);
      this.sendSelectProfile(resolveServerProfileId(this.heroId));
      this.startKeepAlive();
    };

    this.ws.onerror = () => {
      this.setState("Unstable");
    };

    this.ws.onclose = () => {
      this.clearKeepAliveTimer();
      if (this.manualDisconnect) {
        this.setState("Disconnected");
        return;
      }
      this.scheduleReconnect();
    };

    this.ws.onmessage = (event) => {
      void this.handleIncoming(event.data);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.manualDisconnect = true;
    this.clearKeepAliveTimer();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }

    this.ws = null;
    this.setState("Disconnected");
  }

  sendInput(command: InputCommand): boolean {
    let aimRadian =
      typeof command.aimRadian === "number" && Number.isFinite(command.aimRadian)
        ? command.aimRadian
        : Number.NaN;

    if (!Number.isFinite(aimRadian)) {
      const originX =
        typeof command.originX === "number" && Number.isFinite(command.originX)
          ? command.originX
          : 0;
      const originY =
        typeof command.originY === "number" && Number.isFinite(command.originY)
          ? command.originY
          : 0;
      const aimDx = command.aimX - originX;
      const aimDy = command.aimY - originY;

      if (Math.hypot(aimDx, aimDy) > 0.0001) {
        aimRadian = Math.atan2(aimDx, aimDy);
      } else {
        aimRadian = this.lastAimRadian;
      }
    }

    if (!Number.isFinite(aimRadian)) {
      aimRadian = 0;
    }

    this.lastAimRadian = aimRadian;

    return this.sendBinary((builder, meta) => {
      const payloadOffset = ActionCommandPayload.createActionCommandPayload(
        builder,
        command.seq,
        normalizeMoveAxis(command.moveX),
        normalizeMoveAxis(command.moveY),
        Boolean(command.fire),
        aimRadian,
        Boolean(command.skillQ),
        Boolean(command.skillE),
        Boolean(command.skillR),
      );

      return {
        payloadType: MessagePayload.ActionCommandPayload,
        payloadOffset,
        meta,
      };
    });
  }

  sendPing(): boolean {
    this.pingSentAt = performance.now();

    return this.sendBinary((builder, meta) => {
      const payloadOffset = PingPayload.createPingPayload(builder);
      return {
        payloadType: MessagePayload.PingPayload,
        payloadOffset,
        meta,
      };
    });
  }

  private sendHello(roomToken: string): boolean {
    return this.sendBinary((builder, meta) => {
      const roomTokenOffset = builder.createString(roomToken);
      const clientVersionOffset = builder.createString("0.4.0");
      const payloadOffset = HelloPayload.createHelloPayload(
        builder,
        roomTokenOffset,
        clientVersionOffset,
      );

      return {
        payloadType: MessagePayload.HelloPayload,
        payloadOffset,
        meta,
      };
    });
  }

  private sendSelectProfile(profileId: string): boolean {
    return this.sendBinary((builder, meta) => {
      const profileIdOffset = builder.createString(profileId);
      const payloadOffset = SelectProfilePayload.createSelectProfilePayload(
        builder,
        profileIdOffset,
      );

      return {
        payloadType: MessagePayload.SelectProfilePayload,
        payloadOffset,
        meta,
      };
    });
  }

  private sendBinary(
    encode: (
      builder: flatbuffers.Builder,
      meta: { seq: number; ack: number; ackBits: number },
    ) => {
      payloadType: MessagePayload;
      payloadOffset: flatbuffers.Offset;
      meta: { seq: number; ack: number; ackBits: number };
    },
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const builder = new flatbuffers.Builder(256);
    const meta = this.sequenceTracker.nextOutgoingMeta();
    const encoded = encode(builder, meta);

    const envelopeOffset = Envelope.createEnvelope(
      builder,
      encoded.meta.seq,
      encoded.meta.ack,
      encoded.meta.ackBits,
      encoded.payloadType,
      encoded.payloadOffset,
    );

    Envelope.finishEnvelopeBuffer(builder, envelopeOffset);
    this.ws.send(builder.asUint8Array());
    return true;
  }

  private async handleIncoming(data: string | ArrayBuffer | Blob): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.handleBinaryEnvelope(data);
      return;
    }

    if (data instanceof Blob) {
      this.handleBinaryEnvelope(await data.arrayBuffer());
      return;
    }

    try {
      const parsed = JSON.parse(String(data)) as { t?: string; d?: unknown };
      if (typeof parsed.t === "string") {
        this.handleLegacyJsonEnvelope(parsed.t, parsed.d);
        return;
      }
    } catch {
      // ignore parse error and report raw text below
    }

    this.options.onEvent?.("text.unexpected", data);
  }

  private handleLegacyJsonEnvelope(type: string, payload: unknown): void {
    if (type === "S2C_SNAPSHOT_BASE" || type === "S2C_SNAPSHOT_DELTA") {
      this.options.onSnapshot?.(payload as WorldSnapshot);
      return;
    }

    if (type === "S2C_PONG" || type === "C2S_PING") {
      if (this.pingSentAt > 0) {
        this.options.onPing?.(performance.now() - this.pingSentAt);
      }
      return;
    }

    this.options.onEvent?.(type, payload);
  }

  private isDuplicateRemoteEnvelopeSeq(seq: number): boolean {
    if (seq <= 0 || !Number.isFinite(seq)) {
      return false;
    }

    if (this.seenRemoteEnvelopeSeqs.includes(seq)) {
      return true;
    }

    this.seenRemoteEnvelopeSeqs.push(seq);
    if (this.seenRemoteEnvelopeSeqs.length > 256) {
      this.seenRemoteEnvelopeSeqs.shift();
    }

    return false;
  }

  private resolveTeamId(playerId: number): number {
    if (playerId === this.localNetworkPlayerId) {
      return this.localTeamId;
    }

    if ((playerId & 1) === (this.localNetworkPlayerId & 1)) {
      return this.localTeamId;
    }

    return this.localTeamId === 1 ? 2 : 1;
  }

  private handleBinaryEnvelope(buffer: ArrayBuffer): void {
    const byteBuffer = new flatbuffers.ByteBuffer(new Uint8Array(buffer));
    if (!Envelope.bufferHasIdentifier(byteBuffer)) {
      this.options.onEvent?.("binary.invalid_identifier", {
        byteLength: buffer.byteLength,
      });
      return;
    }

    const envelope = Envelope.getRootAsEnvelope(byteBuffer);
    this.sequenceTracker.noteRemote(envelope.seq());

    if (this.isDuplicateRemoteEnvelopeSeq(envelope.seq())) {
      return;
    }

    switch (envelope.payloadType()) {
      case MessagePayload.WelcomePayload: {
        const welcome = envelope.payload(new WelcomePayload()) as WelcomePayload | null;
        if (!welcome) {
          return;
        }

        this.localNetworkPlayerId = welcome.playerId();
        this.playerStateCache.clear();
        this.lastYawByPlayerId.clear();
        this.lastAckSeq = 0;

        this.options.onEvent?.("S2C_WELCOME", {
          playerId: welcome.playerId(),
          serverTick: welcome.serverTick(),
          serverTickRate: welcome.serverTickRate(),
          serverTimeMs: Date.now(),
          heroId: this.heroId,
        });
        return;
      }

      case MessagePayload.SnapshotPayload: {
        const snapshotPayload = envelope.payload(new SnapshotPayload()) as SnapshotPayload | null;
        if (!snapshotPayload) {
          return;
        }

        const serverTimeMsRaw = Number(snapshotPayload.serverTimeMs());
        const serverTimeMs = Number.isFinite(serverTimeMsRaw)
          ? serverTimeMsRaw
          : Date.now();

        if (snapshotPayload.kind() === SnapshotKind.Base) {
          this.playerStateCache.clear();
        }

        for (let i = 0; i < snapshotPayload.playersLength(); i += 1) {
          const player = snapshotPayload.players(i);
          if (!player) {
            continue;
          }

          const playerId = player.playerId();
          const position = player.position();
          const velocity = player.velocity();

          const vx = velocity?.x() ?? 0;
          const vy = velocity?.y() ?? 0;

          const previousYaw = this.lastYawByPlayerId.get(playerId) ?? 0;
          const nextYaw = Math.hypot(vx, vy) > 0.001 ? Math.atan2(vx, vy) : previousYaw;
          this.lastYawByPlayerId.set(playerId, nextYaw);

          const teamFromServer = player.teamId();
          const mapped: NetworkPlayerState = {
            playerId,
            team:
              teamFromServer > 0
                ? teamFromServer
                : this.resolveTeamId(playerId),
            teamSlot: player.teamSlot(),
            x: position?.x() ?? 0,
            y: position?.y() ?? 0,
            rot: nextYaw,
            vx,
            vy,
            hp: player.hp(),
            maxHp: 100,
            shield: 0,
            alive: player.alive(),
            lastProcessedInputSeq: player.lastProcessedInputSeq(),
            ammo: player.ammo(),
            maxAmmo: player.maxAmmo(),
            reloading: player.isReloading(),
          };

          if (playerId === this.localNetworkPlayerId) {
            this.localTeamId = mapped.team === 2 ? 2 : 1;
            this.lastAckSeq = Math.max(this.lastAckSeq, mapped.lastProcessedInputSeq);
          }

          this.playerStateCache.set(playerId, {
            state: mapped,
            updatedAtMs: serverTimeMs,
          });
        }

        for (let i = 0; i < snapshotPayload.removedPlayerIdsLength(); i += 1) {
          const removedPlayerId = snapshotPayload.removedPlayerIds(i);
          if (typeof removedPlayerId !== "number" || !Number.isFinite(removedPlayerId)) {
            continue;
          }

          this.playerStateCache.delete(removedPlayerId);
          this.lastYawByPlayerId.delete(removedPlayerId);
        }

        const localCached = this.playerStateCache.get(this.localNetworkPlayerId);
        if (localCached) {
          this.lastAckSeq = Math.max(this.lastAckSeq, localCached.state.lastProcessedInputSeq);
        }

        const players = [...this.playerStateCache.values()]
          .map((entry) => entry.state)
          .sort((a, b) => a.playerId - b.playerId);

        const snapshot: WorldSnapshot = {
          serverTick: snapshotPayload.serverTick(),
          serverTimeMs,
          ackSeq: this.lastAckSeq,
          players,
        };

        this.options.onSnapshot?.(snapshot);
        this.options.onEvent?.(
          snapshotPayload.kind() === SnapshotKind.Delta
            ? "S2C_SNAPSHOT_DELTA"
            : "S2C_SNAPSHOT_BASE",
          { players: players.length },
        );
        return;
      }

      case MessagePayload.CombatEventPayload: {
        const combatPayload = envelope.payload(new CombatEventPayload()) as
          | CombatEventPayload
          | null;
        if (!combatPayload) {
          return;
        }

        const eventType = combatPayload.eventType();
        const rawSkillSlot = combatPayload.skillSlot();
        const skillSlot =
          rawSkillSlot === SkillSlot.Q
            ? "Q"
            : rawSkillSlot === SkillSlot.E
              ? "E"
              : rawSkillSlot === SkillSlot.R
                ? "R"
                : "None";

        const payload = {
          eventType,
          attackerPlayerId: combatPayload.sourcePlayerId(),
          targetPlayerId: combatPayload.targetPlayerId(),
          targetX: combatPayload.x(),
          targetY: combatPayload.y(),
          sourceX: combatPayload.x(),
          sourceY: combatPayload.y(),
          skillSlot,
          damage: combatPayload.damage(),
          critical: combatPayload.isCritical(),
          serverTick: combatPayload.serverTick(),
        };

        if (eventType === CombatEventType.DamageApplied) {
          this.options.onEvent?.("S2C_EVENT", {
            kind: "hit-confirm",
            ...payload,
          });

          this.options.onEvent?.("S2C_EVENT", {
            kind: "damage-taken",
            ...payload,
          });
          return;
        }

        if (eventType === CombatEventType.Knockout) {
          this.options.onEvent?.("S2C_EVENT", {
            kind: "knockout",
            ...payload,
          });
          return;
        }

        if (eventType === CombatEventType.SkillCast) {
          this.options.onEvent?.("S2C_EVENT", {
            kind: "skill-cast",
            ...payload,
          });
          return;
        }

        this.options.onEvent?.("S2C_COMBAT_EVENT", payload);
        return;
      }

      case MessagePayload.ProjectileEventPayload: {
        const projectilePayload = envelope.payload(new ProjectileEventPayload()) as
          | ProjectileEventPayload
          | null;
        if (!projectilePayload) {
          return;
        }

        this.options.onEvent?.("S2C_PROJECTILE_EVENT", {
          projectileId: projectilePayload.projectileId(),
          ownerPlayerId: projectilePayload.ownerPlayerId(),
          targetPlayerId: projectilePayload.targetPlayerId(),
          phase: projectilePayload.phase(),
          serverTick: projectilePayload.serverTick(),
          x: projectilePayload.x(),
          y: projectilePayload.y(),
          vx: projectilePayload.vx(),
          vy: projectilePayload.vy(),
        });

        return;
      }

      case MessagePayload.EventPayload: {
        const eventPayload = envelope.payload(new EventPayload()) as EventPayload | null;
        if (!eventPayload) {
          return;
        }

        const eventName = eventPayload.name() ?? "S2C_EVENT";
        const message = eventPayload.message() ?? "";

        if (eventName === "pong" && this.pingSentAt > 0) {
          this.options.onPing?.(performance.now() - this.pingSentAt);
        }

        if (eventName === "team.assigned" && message) {
          try {
            const parsed = JSON.parse(message) as { teamId?: unknown };
            if (typeof parsed.teamId === "number" && Number.isFinite(parsed.teamId)) {
              this.localTeamId = parsed.teamId === 2 ? 2 : 1;
            }
          } catch {
            // ignore parse errors
          }
        }

        this.options.onEvent?.(eventName, { message });
        this.options.onEvent?.("S2C_EVENT", {
          kind: eventName,
          message,
        });

        return;
      }

      case MessagePayload.PingPayload: {
        if (this.pingSentAt > 0) {
          this.options.onPing?.(performance.now() - this.pingSentAt);
        }
        return;
      }

      default:
        this.options.onEvent?.("binary.unknown_payload", {
          payloadType: envelope.payloadType(),
        });
        return;
    }
  }

  private scheduleReconnect(): void {
    if (!this.options.url) {
      this.setState("Failed");
      return;
    }

    this.setState("Reconnecting");
    this.reconnectAttempt += 1;

    const base = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** (this.reconnectAttempt - 1),
    );
    const jittered = base * (0.8 + Math.random() * 0.4);

    this.reconnectTimer = window.setTimeout(() => {
      this.connect(this.lastRoomToken);
    }, jittered);
  }

  private startKeepAlive(): void {
    this.clearKeepAliveTimer();

    this.keepAliveTimer = window.setInterval(() => {
      this.sendPing();
    }, 4000);
  }

  private clearKeepAliveTimer(): void {
    if (this.keepAliveTimer === null) {
      return;
    }

    window.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private setState(next: ConnectionState): void {
    if (next === this.state) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
