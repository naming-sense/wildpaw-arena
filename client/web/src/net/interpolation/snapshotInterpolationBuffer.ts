import { lerp } from "../../core/math/vec2";
import type { NetworkPlayerState, WorldSnapshot } from "../protocol/schemas";

function lerpAngle(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

function lerpPlayer(a: NetworkPlayerState, b: NetworkPlayerState, t: number): NetworkPlayerState {
  const aAim = typeof a.aimRadian === "number" ? a.aimRadian : a.rot;
  const bAim = typeof b.aimRadian === "number" ? b.aimRadian : b.rot;

  return {
    ...a,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    rot: lerpAngle(a.rot, b.rot, t),
    aimRadian: lerpAngle(aAim, bAim, t),
    vx: lerp(a.vx, b.vx, t),
    vy: lerp(a.vy, b.vy, t),
    hp: t < 0.5 ? a.hp : b.hp,
    maxHp: t < 0.5 ? a.maxHp : b.maxHp,
    shield: t < 0.5 ? a.shield : b.shield,
    alive: t < 0.5 ? a.alive : b.alive,
    lastProcessedInputSeq: Math.round(
      lerp(a.lastProcessedInputSeq, b.lastProcessedInputSeq, t),
    ),
    heroId: t < 0.5 ? a.heroId : b.heroId,
    heroName: t < 0.5 ? a.heroName : b.heroName,
    ammo: t < 0.5 ? a.ammo : b.ammo,
    maxAmmo: t < 0.5 ? a.maxAmmo : b.maxAmmo,
    reloading: t < 0.5 ? a.reloading : b.reloading,
    reloadRemainingTicks: t < 0.5 ? a.reloadRemainingTicks : b.reloadRemainingTicks,
    reloadRemainingSeconds: t < 0.5 ? a.reloadRemainingSeconds : b.reloadRemainingSeconds,
    skillQCooldownTicks: t < 0.5 ? a.skillQCooldownTicks : b.skillQCooldownTicks,
    skillQCooldownSeconds: t < 0.5 ? a.skillQCooldownSeconds : b.skillQCooldownSeconds,
    skillECooldownTicks: t < 0.5 ? a.skillECooldownTicks : b.skillECooldownTicks,
    skillECooldownSeconds: t < 0.5 ? a.skillECooldownSeconds : b.skillECooldownSeconds,
    skillRCooldownTicks: t < 0.5 ? a.skillRCooldownTicks : b.skillRCooldownTicks,
    skillRCooldownSeconds: t < 0.5 ? a.skillRCooldownSeconds : b.skillRCooldownSeconds,
    castingSkill: t < 0.5 ? a.castingSkill : b.castingSkill,
    castRemainingTicks: t < 0.5 ? a.castRemainingTicks : b.castRemainingTicks,
    castRemainingSeconds: t < 0.5 ? a.castRemainingSeconds : b.castRemainingSeconds,
  };
}

export class SnapshotInterpolationBuffer {
  private readonly snapshots: WorldSnapshot[] = [];

  constructor(
    private readonly interpolationDelayMs: number,
    private readonly maxExtrapolationMs: number,
    private readonly maxSnapshots = 64,
  ) {}

  clear(): void {
    this.snapshots.length = 0;
  }

  push(snapshot: WorldSnapshot): void {
    this.snapshots.push(snapshot);
    this.snapshots.sort((a, b) => a.serverTimeMs - b.serverTimeMs);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
  }

  sample(renderTimeMs: number): WorldSnapshot | null {
    if (this.snapshots.length === 0) return null;
    if (this.snapshots.length === 1) return this.snapshots[0];

    const targetTime = renderTimeMs - this.interpolationDelayMs;

    let older = this.snapshots[0];
    let newer = this.snapshots[this.snapshots.length - 1];

    for (let i = 0; i < this.snapshots.length - 1; i += 1) {
      const left = this.snapshots[i];
      const right = this.snapshots[i + 1];
      if (left.serverTimeMs <= targetTime && targetTime <= right.serverTimeMs) {
        older = left;
        newer = right;
        break;
      }
    }

    if (targetTime > newer.serverTimeMs) {
      const dt = Math.min(targetTime - newer.serverTimeMs, this.maxExtrapolationMs);
      return {
        ...newer,
        serverTimeMs: targetTime,
        players: newer.players.map((p) => ({
          ...p,
          x: p.x + p.vx * (dt / 1000),
          y: p.y + p.vy * (dt / 1000),
        })),
      };
    }

    const duration = Math.max(1, newer.serverTimeMs - older.serverTimeMs);
    const t = Math.min(1, Math.max(0, (targetTime - older.serverTimeMs) / duration));

    const olderById = new Map<number, NetworkPlayerState>();
    for (const player of older.players) olderById.set(player.playerId, player);

    return {
      serverTick: Math.round(lerp(older.serverTick, newer.serverTick, t)),
      serverTickRate: newer.serverTickRate ?? older.serverTickRate,
      serverTimeMs: targetTime,
      ackSeq: Math.round(lerp(older.ackSeq, newer.ackSeq, t)),
      players: newer.players.map((nextPlayer) => {
        const prev = olderById.get(nextPlayer.playerId);
        return prev ? lerpPlayer(prev, nextPlayer, t) : nextPlayer;
      }),
    };
  }
}
