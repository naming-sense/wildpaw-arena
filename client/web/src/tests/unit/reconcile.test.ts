import { describe, expect, it } from "vitest";
import { reconcileLocalState } from "../../net/reconciliation/reconcile";

describe("reconcileLocalState", () => {
  it("hard snap when error is too large", () => {
    const result = reconcileLocalState({
      authoritative: {
        playerId: 1,
        team: 1,
        x: 10,
        y: 10,
        rot: 0,
        vx: 0,
        vy: 0,
        hp: 100,
        shield: 0,
        alive: true,
        lastProcessedInputSeq: 5,
      },
      currentPredicted: {
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
        lastSeq: 5,
      },
      pendingCommands: [],
      dtSeconds: 1 / 30,
      moveSpeed: 5,
      hardSnapThreshold: 1,
      smoothCorrectionAlpha: 0.35,
    });

    expect(result.position.x).toBe(10);
    expect(result.position.y).toBe(10);
  });
});
