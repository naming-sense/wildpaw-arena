import { describe, expect, it } from "vitest";
import { SnapshotInterpolationBuffer } from "../../net/interpolation/snapshotInterpolationBuffer";

describe("SnapshotInterpolationBuffer", () => {
  it("interpolates two snapshots", () => {
    const buffer = new SnapshotInterpolationBuffer(0, 100, 8);

    buffer.push({
      serverTick: 1,
      serverTimeMs: 1000,
      ackSeq: 1,
      players: [
        {
          playerId: 1,
          team: 1,
          x: 0,
          y: 0,
          rot: 0,
          vx: 1,
          vy: 0,
          hp: 100,
          shield: 0,
          alive: true,
          lastProcessedInputSeq: 1,
        },
      ],
    });

    buffer.push({
      serverTick: 2,
      serverTimeMs: 1100,
      ackSeq: 2,
      players: [
        {
          playerId: 1,
          team: 1,
          x: 10,
          y: 0,
          rot: 0,
          vx: 1,
          vy: 0,
          hp: 100,
          shield: 0,
          alive: true,
          lastProcessedInputSeq: 2,
        },
      ],
    });

    const sampled = buffer.sample(1050);
    expect(sampled).not.toBeNull();
    expect(sampled?.players[0].x).toBeCloseTo(5, 1);
  });

  it("interpolates aim through the shortest angle and keeps authoritative combat state", () => {
    const buffer = new SnapshotInterpolationBuffer(0, 100, 8);

    buffer.push({
      serverTick: 10,
      serverTickRate: 30,
      serverTimeMs: 1000,
      ackSeq: 10,
      players: [
        {
          playerId: 7,
          team: 2,
          x: 0,
          y: 0,
          rot: Math.PI - 0.1,
          aimRadian: Math.PI - 0.1,
          vx: 0,
          vy: 0,
          hp: 100,
          shield: 0,
          alive: true,
          lastProcessedInputSeq: 10,
          heroId: "lumifox",
          reloading: false,
          skillQCooldownTicks: 5,
          castingSkill: 0,
        },
      ],
    });

    buffer.push({
      serverTick: 11,
      serverTickRate: 30,
      serverTimeMs: 1100,
      ackSeq: 11,
      players: [
        {
          playerId: 7,
          team: 2,
          x: 0,
          y: 0,
          rot: -Math.PI + 0.1,
          aimRadian: -Math.PI + 0.1,
          vx: 0,
          vy: 0,
          hp: 100,
          shield: 0,
          alive: true,
          lastProcessedInputSeq: 11,
          heroId: "lumifox",
          reloading: true,
          reloadRemainingTicks: 12,
          skillQCooldownTicks: 4,
          castingSkill: 1,
          castRemainingTicks: 2,
        },
      ],
    });

    const sampled = buffer.sample(1060);
    const player = sampled?.players[0];

    expect(player).toBeDefined();
    expect(Math.abs(player?.aimRadian ?? 0)).toBeGreaterThan(3);
    expect(player?.heroId).toBe("lumifox");
    expect(player?.reloading).toBe(true);
    expect(player?.skillQCooldownTicks).toBe(4);
    expect(player?.castingSkill).toBe(1);
    expect(player?.castRemainingTicks).toBe(2);
  });
});
