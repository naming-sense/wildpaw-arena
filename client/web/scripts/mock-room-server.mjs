import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 9100);
const ADMIN_TOKEN = String(process.env.WILDPAW_ADMIN_TOKEN ?? "").trim();
const MAX_ADMIN_VIOLATIONS = Number(process.env.ADMIN_MAX_VIOLATIONS ?? 200);
const TICK_HZ = Number(process.env.TICK_HZ ?? 30);
const TICK_MS = Math.max(1, Math.floor(1000 / Math.max(1, TICK_HZ)));
const STALE_CLIENT_TIMEOUT_MS = Number(process.env.STALE_CLIENT_TIMEOUT_MS ?? 120000);
const RESPAWN_MS = Number(process.env.RESPAWN_MS ?? 3000);
const WORLD_MIN = -24;
const WORLD_MAX = 24;
const DEFAULT_HERO_ID = process.env.DEFAULT_HERO_ID ?? "coral_cat";

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
  S2C_EVENT: "S2C_EVENT",
  S2C_PONG: "S2C_PONG",
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const HERO_BALANCE_PATH = resolve(__dirname, "../../../shared/data/hero_balance_mvp_v0.2.json");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function asNumber(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function normalizeHeroId(rawHeroId) {
  if (typeof rawHeroId !== "string") return "";
  const heroId = rawHeroId.trim().toLowerCase();
  if (heroId === "whitecat_commando") {
    return "coral_cat";
  }
  return heroId;
}

function loadHeroBalanceData() {
  try {
    const raw = readFileSync(HERO_BALANCE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.heroes) || parsed.heroes.length === 0) {
      throw new Error("heroes table is empty");
    }
    return parsed.heroes;
  } catch (error) {
    console.warn("[mock-room] failed to load hero balance json:", error);
    return [
      {
        id: "coral_cat",
        nameKr: "코랄 캣",
        role: "Skirmisher",
        stats: { hp: 2450, moveSpeedMps: 5.9, hitboxRadiusM: 0.46 },
        weapon: {
          class: "DMR",
          rangeM: 16,
          falloffStartM: 13,
          falloffEndM: 22,
          damagePerShot: 178,
          shotsPerSec: 3.1,
          critMultiplier: 1.45,
          ammo: 12,
          reloadSec: 1.75,
        },
        passive: {
          firstShotBonus: 0.3,
          outOfCombatRequiredMs: 1200,
        },
      },
    ];
  }
}

function buildHeroProfileMap(heroRows) {
  const map = new Map();

  for (const hero of heroRows) {
    const weapon = hero?.weapon ?? {};
    const shotsPerSecMin = asNumber(weapon.shotsPerSecMin, NaN);
    const shotsPerSecMax = asNumber(weapon.shotsPerSecMax, NaN);
    const explicitShotsPerSec = asNumber(weapon.shotsPerSec, NaN);

    const shotsPerSec = Number.isFinite(explicitShotsPerSec)
      ? explicitShotsPerSec
      : Number.isFinite(shotsPerSecMin) && Number.isFinite(shotsPerSecMax)
        ? (shotsPerSecMin + shotsPerSecMax) * 0.5
        : asNumber(weapon.damagePerSec, 0) > 0
          ? 12
          : 6;

    const damagePerShot = Number.isFinite(asNumber(weapon.damagePerShot, NaN))
      ? asNumber(weapon.damagePerShot, 80)
      : Number.isFinite(asNumber(weapon.pelletCount, NaN)) && Number.isFinite(asNumber(weapon.pelletDamage, NaN))
        ? asNumber(weapon.pelletCount, 1) * asNumber(weapon.pelletDamage, 1)
        : asNumber(weapon.damagePerSec, 0) > 0
          ? asNumber(weapon.damagePerSec, 0) / Math.max(1, shotsPerSec)
          : asNumber(weapon.bodyDps, asNumber(weapon.bodyDpsAvg, 0)) > 0
            ? asNumber(weapon.bodyDps, asNumber(weapon.bodyDpsAvg, 0)) / Math.max(1, shotsPerSec)
            : 80;

    const rangeM = asNumber(weapon.rangeM, 10);

    const profile = {
      heroId: normalizeHeroId(hero?.id ?? "") || "coral_cat",
      nameKr: typeof hero?.nameKr === "string" ? hero.nameKr : String(hero?.id ?? "unknown"),
      role: typeof hero?.role === "string" ? hero.role : "Striker",
      maxHp: asNumber(hero?.stats?.hp, 2500),
      moveSpeed: asNumber(hero?.stats?.moveSpeedMps, 5),
      hitboxRadius: asNumber(hero?.stats?.hitboxRadiusM, 0.5),
      weapon: {
        className: typeof weapon?.class === "string" ? weapon.class : "Rifle",
        rangeM,
        falloffStartM: asNumber(weapon.falloffStartM, rangeM * 0.7),
        falloffEndM: asNumber(weapon.falloffEndM, rangeM * 1.15),
        damagePerShot,
        shotsPerSec: Math.max(1, shotsPerSec),
        shotsPerSecMin: Number.isFinite(shotsPerSecMin) ? Math.max(1, shotsPerSecMin) : null,
        shotsPerSecMax: Number.isFinite(shotsPerSecMax) ? Math.max(1, shotsPerSecMax) : null,
        spinUpMs: asNumber(weapon.spinUpMs, 1400),
        critMultiplier: asNumber(weapon.critMultiplier, 1.25),
        ammo: Math.max(1, Math.round(asNumber(weapon.ammo, 12))),
        reloadMs: Math.max(200, Math.round(asNumber(weapon.reloadSec, 1.7) * 1000)),
      },
      passive: hero?.passive ?? {},
    };

    map.set(profile.heroId, profile);
  }

  return map;
}

const HERO_PROFILES = buildHeroProfileMap(loadHeroBalanceData());

function getHeroProfile(rawHeroId) {
  const heroId = normalizeHeroId(rawHeroId);
  return (
    HERO_PROFILES.get(heroId) ??
    HERO_PROFILES.get(DEFAULT_HERO_ID) ??
    HERO_PROFILES.get("coral_cat") ??
    [...HERO_PROFILES.values()][0]
  );
}

function computeHitWidthByClass(className) {
  const lowered = String(className).toLowerCase();
  if (lowered.includes("shotgun")) return 1.3;
  if (lowered.includes("dmr")) return 0.45;
  if (lowered.includes("beam")) return 0.8;
  if (lowered.includes("launcher")) return 1.1;
  return 0.65;
}

function computeDamageFalloff(distance, start, end) {
  if (distance <= start) return 1;
  if (distance >= end) return 0.6;
  const t = clamp((distance - start) / Math.max(0.001, end - start), 0, 1);
  return lerp(1, 0.6, t);
}

/** @type {Set<{ws: import('ws').WebSocket, player: any, profile: any, clientId: string | null, lastSeenAt: number}>} */
const clients = new Set();
/** @type {Map<string, {ws: import('ws').WebSocket, player: any, profile: any, clientId: string | null, lastSeenAt: number}>} */
const clientsById = new Map();
let nextPlayerId = 1;
let serverTick = 0;

const startedAtMs = Date.now();
let totalConnected = 0;
let totalDisconnected = 0;
let totalStaleTimeouts = 0;
let totalParseErrors = 0;
let totalUnsupportedMessages = 0;
let totalPingReceived = 0;
let totalSnapshotsSent = 0;
/** @type {Array<{atMs:number, remote:string, type:string, detail:string}>} */
const violations = [];

const wss = new WebSocketServer({ host: "0.0.0.0", port: PORT });

function createPlayerState(playerId, profile) {
  const spawn = SPAWN_POINTS[(playerId - 1) % SPAWN_POINTS.length] ?? [0, 0];

  return {
    playerId,
    team: (playerId % 2) + 1,
    heroId: profile.heroId,
    heroName: profile.nameKr,

    x: spawn[0],
    y: spawn[1],
    rot: 0,
    vx: 0,
    vy: 0,

    hp: profile.maxHp,
    maxHp: profile.maxHp,
    shield: 0,
    alive: true,
    respawnAtMs: 0,

    lastProcessedInputSeq: 0,

    aimX: spawn[0],
    aimY: spawn[1] + 1,
    fireHeld: false,
    nextFireAtMs: 0,
    lastShotAtMs: Number.NEGATIVE_INFINITY,
    sustainedFireStartMs: 0,

    ammo: profile.weapon.ammo,
    maxAmmo: profile.weapon.ammo,
    reloading: false,
    reloadingUntilMs: 0,

    spawnX: spawn[0],
    spawnY: spawn[1],
  };
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function snapshotPlayers() {
  return [...clients].map((client) => ({
    playerId: client.player.playerId,
    team: client.player.team,
    x: client.player.x,
    y: client.player.y,
    rot: client.player.rot,
    vx: client.player.vx,
    vy: client.player.vy,
    hp: client.player.hp,
    maxHp: client.player.maxHp,
    shield: client.player.shield,
    alive: client.player.alive,
    lastProcessedInputSeq: client.player.lastProcessedInputSeq,
    heroId: client.player.heroId,
    heroName: client.player.heroName,
    ammo: client.player.ammo,
    maxAmmo: client.player.maxAmmo,
    reloading: client.player.reloading,
  }));
}

function recordViolation(remote, type, detail) {
  violations.push({
    atMs: Date.now(),
    remote: typeof remote === "string" && remote.length > 0 ? remote : "unknown",
    type,
    detail,
  });

  while (violations.length > MAX_ADMIN_VIOLATIONS) {
    violations.shift();
  }
}

function getSocketStats(client) {
  const socket = client?.ws?._socket;
  if (!socket) {
    return { bytesIn: 0, bytesOut: 0 };
  }

  return {
    bytesIn: Number(socket.bytesRead ?? 0),
    bytesOut: Number(socket.bytesWritten ?? 0),
  };
}

function getTeamOccupancy() {
  let team1 = 0;
  let team2 = 0;

  for (const client of clients) {
    if (client.player.team === 2) {
      team2 += 1;
    } else {
      team1 += 1;
    }
  }

  return { team1, team2 };
}

function renderAdminStatus() {
  const teamOccupancy = getTeamOccupancy();

  return {
    nowMs: Date.now(),
    startedAtMs,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
    rooms: 1,
    teamSize: 1,
    maxPlayersPerRoom: 2,
    teamOccupancy,
    wsPort: PORT,
    tickRate: TICK_HZ,
    currentTick: serverTick,
    defaultProfile: DEFAULT_HERO_ID,
    metrics: {
      activeSessions: clients.size,
      connectedTotal: totalConnected,
      disconnectedTotal: totalDisconnected,
      staleTimeoutTotal: totalStaleTimeouts,
      parseErrorTotal: totalParseErrors,
      unsupportedMessageTotal: totalUnsupportedMessages,
      pingReceivedTotal: totalPingReceived,
      snapshotSentTotal: totalSnapshotsSent,
    },
  };
}

function renderAdminSessions() {
  const nowMs = Date.now();
  const list = [...clients].sort((a, b) => a.player.playerId - b.player.playerId);
  const slotByTeam = new Map();

  const sessions = list.map((client) => {
    const teamId = client.player.team === 2 ? 2 : 1;
    const nextSlot = (slotByTeam.get(teamId) ?? 0) + 1;
    slotByTeam.set(teamId, nextSlot);

    const network = getSocketStats(client);

    return {
      playerId: client.player.playerId,
      teamId,
      teamSlot: nextSlot,
      heroId: client.player.heroId,
      heroName: client.player.heroName,
      remote: client.remoteEndpoint,
      connectedAtMs: client.connectedAtMs,
      lastSeenAtMs: client.lastSeenAt,
      bytesIn: network.bytesIn,
      bytesOut: network.bytesOut,
      invalidEnvelopeTotal: client.parseErrorTotal,
      unsupportedMessageTotal: client.unsupportedMessageTotal,
      invalidProfileSelectTotal: 0,
      alive: client.player.alive,
      hp: client.player.hp,
      maxHp: client.player.maxHp,
      pingMs: null,
    };
  });

  return {
    nowMs,
    sessions,
  };
}

function renderAdminViolations() {
  return {
    nowMs: Date.now(),
    violations,
  };
}

function renderPrometheusMetrics() {
  const teamOccupancy = getTeamOccupancy();

  return [
    "# HELP wildpaw_mock_room_active_sessions Active sessions in mock room",
    "# TYPE wildpaw_mock_room_active_sessions gauge",
    `wildpaw_mock_room_active_sessions ${clients.size}`,
    "# HELP wildpaw_mock_room_connected_total Total connected sessions",
    "# TYPE wildpaw_mock_room_connected_total counter",
    `wildpaw_mock_room_connected_total ${totalConnected}`,
    "# HELP wildpaw_mock_room_disconnected_total Total disconnected sessions",
    "# TYPE wildpaw_mock_room_disconnected_total counter",
    `wildpaw_mock_room_disconnected_total ${totalDisconnected}`,
    "# HELP wildpaw_mock_room_stale_timeout_total Stale timeout disconnects",
    "# TYPE wildpaw_mock_room_stale_timeout_total counter",
    `wildpaw_mock_room_stale_timeout_total ${totalStaleTimeouts}`,
    "# HELP wildpaw_mock_room_parse_error_total Invalid JSON envelopes",
    "# TYPE wildpaw_mock_room_parse_error_total counter",
    `wildpaw_mock_room_parse_error_total ${totalParseErrors}`,
    "# HELP wildpaw_mock_room_unsupported_message_total Unsupported message envelopes",
    "# TYPE wildpaw_mock_room_unsupported_message_total counter",
    `wildpaw_mock_room_unsupported_message_total ${totalUnsupportedMessages}`,
    "# HELP wildpaw_mock_room_snapshot_sent_total Snapshot messages sent",
    "# TYPE wildpaw_mock_room_snapshot_sent_total counter",
    `wildpaw_mock_room_snapshot_sent_total ${totalSnapshotsSent}`,
    "# HELP wildpaw_mock_room_team_occupancy Team occupancy",
    "# TYPE wildpaw_mock_room_team_occupancy gauge",
    `wildpaw_mock_room_team_occupancy{team=\"1\"} ${teamOccupancy.team1}`,
    `wildpaw_mock_room_team_occupancy{team=\"2\"} ${teamOccupancy.team2}`,
    "",
  ].join("\n");
}

function isAdminAuthorized(req, url) {
  if (!ADMIN_TOKEN) return true;

  const headerToken = req.headers["x-admin-token"];
  if (typeof headerToken === "string" && headerToken === ADMIN_TOKEN) {
    return true;
  }

  const queryToken = url.searchParams.get("token");
  return queryToken === ADMIN_TOKEN;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function writeText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

const ADMIN_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wildpaw Mock Room Admin</title>
  <style>
    body { font-family: ui-sans-serif, system-ui; margin: 16px; background:#0b1020; color:#d7def7; }
    h1,h2 { margin: 8px 0; }
    .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:10px; }
    .card { background:#151b33; border:1px solid #243057; border-radius:10px; padding:12px; }
    input,button { background:#1a2448; color:#d7def7; border:1px solid #2a3b74; border-radius:8px; padding:6px 10px; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #243057; padding:6px; font-size:13px; text-align:left; }
    pre { white-space:pre-wrap; background:#0f1530; border:1px solid #243057; border-radius:8px; padding:8px; }
  </style>
</head>
<body>
  <h1>Wildpaw Mock Room Admin</h1>
  <div class="row card">
    <label>Admin Token <input id="token" type="password" placeholder="x-admin-token" /></label>
    <button id="refresh">Refresh</button>
    <button id="reload">Rules Reload</button>
    <span id="statusMsg"></span>
  </div>

  <div class="card">
    <h2>Overview</h2>
    <pre id="overview">loading...</pre>
  </div>

  <div class="card" style="margin-top:12px;">
    <h2>Sessions</h2>
    <table>
      <thead><tr><th>playerId</th><th>team</th><th>remote</th><th>bytesIn/out</th><th>lastSeen</th><th>invalid</th><th>action</th></tr></thead>
      <tbody id="sessions"></tbody>
    </table>
  </div>

  <div class="card" style="margin-top:12px;">
    <h2>Violations</h2>
    <pre id="violations">loading...</pre>
  </div>

  <script>
    const q = (s) => document.querySelector(s);
    const tokenEl = q('#token');
    const msgEl = q('#statusMsg');
    const TOKEN_STORAGE_KEY = 'wildpaw-mock-admin-token';

    function initToken() {
      const queryToken = new URLSearchParams(window.location.search).get('token') || '';
      if (queryToken) {
        tokenEl.value = queryToken;
      } else {
        const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
        if (stored) tokenEl.value = stored;
      }
    }

    function persistToken() {
      if (tokenEl.value) {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, tokenEl.value);
      } else {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
    }

    initToken();
    persistToken();
    tokenEl.addEventListener('input', persistToken);

    const headers = () => tokenEl.value ? {'x-admin-token': tokenEl.value} : {};

    function withToken(path) {
      if (!tokenEl.value) return path;
      const u = new URL(path, window.location.origin);
      if (!u.searchParams.has('token')) u.searchParams.set('token', tokenEl.value);
      return u.pathname + u.search;
    }

    async function api(path, options = {}) {
      const res = await fetch(withToken(path), { ...options, headers: { ...(options.headers||{}), ...headers() } });
      if (!res.ok) throw new Error(path + ' ' + res.status);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    }

    async function refresh() {
      try {
        const [status, sessions, violations] = await Promise.all([
          api('/admin/api/status'),
          api('/admin/api/sessions'),
          api('/admin/api/violations'),
        ]);

        q('#overview').textContent = JSON.stringify(status, null, 2);

        const tbody = q('#sessions');
        tbody.innerHTML = '';
        for (const s of sessions.sessions || []) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td>' + s.playerId + '</td>' +
            '<td>T' + s.teamId + '-S' + s.teamSlot + '</td>' +
            '<td>' + s.remote + '</td>' +
            '<td>' + s.bytesIn + '/' + s.bytesOut + '</td>' +
            '<td>' + s.lastSeenAtMs + '</td>' +
            '<td>' + s.invalidEnvelopeTotal + '/' + s.unsupportedMessageTotal + '/0</td>' +
            '<td><button data-id="' + s.playerId + '">disconnect</button></td>';
          tr.querySelector('button').onclick = async () => {
            try {
              await api('/admin/api/sessions/' + s.playerId + '/disconnect', { method: 'POST' });
              msgEl.textContent = 'disconnected ' + s.playerId;
              await refresh();
            } catch (e) {
              msgEl.textContent = 'disconnect failed: ' + e.message;
            }
          };
          tbody.appendChild(tr);
        }

        q('#violations').textContent = JSON.stringify(violations, null, 2);
        msgEl.textContent = 'ok';
      } catch (e) {
        msgEl.textContent = 'error: ' + e.message;
      }
    }

    q('#refresh').onclick = refresh;
    q('#reload').onclick = async () => {
      try {
        const r = await api('/admin/api/rules/reload', { method:'POST' });
        msgEl.textContent = JSON.stringify(r);
        await refresh();
      } catch (e) {
        msgEl.textContent = 'reload failed: ' + e.message;
      }
    };

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;

function removeClient(client, reason = "disconnect") {
  if (!clients.has(client)) return;

  clients.delete(client);
  totalDisconnected += 1;

  if (reason === "stale-timeout") {
    totalStaleTimeouts += 1;
    recordViolation(client.remoteEndpoint, "stale-timeout", `player=${client.player.playerId}`);
  }

  if (client.clientId && clientsById.get(client.clientId) === client) {
    clientsById.delete(client.clientId);
  }

  if (clients.size === 0) {
    nextPlayerId = 1;
  }

  console.log(
    `[mock-room] ${reason} player=${client.player.playerId} hero=${client.player.heroId} total=${clients.size}`,
  );
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

function applyHeroProfile(client, rawHeroId) {
  const profile = getHeroProfile(rawHeroId);
  client.profile = profile;

  client.player.heroId = profile.heroId;
  client.player.heroName = profile.nameKr;

  client.player.maxHp = profile.maxHp;
  client.player.hp = profile.maxHp;
  client.player.shield = 0;

  client.player.maxAmmo = profile.weapon.ammo;
  client.player.ammo = Math.min(client.player.ammo, profile.weapon.ammo);
  if (client.player.ammo <= 0) {
    client.player.ammo = profile.weapon.ammo;
  }

  client.player.reloading = false;
  client.player.reloadingUntilMs = 0;
  client.player.nextFireAtMs = 0;
  client.player.sustainedFireStartMs = 0;
}

function applyInput(client, input, nowMs) {
  let moveX = clamp(asNumber(input?.moveX, 0), -1, 1);
  let moveY = clamp(asNumber(input?.moveY, 0), -1, 1);
  const length = Math.hypot(moveX, moveY);
  if (length > 1) {
    moveX /= length;
    moveY /= length;
  }

  const speed = asNumber(client.profile?.moveSpeed, 5);
  client.player.vx = moveX * speed;
  client.player.vy = moveY * speed;

  const inputSeq = asNumber(input?.seq, client.player.lastProcessedInputSeq);
  if (inputSeq >= client.player.lastProcessedInputSeq) {
    client.player.lastProcessedInputSeq = inputSeq;
  }

  const aimX = asNumber(input?.aimX, client.player.aimX);
  const aimY = asNumber(input?.aimY, client.player.aimY);
  client.player.aimX = aimX;
  client.player.aimY = aimY;

  const fireHeld = Boolean(input?.fire);
  if (fireHeld) {
    if (!client.player.fireHeld) {
      client.player.sustainedFireStartMs = nowMs;
    }
  } else {
    client.player.sustainedFireStartMs = 0;
  }
  client.player.fireHeld = fireHeld;

  const aimDx = aimX - client.player.x;
  const aimDy = aimY - client.player.y;
  if (Math.hypot(aimDx, aimDy) > 0.001) {
    client.player.rot = Math.atan2(aimDx, aimDy);
  } else if (Math.hypot(client.player.vx, client.player.vy) > 0.001) {
    client.player.rot = Math.atan2(client.player.vx, client.player.vy);
  }
}

function getAimDirection(client) {
  const dx = client.player.aimX - client.player.x;
  const dy = client.player.aimY - client.player.y;
  const length = Math.hypot(dx, dy);
  if (length > 0.001) {
    return { x: dx / length, y: dy / length };
  }

  return {
    x: Math.sin(client.player.rot),
    y: Math.cos(client.player.rot),
  };
}

function pickShotTarget(attacker) {
  const dir = getAimDirection(attacker);
  const hitWidth = computeHitWidthByClass(attacker.profile.weapon.className);
  const maxRange = attacker.profile.weapon.rangeM;

  let bestClient = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of clients) {
    if (candidate === attacker) continue;
    if (!candidate.player.alive) continue;
    if (candidate.player.team === attacker.player.team) continue;

    const toX = candidate.player.x - attacker.player.x;
    const toY = candidate.player.y - attacker.player.y;

    const forward = toX * dir.x + toY * dir.y;
    if (forward < 0 || forward > maxRange) continue;

    const lateral = Math.abs(toX * dir.y - toY * dir.x);
    const allowed = hitWidth + asNumber(candidate.profile.hitboxRadius, 0.5) * 0.7;
    if (lateral > allowed) continue;

    const score = forward + lateral * 0.5;
    if (score < bestScore) {
      bestScore = score;
      bestClient = candidate;
    }
  }

  return bestClient;
}

function isSideOrBackAttack(attacker, target) {
  const toAttackerX = attacker.player.x - target.player.x;
  const toAttackerY = attacker.player.y - target.player.y;
  const len = Math.hypot(toAttackerX, toAttackerY);
  if (len < 0.001) return false;

  const facingX = Math.sin(target.player.rot);
  const facingY = Math.cos(target.player.rot);
  const dot = facingX * (toAttackerX / len) + facingY * (toAttackerY / len);

  // <= 0.5 means side or back arc.
  return dot <= 0.5;
}

function computeCurrentShotsPerSec(client, nowMs) {
  const weapon = client.profile.weapon;
  const min = weapon.shotsPerSecMin;
  const max = weapon.shotsPerSecMax;

  if (Number.isFinite(min) && Number.isFinite(max)) {
    const start = client.player.sustainedFireStartMs || nowMs;
    const elapsed = Math.max(0, nowMs - start);
    const t = clamp(elapsed / Math.max(1, weapon.spinUpMs), 0, 1);
    return Math.max(1, lerp(min, max, t));
  }

  return Math.max(1, weapon.shotsPerSec);
}

function computeShotDamage(attacker, target, distance, nowMs) {
  const weapon = attacker.profile.weapon;
  const passive = attacker.profile.passive ?? {};

  let damage = weapon.damagePerShot;
  damage *= computeDamageFalloff(distance, weapon.falloffStartM, weapon.falloffEndM);

  if (attacker.profile.heroId === "coral_cat") {
    const idleWindow = asNumber(passive.outOfCombatRequiredMs, 1200);
    const firstShotBonus = asNumber(passive.firstShotBonus, 0.3);
    if (nowMs - attacker.player.lastShotAtMs >= idleWindow) {
      damage *= 1 + firstShotBonus;
    }
  }

  if (attacker.profile.heroId === "rockhorn_rhino") {
    const rampUpMs = asNumber(passive.rampUpMs, 2500);
    const maxAmp = asNumber(passive.sustainedFireDamageAmp, 0.18);
    const sustainedMs = attacker.player.sustainedFireStartMs > 0
      ? Math.max(0, nowMs - attacker.player.sustainedFireStartMs)
      : 0;
    const amp = maxAmp * clamp(sustainedMs / Math.max(1, rampUpMs), 0, 1);
    damage *= 1 + amp;
  }

  let critChance = 0.05;
  if (attacker.profile.heroId === "lumifox" && isSideOrBackAttack(attacker, target)) {
    critChance += asNumber(passive.sideBackCritChanceBonus, 0.12);
  }

  const critical = Math.random() < clamp(critChance, 0, 0.85);
  if (critical) {
    damage *= weapon.critMultiplier;
  }

  if (target.profile.heroId === "bruno_bear") {
    const targetPassive = target.profile.passive ?? {};
    const reductionRadius = asNumber(targetPassive.closeRangeRadiusM, 6.0);
    const reductionRatio = asNumber(targetPassive.closeRangeDamageReduction, 0.15);
    if (distance <= reductionRadius) {
      damage *= 1 - clamp(reductionRatio, 0, 0.8);
    }
  }

  return {
    damage: Math.max(1, Math.round(damage)),
    critical,
  };
}

function respawnPlayer(client) {
  client.player.alive = true;
  client.player.hp = client.profile.maxHp;
  client.player.maxHp = client.profile.maxHp;
  client.player.shield = 0;

  client.player.x = client.player.spawnX;
  client.player.y = client.player.spawnY;
  client.player.vx = 0;
  client.player.vy = 0;

  client.player.fireHeld = false;
  client.player.sustainedFireStartMs = 0;
  client.player.nextFireAtMs = 0;

  client.player.ammo = client.profile.weapon.ammo;
  client.player.maxAmmo = client.profile.weapon.ammo;
  client.player.reloading = false;
  client.player.reloadingUntilMs = 0;
  client.player.respawnAtMs = 0;
}

function emitHitConfirm(attacker, target, result, nowMs) {
  safeSend(attacker.ws, {
    t: OPCODES.S2C_EVENT,
    d: {
      kind: "hit-confirm",
      attackerPlayerId: attacker.player.playerId,
      targetPlayerId: target.player.playerId,
      targetX: target.player.x,
      targetY: target.player.y,
      damage: result.damage,
      critical: result.critical,
      targetHp: target.player.hp,
      targetAlive: target.player.alive,
      serverTimeMs: nowMs,
    },
  });
}

function emitDamageTaken(attacker, target, result, nowMs) {
  safeSend(target.ws, {
    t: OPCODES.S2C_EVENT,
    d: {
      kind: "damage-taken",
      attackerPlayerId: attacker.player.playerId,
      targetPlayerId: target.player.playerId,
      attackerX: attacker.player.x,
      attackerY: attacker.player.y,
      targetX: target.player.x,
      targetY: target.player.y,
      damage: result.damage,
      critical: result.critical,
      targetHp: target.player.hp,
      targetAlive: target.player.alive,
      serverTimeMs: nowMs,
    },
  });
}

function tryFire(client, nowMs) {
  if (!client.player.alive) return;
  if (!client.player.fireHeld) return;

  if (client.player.reloading) {
    if (nowMs >= client.player.reloadingUntilMs) {
      client.player.reloading = false;
      client.player.reloadingUntilMs = 0;
      client.player.ammo = client.player.maxAmmo;
    } else {
      return;
    }
  }

  if (client.player.ammo <= 0) {
    client.player.reloading = true;
    client.player.reloadingUntilMs = nowMs + client.profile.weapon.reloadMs;
    return;
  }

  if (nowMs < client.player.nextFireAtMs) {
    return;
  }

  const target = pickShotTarget(client);
  if (target) {
    const dist = Math.hypot(target.player.x - client.player.x, target.player.y - client.player.y);
    const result = computeShotDamage(client, target, dist, nowMs);
    target.player.hp = Math.max(0, target.player.hp - result.damage);

    if (target.player.hp <= 0 && target.player.alive) {
      target.player.alive = false;
      target.player.vx = 0;
      target.player.vy = 0;
      target.player.fireHeld = false;
      target.player.reloading = false;
      target.player.respawnAtMs = nowMs + RESPAWN_MS;
    }

    emitHitConfirm(client, target, result, nowMs);
    emitDamageTaken(client, target, result, nowMs);
  }

  client.player.ammo -= 1;
  client.player.lastShotAtMs = nowMs;

  if (client.player.ammo <= 0) {
    client.player.reloading = true;
    client.player.reloadingUntilMs = nowMs + client.profile.weapon.reloadMs;
  }

  const fireIntervalMs = Math.round(1000 / Math.max(1, computeCurrentShotsPerSec(client, nowMs)));
  client.player.nextFireAtMs = nowMs + Math.max(25, fireIntervalMs);
}

wss.on("connection", (ws, req) => {
  const playerId = nextPlayerId++;
  const profile = getHeroProfile(DEFAULT_HERO_ID);
  const remoteAddress = req?.socket?.remoteAddress ?? "unknown";
  const remotePort = req?.socket?.remotePort ?? 0;

  const client = {
    ws,
    profile,
    player: createPlayerState(playerId, profile),
    clientId: null,
    lastSeenAt: Date.now(),
    connectedAtMs: Date.now(),
    remoteEndpoint: `${remoteAddress}:${remotePort}`,
    parseErrorTotal: 0,
    unsupportedMessageTotal: 0,
  };

  clients.add(client);
  totalConnected += 1;

  console.log(
    `[mock-room] connected player=${playerId} hero=${client.player.heroId} total=${clients.size}`,
  );

  safeSend(ws, {
    t: OPCODES.S2C_WELCOME,
    d: {
      playerId,
      heroId: client.player.heroId,
      serverTimeMs: Date.now(),
    },
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
      totalParseErrors += 1;
      client.parseErrorTotal += 1;
      recordViolation(client.remoteEndpoint, "invalid_json", String(raw).slice(0, 180));
      return;
    }

    if (!envelope || typeof envelope !== "object") {
      totalParseErrors += 1;
      client.parseErrorTotal += 1;
      recordViolation(client.remoteEndpoint, "invalid_envelope", "non-object envelope");
      return;
    }

    client.lastSeenAt = Date.now();

    switch (envelope.t) {
      case OPCODES.C2S_HELLO:
        attachClientIdentity(client, envelope?.d?.clientId);
        applyHeroProfile(client, envelope?.d?.heroId);

        safeSend(ws, {
          t: OPCODES.S2C_WELCOME,
          d: {
            playerId,
            heroId: client.player.heroId,
            serverTimeMs: Date.now(),
          },
        });
        break;

      case OPCODES.C2S_INPUT:
        applyInput(client, envelope.d, Date.now());
        break;

      case OPCODES.C2S_PING:
        totalPingReceived += 1;
        safeSend(ws, {
          t: OPCODES.S2C_PONG,
          d: { serverTimeMs: Date.now() },
        });
        break;

      default:
        totalUnsupportedMessages += 1;
        client.unsupportedMessageTotal += 1;
        recordViolation(client.remoteEndpoint, "unsupported_opcode", String(envelope.t ?? "unknown"));
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
      continue;
    }

    if (!client.player.alive && client.player.respawnAtMs > 0 && now >= client.player.respawnAtMs) {
      respawnPlayer(client);
    }
  }

  serverTick += 1;
  const dt = TICK_MS / 1000;

  for (const client of clients) {
    const player = client.player;

    if (!player.alive) {
      continue;
    }

    player.x = clamp(player.x + player.vx * dt, WORLD_MIN, WORLD_MAX);
    player.y = clamp(player.y + player.vy * dt, WORLD_MIN, WORLD_MAX);

    tryFire(client, now);
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
    totalSnapshotsSent += 1;
  }
}, TICK_MS);

const adminServer = createServer((req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;

  if (path === "/metrics") {
    writeText(res, 200, renderPrometheusMetrics(), "text/plain; version=0.0.4; charset=utf-8");
    return;
  }

  if (!path.startsWith("/admin")) {
    writeJson(res, 404, { ok: false, error: "not found" });
    return;
  }

  if (!isAdminAuthorized(req, url)) {
    writeJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (method === "GET" && (path === "/admin" || path === "/admin/")) {
    writeText(res, 200, ADMIN_HTML, "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && path === "/admin/api/status") {
    writeJson(res, 200, renderAdminStatus());
    return;
  }

  if (method === "GET" && path === "/admin/api/sessions") {
    writeJson(res, 200, renderAdminSessions());
    return;
  }

  if (method === "GET" && path === "/admin/api/violations") {
    writeJson(res, 200, renderAdminViolations());
    return;
  }

  if (method === "POST" && path === "/admin/api/rules/reload") {
    writeJson(res, 200, { ok: true, message: "mock-room: rules reload noop" });
    return;
  }

  if (method === "POST" && path.startsWith("/admin/api/sessions/") && path.endsWith("/disconnect")) {
    const playerIdRaw = path.slice("/admin/api/sessions/".length, -"/disconnect".length);
    const playerId = Number(playerIdRaw);

    if (!Number.isFinite(playerId) || playerId <= 0) {
      writeJson(res, 400, { ok: false, error: "invalid player id" });
      return;
    }

    const target = [...clients].find((client) => client.player.playerId === playerId);
    if (!target) {
      writeJson(res, 404, { ok: false, error: "session not found" });
      return;
    }

    try {
      target.ws.close(4002, "admin disconnect");
    } catch {
      // ignore close errors
    }

    writeJson(res, 200, { ok: true, message: "disconnect requested" });
    return;
  }

  writeJson(res, 404, { ok: false, error: "not found" });
});

adminServer.listen(ADMIN_PORT, "0.0.0.0", () => {
  console.log(
    `[mock-room-admin] listening on http://0.0.0.0:${ADMIN_PORT}/admin/ auth=${ADMIN_TOKEN ? "on" : "off"}`,
  );
});

console.log(
  `[mock-room] listening on ws://0.0.0.0:${PORT} (${TICK_HZ}Hz) heroes=${HERO_PROFILES.size}`,
);
