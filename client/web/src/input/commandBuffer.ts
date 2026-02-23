import { RingBuffer } from "../core/util/ringBuffer";
import type { InputCommand } from "../net/protocol/schemas";
import type { RawInputState } from "./keyboardMouse";
import type { AimTarget } from "./aim";

const MOVE_AXIS_DEADZONE = 0.1;

function normalizeMoveAxis(value: number): -1 | 0 | 1 {
  if (!Number.isFinite(value)) return 0;
  if (value > MOVE_AXIS_DEADZONE) return 1;
  if (value < -MOVE_AXIS_DEADZONE) return -1;
  return 0;
}

export class CommandBuffer {
  private nextSeq = 1;
  private readonly pending = new RingBuffer<InputCommand>(256);
  private lastSent: InputCommand | null = null;

  create(nowMs: number, raw: RawInputState, aim: AimTarget): InputCommand {
    return {
      seq: this.nextSeq++,
      clientTime: nowMs,
      // Keep local prediction movement quantized exactly like network payload.
      // Otherwise local(sim) vs server(auth) diverges and causes jitter/reconcile snaps.
      moveX: normalizeMoveAxis(raw.moveX),
      moveY: normalizeMoveAxis(raw.moveY),
      aimX: aim.x,
      aimY: aim.y,
      fire: raw.fire,
      skillQ: raw.skillQ,
      skillE: raw.skillE,
      skillR: raw.skillR,
    };
  }

  shouldSend(command: InputCommand): boolean {
    if (!this.lastSent) {
      this.lastSent = command;
      return true;
    }

    const changed =
      command.moveX !== this.lastSent.moveX ||
      command.moveY !== this.lastSent.moveY ||
      command.fire !== this.lastSent.fire ||
      command.skillQ !== this.lastSent.skillQ ||
      command.skillE !== this.lastSent.skillE ||
      command.skillR !== this.lastSent.skillR ||
      Math.abs(command.aimX - this.lastSent.aimX) > 0.08 ||
      Math.abs(command.aimY - this.lastSent.aimY) > 0.08;

    if (changed) {
      this.lastSent = command;
    }

    return changed;
  }

  markSent(command: InputCommand): void {
    this.pending.push(command);
  }

  consumeAck(ackSeq: number): void {
    this.pending.retain((cmd) => cmd.seq > ackSeq);
  }

  pendingAfter(seq: number): InputCommand[] {
    return this.pending.toArray().filter((cmd) => cmd.seq > seq);
  }
}
