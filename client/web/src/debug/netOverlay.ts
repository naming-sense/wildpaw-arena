export class NetMetricsTracker {
  pingMs = 0;
  jitterMs = 0;
  packetLossPct = 0;

  private previousPingMs = 0;
  private lastSnapshotTick = 0;
  private missingTicks = 0;
  private totalTicks = 0;

  onPing(pingMs: number): void {
    this.jitterMs = Math.abs(this.previousPingMs - pingMs);
    this.pingMs = pingMs;
    this.previousPingMs = pingMs;
  }

  onSnapshotTick(serverTick: number): void {
    if (this.lastSnapshotTick > 0 && serverTick > this.lastSnapshotTick + 1) {
      this.missingTicks += serverTick - this.lastSnapshotTick - 1;
    }

    if (this.lastSnapshotTick > 0) {
      this.totalTicks += 1;
      this.packetLossPct = (this.missingTicks / Math.max(1, this.totalTicks)) * 100;
    }

    this.lastSnapshotTick = serverTick;
  }
}
