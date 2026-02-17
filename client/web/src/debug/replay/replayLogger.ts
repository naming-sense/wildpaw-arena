import type { InputCommand, WorldSnapshot } from "../../net/protocol/schemas";

interface ReplayLog {
  inputs: InputCommand[];
  snapshots: WorldSnapshot[];
}

export class ReplayLogger {
  private readonly log: ReplayLog = {
    inputs: [],
    snapshots: [],
  };

  logInput(input: InputCommand): void {
    this.log.inputs.push(input);
    if (this.log.inputs.length > 2000) this.log.inputs.shift();
  }

  logSnapshot(snapshot: WorldSnapshot): void {
    this.log.snapshots.push(snapshot);
    if (this.log.snapshots.length > 2000) this.log.snapshots.shift();
  }

  exportJson(): string {
    return JSON.stringify(this.log);
  }
}
