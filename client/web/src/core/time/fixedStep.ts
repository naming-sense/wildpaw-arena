export class FixedStepRunner {
  private accumulatorMs = 0;
  private readonly maxFrameMs = 250;

  constructor(public readonly stepMs: number) {}

  advance(frameMs: number, runStep: (dtMs: number) => void): void {
    const clamped = Math.min(frameMs, this.maxFrameMs);
    this.accumulatorMs += clamped;

    while (this.accumulatorMs >= this.stepMs) {
      runStep(this.stepMs);
      this.accumulatorMs -= this.stepMs;
    }
  }
}
