import { RealtimeClient, type PlayerSnapshot } from "../src/netcode";

import { resolveRoomToken } from "./lib/devRoomToken";

const roomUrl = process.argv[2] ?? "ws://127.0.0.1:7001";
const roomToken = resolveRoomToken(process.argv[3] ?? "dev-room");
const durationMs = Number(process.argv[4] ?? 2600);

let aSeq = 1;
let bSeq = 1;

let aPlayerId: number | null = null;
let bPlayerId: number | null = null;
let aLocal: PlayerSnapshot | null = null;
let bLocal: PlayerSnapshot | null = null;
let aEnemy: PlayerSnapshot | null = null;
let bEnemy: PlayerSnapshot | null = null;
let bHpMin: number | null = null;

const stats = {
  aCombatEvents: 0,
  bCombatEvents: 0,
  aDamageAppliedEvents: 0,
  bDamageAppliedEvents: 0,
};

const clientA = new RealtimeClient({
  url: roomUrl,
  onSnapshot: (snapshot) => {
    if (aPlayerId == null) return;
    aLocal = snapshot.players.find((p) => p.playerId === aPlayerId) ?? null;
    aEnemy = snapshot.players.find((p) => p.playerId !== aPlayerId) ?? null;
  },
  onEvent: (name, payload) => {
    if (name === "S2C_WELCOME") {
      const body = payload as { playerId?: number };
      if (typeof body.playerId === "number") {
        aPlayerId = body.playerId;
      }
    }
  },
  onCombatEvent: (event) => {
    stats.aCombatEvents += 1;
    if (event.eventType === 2) {
      stats.aDamageAppliedEvents += 1;
    }
  },
});

const clientB = new RealtimeClient({
  url: roomUrl,
  onSnapshot: (snapshot) => {
    if (bPlayerId == null) return;
    bLocal = snapshot.players.find((p) => p.playerId === bPlayerId) ?? null;
    bEnemy = snapshot.players.find((p) => p.playerId !== bPlayerId) ?? null;

    if (bLocal) {
      bHpMin = bHpMin == null ? bLocal.hp : Math.min(bHpMin, bLocal.hp);
    }
  },
  onEvent: (name, payload) => {
    if (name === "S2C_WELCOME") {
      const body = payload as { playerId?: number };
      if (typeof body.playerId === "number") {
        bPlayerId = body.playerId;
      }
    }
  },
  onCombatEvent: (event) => {
    stats.bCombatEvents += 1;
    if (event.eventType === 2) {
      stats.bDamageAppliedEvents += 1;
    }
  },
});

clientA.connect(roomToken);
clientB.connect(roomToken);

const tickHandle = setInterval(() => {
  if (!aLocal || !aEnemy) {
    return;
  }

  const dx = aEnemy.position.x - aLocal.position.x;
  const dy = aEnemy.position.y - aLocal.position.y;
  const aimRadian = Math.atan2(dx, dy);

  clientA.sendInput({
    inputSeq: aSeq++,
    localTick: aSeq,
    moveX: 0,
    moveY: 0,
    fire: true,
    aimRadian,
    skillQ: false,
    skillE: false,
    skillR: false,
  });

  clientB.sendInput({
    inputSeq: bSeq++,
    localTick: bSeq,
    moveX: 0,
    moveY: 0,
    fire: false,
    aimRadian: 0,
    skillQ: false,
    skillE: false,
    skillR: false,
  });
}, 33);

setTimeout(() => {
  clearInterval(tickHandle);
  clientA.disconnect();
  clientB.disconnect();

  console.log(
    JSON.stringify(
      {
        roomUrl,
        roomToken,
        durationMs,
        aPlayerId,
        bPlayerId,
        aLocalHp: aLocal?.hp ?? null,
        bLocalHp: bLocal?.hp ?? null,
        bHpMin,
        stats,
      },
      null,
      2,
    ),
  );
}, durationMs);
