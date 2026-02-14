import * as flatbuffers from "flatbuffers";

import { ActionCommandPayload } from "../src/netcode/gen/wildpaw/protocol/action-command-payload";
import { Envelope } from "../src/netcode/gen/wildpaw/protocol/envelope";
import { HelloPayload } from "../src/netcode/gen/wildpaw/protocol/hello-payload";
import { MessagePayload } from "../src/netcode/gen/wildpaw/protocol/message-payload";
import { SnapshotPayload } from "../src/netcode/gen/wildpaw/protocol/snapshot-payload";

type Config = {
  url: string;
  clients: number;
  durationMs: number;
  inputIntervalMs: number;
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

function parseArgs(): Config {
  const args = process.argv.slice(2);

  const get = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length) {
      return fallback;
    }
    return args[index + 1]!;
  };

  return {
    url: get("--url", "ws://127.0.0.1:7001"),
    clients: Number(get("--clients", "100")),
    durationMs: Number(get("--duration-ms", "8000")),
    inputIntervalMs: Number(get("--input-interval-ms", "50")),
  };
}

function buildHelloFrame(meta: { seq: number; ack: number; ackBits: number }): Uint8Array {
  const builder = new flatbuffers.Builder(128);
  const roomToken = builder.createString("bench");
  const clientVersion = builder.createString("bench-0.2");
  const payload = HelloPayload.createHelloPayload(builder, roomToken, clientVersion);
  const envelope = Envelope.createEnvelope(
    builder,
    meta.seq,
    meta.ack,
    meta.ackBits,
    MessagePayload.HelloPayload,
    payload,
  );
  Envelope.finishEnvelopeBuffer(builder, envelope);
  return builder.asUint8Array();
}

function buildInputFrame(
  meta: { seq: number; ack: number; ackBits: number },
  inputSeq: number,
): Uint8Array {
  const builder = new flatbuffers.Builder(96);
  const payload = ActionCommandPayload.createActionCommandPayload(
    builder,
    inputSeq,
    1,
    0,
    false,
    0,
    false,
    false,
    false,
  );
  const envelope = Envelope.createEnvelope(
    builder,
    meta.seq,
    meta.ack,
    meta.ackBits,
    MessagePayload.ActionCommandPayload,
    payload,
  );
  Envelope.finishEnvelopeBuffer(builder, envelope);
  return builder.asUint8Array();
}

async function run(): Promise<void> {
  const config = parseArgs();

  let opened = 0;
  let closed = 0;
  let errors = 0;
  let recvTotal = 0;
  let recvSnapshot = 0;

  const sockets: WebSocket[] = [];
  const timers: NodeJS.Timeout[] = [];

  for (let i = 0; i < config.clients; i += 1) {
    const ws = new WebSocket(config.url);
    ws.binaryType = "arraybuffer";
    sockets.push(ws);

    const sequenceTracker = new SequenceTracker();
    let inputSeq = 1;

    ws.onopen = () => {
      opened += 1;
      ws.send(buildHelloFrame(sequenceTracker.nextOutgoingMeta()));

      const timer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(buildInputFrame(sequenceTracker.nextOutgoingMeta(), inputSeq++));
        }
      }, config.inputIntervalMs);
      timers.push(timer);
    };

    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        return;
      }

      const bb = new flatbuffers.ByteBuffer(new Uint8Array(event.data));
      if (!Envelope.bufferHasIdentifier(bb)) {
        return;
      }

      const envelope = Envelope.getRootAsEnvelope(bb);
      sequenceTracker.noteRemote(envelope.seq());

      recvTotal += 1;
      if (envelope.payloadType() === MessagePayload.SnapshotPayload) {
        const snapshot = envelope.payload(new SnapshotPayload());
        if (snapshot != null) {
          recvSnapshot += 1;
        }
      }
    };

    ws.onerror = () => {
      errors += 1;
    };

    ws.onclose = () => {
      closed += 1;
    };
  }

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }

      setTimeout(() => resolve(), 700);
    }, config.durationMs);
  });

  const seconds = config.durationMs / 1000;

  const summary = {
    ...config,
    opened,
    closed,
    errors,
    recvTotal,
    recvSnapshot,
    recvPerSec: Math.round(recvTotal / seconds),
    snapshotPerSec: Math.round(recvSnapshot / seconds),
  };

  console.log(JSON.stringify(summary, null, 2));
}

void run();
