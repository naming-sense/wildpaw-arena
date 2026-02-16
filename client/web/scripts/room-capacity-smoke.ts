import * as flatbuffers from "flatbuffers";

import { Envelope } from "../src/netcode/gen/wildpaw/protocol/envelope";
import { EventPayload } from "../src/netcode/gen/wildpaw/protocol/event-payload";
import { HelloPayload } from "../src/netcode/gen/wildpaw/protocol/hello-payload";
import { MessagePayload } from "../src/netcode/gen/wildpaw/protocol/message-payload";
import { WelcomePayload } from "../src/netcode/gen/wildpaw/protocol/welcome-payload";

const url = process.argv[2] ?? "ws://127.0.0.1:7001";
const clients = Number(process.argv[3] ?? 7);
const holdMs = Number(process.argv[4] ?? 4000);

type EventRecord = {
  name: string;
  message: string;
};

type ClientRecord = {
  index: number;
  welcomePlayerId: number | null;
  events: EventRecord[];
  closeCode: number | null;
  closeReason: string | null;
};

function encodeHello(roomToken: string): Uint8Array {
  const builder = new flatbuffers.Builder(128);

  const roomTokenOffset = builder.createString(roomToken);
  const clientVersionOffset = builder.createString("room-capacity-smoke");
  const payloadOffset = HelloPayload.createHelloPayload(
    builder,
    roomTokenOffset,
    clientVersionOffset,
  );

  const envelopeOffset = Envelope.createEnvelope(
    builder,
    1,
    0,
    0,
    MessagePayload.HelloPayload,
    payloadOffset,
  );

  Envelope.finishEnvelopeBuffer(builder, envelopeOffset);
  return builder.asUint8Array();
}

const records: ClientRecord[] = [];
const sockets: WebSocket[] = [];

for (let index = 0; index < clients; index += 1) {
  const record: ClientRecord = {
    index,
    welcomePlayerId: null,
    events: [],
    closeCode: null,
    closeReason: null,
  };

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    ws.send(encodeHello(`room-capacity-${index}`));
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

    if (envelope.payloadType() === MessagePayload.WelcomePayload) {
      const welcome = envelope.payload(new WelcomePayload()) as WelcomePayload | null;
      record.welcomePlayerId = welcome?.playerId() ?? null;
      return;
    }

    if (envelope.payloadType() === MessagePayload.EventPayload) {
      const payload = envelope.payload(new EventPayload()) as EventPayload | null;
      record.events.push({
        name: payload?.name() ?? "",
        message: payload?.message() ?? "",
      });
    }
  };

  ws.onclose = (event) => {
    record.closeCode = event.code;
    record.closeReason = event.reason;
  };

  records.push(record);
  sockets.push(ws);
}

setTimeout(() => {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
}, holdMs);

setTimeout(() => {
  const roomFullCount = records.filter((record) =>
    record.events.some((ev) => ev.name === "room.full"),
  ).length;

  const teamAssignedCount = records.filter((record) =>
    record.events.some((ev) => ev.name === "team.assigned"),
  ).length;

  const welcomedCount = records.filter((record) => record.welcomePlayerId != null).length;

  console.log(
    JSON.stringify(
      {
        url,
        clients,
        welcomedCount,
        roomFullCount,
        teamAssignedCount,
        records,
      },
      null,
      2,
    ),
  );

  process.exit(0);
}, holdMs + 600);
