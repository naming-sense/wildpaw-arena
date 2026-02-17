import { describe, expect, it } from "vitest";
import { FixedStepRunner } from "../../core/time/fixedStep";

describe("fixed simulation runner", () => {
  it("runs expected number of fixed ticks", () => {
    const runner = new FixedStepRunner(33.333);
    let ticks = 0;

    runner.advance(100, () => {
      ticks += 1;
    });

    expect(ticks).toBe(3);
  });
});
