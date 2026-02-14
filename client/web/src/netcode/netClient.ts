import * as flatbuffers from "flatbuffers";

import type { InputFrame, PlayerSnapshot, WorldSnapshot } from "./types";
import { Envelope } from "./gen/wildpaw/protocol/envelope";
import { EventPayload } from "./gen/wildpaw/protocol/event-payload";
import { HelloPayload } from "./gen/wildpaw/protocol/hello-payload";
import { InputPayload } from "./gen/wildpaw/protocol/input-payload";
import { MessagePayload } from "./gen/wildpaw/protocol/message-payload";
import { PingPayload } from "./gen/wildpaw/protocol/ping-payload";
import { SnapshotKind } from "./gen/wildpaw/protocol/snapshot-kind";
import { SnapshotPayload } from "./gen/wildpaw/protocol/snapshot-payload";
import { WelcomePayload } from "./gen/wildpaw/protocol/welcome-payload";

export interface RealtimeClientOptions {
  url: string;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onEvent?: (eventName: string, payload: unknown) => void;
}

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

function toNumber(value: bigint): number {
  return Number(value);
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private readonly sequenceTracker = new SequenceTracker();

  constructor(private readonly options: RealtimeClientOptions) {}

  connect(roomToken: string): void {
    this.ws = new WebSocket(this.options.url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.sendHello(roomToken);
    };

    this.ws.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
      void this.handleIncoming(event.data);
    };
  }

  sendInput(input: InputFrame): void {
    this.sendEnvelope("C2S_INPUT", input);
  }

  sendPing(): void {
    this.sendEnvelope("C2S_PING", {});
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  private sendHello(roomToken: string): void {
    this.sendEnvelope("C2S_HELLO", {
      roomToken,
      clientVersion: "0.4.0",
    });
  }

  private sendEnvelope(
    type: "C2S_HELLO" | "C2S_INPUT" | "C2S_PING",
    payload: unknown,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const meta = this.sequenceTracker.nextOutgoingMeta();
    const builder = new flatbuffers.Builder(256);

    let payloadType = MessagePayload.NONE;
    let payloadOffset: flatbuffers.Offset = 0;

    if (type === "C2S_HELLO") {
      const hello = payload as { roomToken: string; clientVersion: string };
      const roomTokenOffset = builder.createString(hello.roomToken);
      const clientVersionOffset = builder.createString(hello.clientVersion);
      payloadOffset = HelloPayload.createHelloPayload(
        builder,
        roomTokenOffset,
        clientVersionOffset,
      );
      payloadType = MessagePayload.HelloPayload;
    } else if (type === "C2S_INPUT") {
      const input = payload as InputFrame;
      payloadOffset = InputPayload.createInputPayload(
        builder,
        input.inputSeq,
        input.moveX,
        input.moveY,
        input.fire,
        input.aimRadian,
      );
      payloadType = MessagePayload.InputPayload;
    } else if (type === "C2S_PING") {
      payloadOffset = PingPayload.createPingPayload(builder);
      payloadType = MessagePayload.PingPayload;
    }

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

  private async handleIncoming(data: string | ArrayBuffer | Blob): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.handleBinaryEnvelope(data);
      return;
    }

    if (data instanceof Blob) {
      const arrayBuffer = await data.arrayBuffer();
      this.handleBinaryEnvelope(arrayBuffer);
      return;
    }

    // 서버는 이제 binary 전용이지만, 예외적으로 text가 오면 이벤트로 전달.
    this.options.onEvent?.("text.unexpected", data);
  }

  private handleBinaryEnvelope(buffer: ArrayBuffer): void {
    const byteBuffer = new flatbuffers.ByteBuffer(new Uint8Array(buffer));
    if (!Envelope.bufferHasIdentifier(byteBuffer)) {
      this.options.onEvent?.("binary.invalid_identifier", {
        byteLength: buffer.byteLength,
      });
      return;
    }

    const envelope = Envelope.getRootAsEnvelope(byteBuffer);
    this.sequenceTracker.noteRemote(envelope.seq());

    switch (envelope.payloadType()) {
      case MessagePayload.WelcomePayload: {
        const welcome = envelope.payload(new WelcomePayload()) as WelcomePayload | null;
        if (!welcome) {
          return;
        }

        this.options.onEvent?.("S2C_WELCOME", {
          playerId: welcome.playerId(),
          serverTickRate: welcome.serverTickRate(),
          serverTick: welcome.serverTick(),
        });
        return;
      }

      case MessagePayload.SnapshotPayload: {
        const snapshotPayload = envelope.payload(new SnapshotPayload()) as
          | SnapshotPayload
          | null;
        if (!snapshotPayload) {
          return;
        }

        const players: PlayerSnapshot[] = [];
        for (let i = 0; i < snapshotPayload.playersLength(); i += 1) {
          const player = snapshotPayload.players(i);
          if (!player) {
            continue;
          }

          const position = player.position();
          const velocity = player.velocity();

          players.push({
            playerId: player.playerId(),
            position: {
              x: position?.x() ?? 0,
              y: position?.y() ?? 0,
            },
            velocity: {
              x: velocity?.x() ?? 0,
              y: velocity?.y() ?? 0,
            },
            hp: player.hp(),
            alive: player.alive(),
            lastProcessedInputSeq: player.lastProcessedInputSeq(),
          });
        }

        const snapshot: WorldSnapshot = {
          serverTick: snapshotPayload.serverTick(),
          serverTimeMs: toNumber(snapshotPayload.serverTimeMs()),
          players,
        };

        this.options.onSnapshot?.(snapshot);
        this.options.onEvent?.(
          snapshotPayload.kind() === SnapshotKind.Delta
            ? "S2C_SNAPSHOT_DELTA"
            : "S2C_SNAPSHOT_BASE",
          { players: players.length },
        );
        return;
      }

      case MessagePayload.EventPayload: {
        const eventPayload = envelope.payload(new EventPayload()) as EventPayload | null;
        if (!eventPayload) {
          return;
        }

        this.options.onEvent?.(eventPayload.name() ?? "S2C_EVENT", {
          message: eventPayload.message() ?? "",
        });
        return;
      }

      default:
        this.options.onEvent?.("binary.unknown_payload", {
          payloadType: envelope.payloadType(),
        });
        return;
    }
  }
}
