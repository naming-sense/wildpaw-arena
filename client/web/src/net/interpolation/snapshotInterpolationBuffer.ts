import { lerp } from "../../core/math/vec2";
import type { NetworkPlayerState, WorldSnapshot } from "../protocol/schemas";

function lerpPlayer(a: NetworkPlayerState, b: NetworkPlayerState, t: number): NetworkPlayerState {
  return {
    ...a,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    rot: lerp(a.rot, b.rot, t),
    vx: lerp(a.vx, b.vx, t),
    vy: lerp(a.vy, b.vy, t),
    hp: t < 0.5 ? a.hp : b.hp,
    shield: t < 0.5 ? a.shield : b.shield,
    alive: t < 0.5 ? a.alive : b.alive,
    lastProcessedInputSeq: Math.round(
      lerp(a.lastProcessedInputSeq, b.lastProcessedInputSeq, t),
    ),
  };
}

export class SnapshotInterpolationBuffer {
  private readonly snapshots: WorldSnapshot[] = [];

  constructor(
    private readonly interpolationDelayMs: number,
    private readonly maxExtrapolationMs: number,
    private readonly maxSnapshots = 64,
  ) {}

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
      serverTimeMs: targetTime,
      ackSeq: Math.round(lerp(older.ackSeq, newer.ackSeq, t)),
      players: newer.players.map((nextPlayer) => {
        const prev = olderById.get(nextPlayer.playerId);
        return prev ? lerpPlayer(prev, nextPlayer, t) : nextPlayer;
      }),
    };
  }
}
