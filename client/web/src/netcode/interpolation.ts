import type { PlayerSnapshot, WorldSnapshot } from "./types";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPlayer(a: PlayerSnapshot, b: PlayerSnapshot, t: number): PlayerSnapshot {
  return {
    ...a,
    position: {
      x: lerp(a.position.x, b.position.x, t),
      y: lerp(a.position.y, b.position.y, t),
    },
    velocity: {
      x: lerp(a.velocity.x, b.velocity.x, t),
      y: lerp(a.velocity.y, b.velocity.y, t),
    },
    hp: t < 0.5 ? a.hp : b.hp,
    alive: t < 0.5 ? a.alive : b.alive,
    lastProcessedInputSeq: Math.round(
      lerp(a.lastProcessedInputSeq, b.lastProcessedInputSeq, t),
    ),
  };
}

export class SnapshotInterpolationBuffer {
  private readonly snapshots: WorldSnapshot[] = [];

  constructor(private readonly maxSnapshots = 64) {}

  push(snapshot: WorldSnapshot): void {
    this.snapshots.push(snapshot);
    this.snapshots.sort((lhs, rhs) => lhs.serverTimeMs - rhs.serverTimeMs);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
  }

  sample(renderTimeMs: number): WorldSnapshot | null {
    if (this.snapshots.length < 2) {
      return this.snapshots[0] ?? null;
    }

    let older = this.snapshots[0];
    let newer = this.snapshots[this.snapshots.length - 1];

    for (let i = 0; i < this.snapshots.length - 1; i += 1) {
      const left = this.snapshots[i];
      const right = this.snapshots[i + 1];
      if (left.serverTimeMs <= renderTimeMs && renderTimeMs <= right.serverTimeMs) {
        older = left;
        newer = right;
        break;
      }
    }

    const duration = Math.max(1, newer.serverTimeMs - older.serverTimeMs);
    const t = Math.min(1, Math.max(0, (renderTimeMs - older.serverTimeMs) / duration));

    const byId = new Map<number, PlayerSnapshot>();
    for (const player of older.players) byId.set(player.playerId, player);

    const players = newer.players.map((nextPlayer) => {
      const prev = byId.get(nextPlayer.playerId);
      return prev ? lerpPlayer(prev, nextPlayer, t) : nextPlayer;
    });

    return {
      serverTick: Math.round(lerp(older.serverTick, newer.serverTick, t)),
      serverTimeMs: renderTimeMs,
      players,
    };
  }
}
