import type { InputFrame, PlayerSnapshot, WorldSnapshot } from "./types";

export interface RealtimeClientOptions {
  url: string;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onEvent?: (eventName: string, payload: unknown) => void;
}

type JsonEnvelope = {
  seq?: number;
  ack?: number;
  ackBits?: number;
  t: string;
  d: unknown;
};

const BINARY_MAGIC = 0x57445031; // "WDP1"
const BINARY_VERSION = 1;
const BINARY_TYPE_SNAPSHOT_DELTA = 1;
const BINARY_HEADER_SIZE = 36;
const BINARY_PLAYER_RECORD_SIZE = 28;

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

function toNumberFromU64(view: DataView, offset: number): number {
  if (typeof view.getBigUint64 === "function") {
    return Number(view.getBigUint64(offset, true));
  }

  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 2 ** 32 + low;
}

function decodeBinarySnapshotDelta(buffer: ArrayBuffer):
  | { seq: number; snapshot: WorldSnapshot }
  | null {
  if (buffer.byteLength < BINARY_HEADER_SIZE) {
    return null;
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  const version = view.getUint16(4, true);
  const messageType = view.getUint16(6, true);

  if (magic !== BINARY_MAGIC || version !== BINARY_VERSION) {
    return null;
  }

  if (messageType !== BINARY_TYPE_SNAPSHOT_DELTA) {
    return null;
  }

  const seq = view.getUint32(8, true);
  const serverTick = view.getUint32(20, true);
  const serverTimeMs = toNumberFromU64(view, 24);
  const playerCount = view.getUint16(32, true);

  const expectedSize = BINARY_HEADER_SIZE + playerCount * BINARY_PLAYER_RECORD_SIZE;
  if (buffer.byteLength < expectedSize) {
    return null;
  }

  const players: PlayerSnapshot[] = [];
  let offset = BINARY_HEADER_SIZE;

  for (let i = 0; i < playerCount; i += 1) {
    const playerId = view.getUint32(offset + 0, true);
    const posX = view.getFloat32(offset + 4, true);
    const posY = view.getFloat32(offset + 8, true);
    const velX = view.getFloat32(offset + 12, true);
    const velY = view.getFloat32(offset + 16, true);
    const hp = view.getUint16(offset + 20, true);
    const alive = view.getUint8(offset + 22) !== 0;
    const lastProcessedInputSeq = view.getUint32(offset + 24, true);

    players.push({
      playerId,
      position: { x: posX, y: posY },
      velocity: { x: velX, y: velY },
      hp,
      alive,
      lastProcessedInputSeq,
    });

    offset += BINARY_PLAYER_RECORD_SIZE;
  }

  return {
    seq,
    snapshot: {
      serverTick,
      serverTimeMs,
      players,
    },
  };
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly sequenceTracker = new SequenceTracker();

  constructor(private readonly options: RealtimeClientOptions) {}

  connect(roomToken: string): void {
    this.ws = new WebSocket(this.options.url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.send("C2S_HELLO", { roomToken, clientVersion: "0.3.0" });
    };

    this.ws.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
      void this.handleIncoming(event.data);
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

  private async handleIncoming(data: string | ArrayBuffer | Blob): Promise<void> {
    if (typeof data === "string") {
      this.handleJsonEnvelope(JSON.parse(data) as JsonEnvelope);
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.handleBinaryEnvelope(data);
      return;
    }

    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      this.handleBinaryEnvelope(buffer);
    }
  }

  private handleJsonEnvelope(envelope: JsonEnvelope): void {
    if (typeof envelope.seq === "number") {
      this.sequenceTracker.noteRemote(envelope.seq);
    }

    if (envelope.t === "S2C_SNAPSHOT_BASE") {
      this.options.onSnapshot?.(envelope.d as WorldSnapshot);
      return;
    }

    this.options.onEvent?.(envelope.t, envelope.d);
  }

  private handleBinaryEnvelope(buffer: ArrayBuffer): void {
    const decoded = decodeBinarySnapshotDelta(buffer);
    if (!decoded) {
      this.options.onEvent?.("binary.unknown", { byteLength: buffer.byteLength });
      return;
    }

    this.sequenceTracker.noteRemote(decoded.seq);
    this.options.onSnapshot?.(decoded.snapshot);
  }
}
