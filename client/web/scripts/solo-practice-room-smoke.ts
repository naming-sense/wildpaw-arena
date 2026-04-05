import { RealtimeClient, type PlayerSnapshot } from "../src/netcode";

import { resolveRoomToken } from "./lib/devRoomToken";

const roomUrl = process.argv[2] ?? "ws://127.0.0.1:7001";
const roomToken = resolveRoomToken(process.argv[3] ?? "dev-room");
const durationMs = Number(process.argv[4] ?? 3200);

let inputSeq = 1;
let localPlayerId: number | null = null;
let local: PlayerSnapshot | null = null;
let dummy: PlayerSnapshot | null = null;
let dummyPlayerId: number | null = null;
let dummyHp: number | null = null;
let dummyHpMin: number | null = null;

let damageAppliedEvents = 0;
let combatEvents = 0;

const client = new RealtimeClient({
  url: roomUrl,
  onEvent: (event, payload) => {
    if (event === "S2C_WELCOME") {
      const body = payload as { playerId?: unknown };
      if (typeof body.playerId === "number") {
        localPlayerId = body.playerId;
      }
    }
  },
  onSnapshot: (snapshot) => {
    if (localPlayerId == null) {
      return;
    }

    const nextLocal = snapshot.players.find((p) => p.playerId === localPlayerId) ?? null;
    if (nextLocal) {
      local = nextLocal;
    }

    const nextDummy = snapshot.players.find((p) => p.playerId !== localPlayerId) ?? null;
    if (nextDummy) {
      dummy = nextDummy;
      dummyPlayerId = nextDummy.playerId;
      dummyHp = nextDummy.hp;
      dummyHpMin = dummyHpMin == null ? nextDummy.hp : Math.min(dummyHpMin, nextDummy.hp);
    }
  },
  onCombatEvent: (event) => {
    combatEvents += 1;
    if (event.eventType === 2 && localPlayerId != null && event.sourcePlayerId === localPlayerId) {
      damageAppliedEvents += 1;
    }
  },
});

client.connect(roomToken);

const fireTimer = setInterval(() => {
  if (!local || !dummy) {
    return;
  }

  const dx = dummy.position.x - local.position.x;
  const dy = dummy.position.y - local.position.y;
  const aimRadian = Math.atan2(dx, dy);

  client.sendInput({
    inputSeq: inputSeq++,
    localTick: inputSeq,
    moveX: 0,
    moveY: 0,
    fire: true,
    aimRadian,
    skillQ: false,
    skillE: false,
    skillR: false,
  });
}, 33);

setTimeout(() => {
  clearInterval(fireTimer);
  client.disconnect();

  console.log(
    JSON.stringify(
      {
        roomUrl,
        roomToken,
        durationMs,
        localPlayerId,
        localHp: local?.hp ?? null,
        dummyPlayerId,
        dummyHp,
        dummyHpMin,
        combatEvents,
        damageAppliedEvents,
      },
      null,
      2,
    ),
  );
}, durationMs);
