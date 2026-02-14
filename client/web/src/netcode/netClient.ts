import type { InputFrame, WorldSnapshot } from "./types";

export interface RealtimeClientOptions {
  url: string;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onEvent?: (eventName: string, payload: unknown) => void;
}

type Envelope = {
  seq?: number;
  ack?: number;
  ackBits?: number;
  t: string;
  d: unknown;
};

class SequenceTracker {
  private nextLocalSeq = 1;
  private highestRemoteSeq = 0;
  private readonly remoteWindow: number[] = [];

  nextOutgoingMeta(): { seq: number; ack: number; ackBits: number } {
    return {
      seq: this.nextLocalSeq++,
      ack: this.highestRemoteSeq,
      ackBits: this.buildAckBits(),
    };
  }

  noteRemote(seq: number): void {
    if (!Number.isFinite(seq) || seq <= 0) {
      return;
    }

    if (!this.remoteWindow.includes(seq)) {
      this.remoteWindow.push(seq);
      if (this.remoteWindow.length > 128) {
        this.remoteWindow.shift();
      }
    }

    if (seq > this.highestRemoteSeq) {
      this.highestRemoteSeq = seq;
    }
  }

  private buildAckBits(): number {
    if (this.highestRemoteSeq === 0) {
      return 0;
    }

    let ackBits = 0;
    for (const seq of this.remoteWindow) {
      if (seq >= this.highestRemoteSeq) {
        continue;
      }
      const diff = this.highestRemoteSeq - seq - 1;
      if (diff >= 0 && diff < 32) {
        ackBits |= 1 << diff;
      }
    }

    return ackBits >>> 0;
  }
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly sequenceTracker = new SequenceTracker();

  constructor(private readonly options: RealtimeClientOptions) {}

  connect(roomToken: string): void {
    this.ws = new WebSocket(this.options.url);

    this.ws.onopen = () => {
      this.send("C2S_HELLO", { roomToken, clientVersion: "0.2.0" });
    };

    this.ws.onmessage = (event: MessageEvent<string>) => {
      const parsed = JSON.parse(event.data) as Envelope;
      this.handleEnvelope(parsed);
    };
  }

  sendInput(input: InputFrame): void {
    this.send("C2S_INPUT", input);
  }

  sendPing(): void {
    this.send("C2S_PING", {});
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(type: string, data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const meta = this.sequenceTracker.nextOutgoingMeta();
    this.ws.send(
      JSON.stringify({
        seq: meta.seq,
        ack: meta.ack,
        ackBits: meta.ackBits,
        t: type,
        d: data,
      }),
    );
  }

  private handleEnvelope(envelope: Envelope): void {
    if (typeof envelope.seq === "number") {
      this.sequenceTracker.noteRemote(envelope.seq);
    }

    if (envelope.t === "S2C_SNAPSHOT_BASE" || envelope.t === "S2C_SNAPSHOT_DELTA") {
      this.options.onSnapshot?.(envelope.d as WorldSnapshot);
      return;
    }

    this.options.onEvent?.(envelope.t, envelope.d);
  }
}
