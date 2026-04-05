import * as flatbuffers from "flatbuffers";

import { Envelope } from "../src/netcode/gen/wildpaw/protocol/envelope";
import { HelloPayload } from "../src/netcode/gen/wildpaw/protocol/hello-payload";
import { MessagePayload } from "../src/netcode/gen/wildpaw/protocol/message-payload";
import { SnapshotPayload } from "../src/netcode/gen/wildpaw/protocol/snapshot-payload";
import { WelcomePayload } from "../src/netcode/gen/wildpaw/protocol/welcome-payload";

import { resolveRoomToken } from "./lib/devRoomToken";

const ROOM_TOKEN = resolveRoomToken(process.env.ROOM_TOKEN ?? "profile-smoke");

class SeqTracker {
  private nextSeq = 1;
  private highestRemoteSeq = 0;
  private readonly remoteWindow: number[] = [];

  nextMeta(): { seq: number; ack: number; ackBits: number } {
    return {
      seq: this.nextSeq++,
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

class ProbeClient {
  readonly ws: WebSocket;
  readonly tracker = new SeqTracker();

  playerId: number | null = null;
  ownMaxAmmo: number | null = null;

  constructor(
    readonly name: string,
    readonly url: string,
  ) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        return;
      }

      const bb = new flatbuffers.ByteBuffer(new Uint8Array(event.data));
      if (!Envelope.bufferHasIdentifier(bb)) {
        return;
      }

      const envelope = Envelope.getRootAsEnvelope(bb);
      this.tracker.noteRemote(envelope.seq());

      if (envelope.payloadType() === MessagePayload.WelcomePayload) {
        const welcome = envelope.payload(new WelcomePayload()) as WelcomePayload | null;
        if (welcome) {
          this.playerId = welcome.playerId();
        }
      }

      if (envelope.payloadType() === MessagePayload.SnapshotPayload) {
        const snapshot = envelope.payload(new SnapshotPayload()) as SnapshotPayload | null;
        if (!snapshot || this.playerId == null) {
          return;
        }

        for (let i = 0; i < snapshot.playersLength(); i += 1) {
          const p = snapshot.players(i);
          if (!p) {
            continue;
          }
          if (p.playerId() === this.playerId) {
            this.ownMaxAmmo = p.maxAmmo();
            return;
          }
        }
      }
    };
  }

  sendHello(): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      return;
    }

    const builder = new flatbuffers.Builder(256);
    const meta = this.tracker.nextMeta();
    const roomToken = builder.createString(ROOM_TOKEN);
    const version = builder.createString(`profile-${this.name}`);
    const hello = HelloPayload.createHelloPayload(builder, roomToken, version);

    const env = Envelope.createEnvelope(
      builder,
      meta.seq,
      meta.ack,
      meta.ackBits,
      MessagePayload.HelloPayload,
      hello,
    );

    Envelope.finishEnvelopeBuffer(builder, env);
    this.ws.send(builder.asUint8Array());
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const url = process.argv[2] ?? "ws://127.0.0.1:7001";

  const clients = [
    new ProbeClient("A", url),
    new ProbeClient("B", url),
    new ProbeClient("C", url),
  ];

  await wait(300);
  for (const client of clients) {
    client.sendHello();
  }

  await wait(2200);

  const maxAmmoByClient = clients.map((client) => ({
    name: client.name,
    playerId: client.playerId,
    ownMaxAmmo: client.ownMaxAmmo,
  }));

  const uniqueMaxAmmo = [
    ...new Set(maxAmmoByClient.map((it) => it.ownMaxAmmo).filter((v) => v != null)),
  ];

  for (const client of clients) {
    client.close();
  }

  console.log(
    JSON.stringify(
      {
        url,
        maxAmmoByClient,
        uniqueMaxAmmo,
      },
      null,
      2,
    ),
  );
}

void run();
