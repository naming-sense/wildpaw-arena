import * as flatbuffers from "flatbuffers";

import { ActionCommandPayload } from "../src/netcode/gen/wildpaw/protocol/action-command-payload";
import { Envelope } from "../src/netcode/gen/wildpaw/protocol/envelope";
import { HelloPayload } from "../src/netcode/gen/wildpaw/protocol/hello-payload";
import { MessagePayload } from "../src/netcode/gen/wildpaw/protocol/message-payload";

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

class BotClient {
  readonly ws: WebSocket;
  readonly tracker = new SeqTracker();
  inputSeq = 1;

  combatEvents = 0;
  projectileEvents = 0;

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

      if (envelope.payloadType() === MessagePayload.CombatEventPayload) {
        this.combatEvents += 1;
      }
      if (envelope.payloadType() === MessagePayload.ProjectileEventPayload) {
        this.projectileEvents += 1;
      }
    };
  }

  sendHello(): void {
    this.send(MessagePayload.HelloPayload, (builder) => {
      const roomToken = builder.createString("interest-smoke");
      const clientVersion = builder.createString(`interest-${this.name}`);
      return HelloPayload.createHelloPayload(builder, roomToken, clientVersion);
    });
  }

  sendAction(moveX: number, fire = false): void {
    this.send(MessagePayload.ActionCommandPayload, (builder) =>
      ActionCommandPayload.createActionCommandPayload(
        builder,
        this.inputSeq++,
        moveX,
        0,
        fire,
        0,
        false,
        false,
        false,
      ),
    );
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  private send(
    payloadType: MessagePayload,
    payloadBuilder: (builder: flatbuffers.Builder) => flatbuffers.Offset,
  ): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      return;
    }

    const builder = new flatbuffers.Builder(256);
    const meta = this.tracker.nextMeta();
    const payloadOffset = payloadBuilder(builder);

    const envelope = Envelope.createEnvelope(
      builder,
      meta.seq,
      meta.ack,
      meta.ackBits,
      payloadType,
      payloadOffset,
    );

    Envelope.finishEnvelopeBuffer(builder, envelope);
    this.ws.send(builder.asUint8Array());
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const url = process.argv[2] ?? "ws://127.0.0.1:7001";

  const a = new BotClient("A", url);
  const b = new BotClient("B", url);

  await wait(300);
  a.sendHello();
  b.sendHello();

  const started = Date.now();

  const timer = setInterval(() => {
    const elapsed = Date.now() - started;

    if (elapsed < 5500) {
      a.sendAction(1, false);
      b.sendAction(-1, false);
      return;
    }

    if (elapsed < 6100) {
      a.sendAction(0, false);
      b.sendAction(0, false);
      return;
    }

    if (elapsed < 6200) {
      a.sendAction(0, true);
      b.sendAction(0, false);
      return;
    }

    a.sendAction(0, false);
    b.sendAction(0, false);
  }, 50);

  await wait(7800);
  clearInterval(timer);

  a.close();
  b.close();

  console.log(
    JSON.stringify(
      {
        url,
        aCombatEvents: a.combatEvents,
        aProjectileEvents: a.projectileEvents,
        bCombatEvents: b.combatEvents,
        bProjectileEvents: b.projectileEvents,
      },
      null,
      2,
    ),
  );
}

void run();
