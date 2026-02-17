import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const TICK_HZ = Number(process.env.TICK_HZ ?? 30);
const TICK_MS = Math.max(1, Math.floor(1000 / Math.max(1, TICK_HZ)));
const MOVE_SPEED = Number(process.env.MOVE_SPEED ?? 5);
const STALE_CLIENT_TIMEOUT_MS = Number(process.env.STALE_CLIENT_TIMEOUT_MS ?? 4500);
const WORLD_MIN = -24;
const WORLD_MAX = 24;
const SPAWN_POINTS = [
  [-2.5, 0],
  [2.5, 0],
  [0, 2.5],
  [0, -2.5],
  [-3.5, -3.5],
  [3.5, 3.5],
  [-3.5, 3.5],
  [3.5, -3.5],
];

const OPCODES = {
  C2S_HELLO: "C2S_HELLO",
  C2S_INPUT: "C2S_INPUT",
  C2S_PING: "C2S_PING",
  S2C_WELCOME: "S2C_WELCOME",
  S2C_MATCH_START: "S2C_MATCH_START",
  S2C_SNAPSHOT_DELTA: "S2C_SNAPSHOT_DELTA",
  S2C_PONG: "S2C_PONG",
};

/** @type {Set<{ws: import('ws').WebSocket, player: any, clientId: string | null, lastSeenAt: number}>} */
const clients = new Set();
/** @type {Map<string, {ws: import('ws').WebSocket, player: any, clientId: string | null, lastSeenAt: number}>} */
const clientsById = new Map();
let nextPlayerId = 1;
let serverTick = 0;

const wss = new WebSocketServer({ host: "0.0.0.0", port: PORT });

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function createPlayerState(playerId) {
  const spawn = SPAWN_POINTS[(playerId - 1) % SPAWN_POINTS.length] ?? [0, 0];

  return {
    playerId,
    team: (playerId % 2) + 1,
    x: spawn[0],
    y: spawn[1],
    rot: 0,
    vx: 0,
    vy: 0,
    hp: 100,
    shield: 0,
    alive: true,
    lastProcessedInputSeq: 0,
  };
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function snapshotPlayers() {
  return [...clients].map((client) => ({ ...client.player }));
}

function removeClient(client, reason = "disconnect") {
  if (!clients.has(client)) return;

  clients.delete(client);

  if (client.clientId && clientsById.get(client.clientId) === client) {
    clientsById.delete(client.clientId);
  }

  if (clients.size === 0) {
    nextPlayerId = 1;
  }

  console.log(`[mock-room] ${reason} player=${client.player.playerId} total=${clients.size}`);
}

function attachClientIdentity(client, rawClientId) {
  const clientId =
    typeof rawClientId === "string" && rawClientId.trim().length > 0
      ? rawClientId.trim().slice(0, 128)
      : null;

  if (!clientId) return;

  const previous = clientsById.get(clientId);
  if (previous && previous !== client) {
    removeClient(previous, `replaced(${clientId})`);
    try {
      previous.ws.close(4001, "reconnected");
    } catch {
      // ignore close errors
    }
  }

  client.clientId = clientId;
  clientsById.set(clientId, client);
}

function applyInput(client, input) {
  const moveX = asNumber(input?.moveX, 0);
  const moveY = asNumber(input?.moveY, 0);

  client.player.vx = moveX * MOVE_SPEED;
  client.player.vy = moveY * MOVE_SPEED;

  const inputSeq = asNumber(input?.seq, client.player.lastProcessedInputSeq);
  if (inputSeq >= client.player.lastProcessedInputSeq) {
    client.player.lastProcessedInputSeq = inputSeq;
  }

  if (Math.abs(client.player.vx) > 1e-4 || Math.abs(client.player.vy) > 1e-4) {
    client.player.rot = Math.atan2(client.player.vx, client.player.vy);
  }
}

wss.on("connection", (ws) => {
  const playerId = nextPlayerId++;
  const client = {
    ws,
    player: createPlayerState(playerId),
    clientId: null,
    lastSeenAt: Date.now(),
  };

  clients.add(client);

  console.log(`[mock-room] connected player=${playerId} total=${clients.size}`);

  safeSend(ws, {
    t: OPCODES.S2C_WELCOME,
    d: { playerId, serverTimeMs: Date.now() },
  });

  safeSend(ws, {
    t: OPCODES.S2C_MATCH_START,
    d: { playerId, serverTick },
  });

  ws.on("message", (raw) => {
    let envelope;
    try {
      envelope = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!envelope || typeof envelope !== "object") return;

    client.lastSeenAt = Date.now();

    switch (envelope.t) {
      case OPCODES.C2S_HELLO:
        attachClientIdentity(client, envelope?.d?.clientId);
        safeSend(ws, {
          t: OPCODES.S2C_WELCOME,
          d: { playerId, serverTimeMs: Date.now() },
        });
        break;
      case OPCODES.C2S_INPUT:
        applyInput(client, envelope.d);
        break;
      case OPCODES.C2S_PING:
        safeSend(ws, {
          t: OPCODES.S2C_PONG,
          d: { serverTimeMs: Date.now() },
        });
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    removeClient(client, "disconnected");
  });

  ws.on("error", () => {
    removeClient(client, "error");
  });
});

setInterval(() => {
  const now = Date.now();

  for (const client of [...clients]) {
    if (now - client.lastSeenAt > STALE_CLIENT_TIMEOUT_MS) {
      try {
        client.ws.terminate();
      } catch {
        // ignore terminate errors
      }
      removeClient(client, "stale-timeout");
    }
  }

  serverTick += 1;
  const dt = TICK_MS / 1000;

  for (const client of clients) {
    const player = client.player;

    if (!player.alive) continue;

    player.x = clamp(player.x + player.vx * dt, WORLD_MIN, WORLD_MAX);
    player.y = clamp(player.y + player.vy * dt, WORLD_MIN, WORLD_MAX);
  }

  const players = snapshotPlayers();
  const serverTimeMs = Date.now();

  for (const client of clients) {
    safeSend(client.ws, {
      t: OPCODES.S2C_SNAPSHOT_DELTA,
      d: {
        serverTick,
        serverTimeMs,
        ackSeq: client.player.lastProcessedInputSeq,
        players,
      },
    });
  }
}, TICK_MS);

console.log(`[mock-room] listening on ws://0.0.0.0:${PORT} (${TICK_HZ}Hz)`);
