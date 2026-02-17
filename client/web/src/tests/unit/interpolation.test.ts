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
});
