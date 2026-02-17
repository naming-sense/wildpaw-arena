export class PerfTracker {
  private readonly frameTimes: number[] = [];
  private readonly maxSamples = 90;

  recordFrame(frameMs: number): void {
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > this.maxSamples) this.frameTimes.shift();
  }

  get fps(): number {
    if (this.frameTimes.length === 0) return 0;
    const avg = this.frameTimes.reduce((acc, v) => acc + v, 0) / this.frameTimes.length;
    return avg > 0 ? 1000 / avg : 0;
  }

  get frameMs(): number {
    if (this.frameTimes.length === 0) return 0;
    return this.frameTimes[this.frameTimes.length - 1];
  }
}
