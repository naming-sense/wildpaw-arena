import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { WebSocketServer } from "ws";

const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 7200);
const MIN_APP_VERSION = process.env.MIN_APP_VERSION ?? "0.2.0";
const STORE_URL = process.env.STORE_URL ?? "https://example.com/wildpaw/update";

const READY_CHECK_TIMEOUT_SEC = Number(process.env.READY_CHECK_TIMEOUT_SEC ?? 10);
const DRAFT_TURN_SEC = Number(process.env.DRAFT_TURN_SEC ?? 20);
const MATCH_ASSIGN_CONNECT_TIMEOUT_SEC = Number(
  process.env.MATCH_ASSIGN_CONNECT_TIMEOUT_SEC ?? 8,
);
const RECONNECT_WINDOW_SEC = Number(process.env.RECONNECT_WINDOW_SEC ?? 20);
const QUEUE_PENALTY_SEC = Number(process.env.QUEUE_PENALTY_SEC ?? 30);
const SIM_MATCH_DURATION_SEC = Number(process.env.SIM_MATCH_DURATION_SEC ?? 45);

const MATCHMAKING_EXPANSION_STEPS = [
  {
    stage: 0,
    minElapsedSec: 0,
    maxPingMs: 95,
    srRange: 140,
    maxTeamSrDiff: 80,
    strictRegion: true,
  },
  {
    stage: 1,
    minElapsedSec: 2,
    maxPingMs: 130,
    srRange: 420,
    maxTeamSrDiff: 160,
    strictRegion: false,
  },
  {
    stage: 2,
    minElapsedSec: 8,
    maxPingMs: 220,
    srRange: 900,
    maxTeamSrDiff: 280,
    strictRegion: false,
  },
];

const MATCHMAKING_EXTREME_WAIT_SEC = 180;

const ROOM_ENDPOINT =
  process.env.ROOM_ENDPOINT ?? "ws://127.0.0.1:7001";
const ROOM_REGION = process.env.ROOM_REGION ?? "KR";
const ROOM_TOKEN_TTL_SEC = Number(process.env.ROOM_TOKEN_TTL_SEC ?? 45);
const ROOM_TOKEN_SECRET =
  process.env.WILDPAW_ROOM_TOKEN_SECRET ?? "dev-room-secret";

const SOLO_TEST_MODE_ID = "solo_test";
const SOLO_TEST_MAP_POOL = ["NJD_CR_01"];

const FLOW_STATES = {
  BOOT: "BOOT",
  AUTH: "AUTH",
  ONBOARDING: "ONBOARDING",
  LOBBY: "LOBBY",
  QUEUEING: "QUEUEING",
  READY_CHECK: "READY_CHECK",
  DRAFT: "DRAFT",
  MATCH_LOADING: "MATCH_LOADING",
  IN_MATCH: "IN_MATCH",
  RESULT: "RESULT",
};

const CONTROL_EVENTS = {
  C2S_BOOT_READY: "C2S_BOOT_READY",
  C2S_AUTH_LOGIN: "C2S_AUTH_LOGIN",
  C2S_AUTH_GUEST: "C2S_AUTH_GUEST",
  C2S_ONBOARDING_COMPLETE: "C2S_ONBOARDING_COMPLETE",

  C2S_PARTY_CREATE: "C2S_PARTY_CREATE",
  C2S_PARTY_INVITE: "C2S_PARTY_INVITE",
  C2S_PARTY_ACCEPT: "C2S_PARTY_ACCEPT",
  C2S_PARTY_LEAVE: "C2S_PARTY_LEAVE",
  C2S_PARTY_KICK: "C2S_PARTY_KICK",
  C2S_PARTY_READY_TOGGLE: "C2S_PARTY_READY_TOGGLE",

  C2S_CUSTOM_ROOM_CREATE: "C2S_CUSTOM_ROOM_CREATE",
  C2S_CUSTOM_ROOM_JOIN: "C2S_CUSTOM_ROOM_JOIN",
  C2S_CUSTOM_ROOM_START: "C2S_CUSTOM_ROOM_START",
  C2S_CUSTOM_ROOM_UPDATE_SETTINGS: "C2S_CUSTOM_ROOM_UPDATE_SETTINGS",

  C2S_QUEUE_JOIN: "C2S_QUEUE_JOIN",
  C2S_QUEUE_CANCEL: "C2S_QUEUE_CANCEL",

  C2S_MATCH_ACCEPT: "C2S_MATCH_ACCEPT",
  C2S_DRAFT_ACTION: "C2S_DRAFT_ACTION",

  C2S_ROOM_CONNECT_RESULT: "C2S_ROOM_CONNECT_RESULT",
  C2S_REMATCH_VOTE: "C2S_REMATCH_VOTE",
  C2S_PING: "C2S_PING",
};

const ERROR_CODES = {
  AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  QUEUE_INVALID_MODE: "QUEUE_INVALID_MODE",
  QUEUE_PENALTY_ACTIVE: "QUEUE_PENALTY_ACTIVE",
  READY_TIMEOUT: "READY_TIMEOUT",
  DRAFT_INVALID_TURN: "DRAFT_INVALID_TURN",
  DRAFT_HERO_UNAVAILABLE: "DRAFT_HERO_UNAVAILABLE",
  MATCH_ASSIGN_EXPIRED: "MATCH_ASSIGN_EXPIRED",
  ROOM_CONNECT_FAIL: "ROOM_CONNECT_FAIL",
  RECONNECT_WINDOW_EXPIRED: "RECONNECT_WINDOW_EXPIRED",
  BAD_REQUEST: "BAD_REQUEST",
  INVALID_STATE: "INVALID_STATE",
  UNSUPPORTED_EVENT: "UNSUPPORTED_EVENT",
};

const HERO_POOL = [
  "iris_wolf",
  "milky_rabbit",
  "rockhorn_rhino",
  "lumifox",
  "coral_cat",
  "mint_ferret",
  "storm_otter",
  "nimbus_hound",
  "ember_lynx",
  "frost_owl",
  "iron_pangolin",
  "shadow_marten",
];

let nextConnectionId = 1;
let nextGuestId = 1;
let nextPartyId = 1;
let nextCustomRoomId = 1;
let nextQueueTicketId = 1;
let nextMatchCandidateId = 1;
let nextMatchId = 1;

/** @type {Map<import('ws').WebSocket, Session>} */
const sessions = new Map();
/** @type {Map<string, Session>} */
const sessionsBySessionId = new Map();
/** @type {Map<string, Session>} */
const sessionsByAccountId = new Map();

/** @type {Map<string, {displayName: string, onboardingDone: boolean, sr: number, rd: number, matchesPlayed: number}>} */
const accountProfiles = new Map();
/** @type {Map<string, number>} */
const queuePenaltyUntilByAccount = new Map();

/** @type {Map<string, Party>} */
const parties = new Map();
/** @type {Map<string, CustomRoom>} */
const customRooms = new Map();

/** @type {Map<string, QueueTicket>} */
const queueTickets = new Map();
/** @type {Map<string, string[]>} modeId -> ticketIds */
const queueBuckets = new Map();
/** @type {Map<string, number>} */
const lastQueueNeedLogAtByMode = new Map();

/** @type {Map<string, MatchCandidate>} */
const matchCandidates = new Map();
/** @type {Map<string, MatchState>} */
const matches = new Map();

const queueAndMatchmakeTimer = setInterval(() => {
  pushQueueStatusAll();
  runMatchmaker();
}, 1000);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  clearInterval(queueAndMatchmakeTimer);
  for (const candidate of matchCandidates.values()) {
    clearTimeout(candidate.timeoutHandle);
  }
  for (const match of matches.values()) {
    clearTimeout(match.draftTimeoutHandle);
    clearTimeout(match.matchEndHandle);
  }
  wss.close();
}

function makeId(prefix, next) {
  return `${prefix}_${next}`;
}

function nowMs() {
  return Date.now();
}

function hashShort(raw) {
  return createHash("sha1").update(String(raw)).digest("hex").slice(0, 10);
}

function fnv1a32(raw) {
  let hash = 0x811c9dc5;
  const text = String(raw);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toHex8(value) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function signRoomToken(matchId, mapId, expiresAtMs) {
  return toHex8(
    fnv1a32(`${matchId}:${mapId}:${expiresAtMs}:${ROOM_TOKEN_SECRET}`),
  );
}

function compareSemver(a, b) {
  const pa = String(a).split(".").map((v) => Number(v) || 0);
  const pb = String(b).split(".").map((v) => Number(v) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getQueueExpansion(elapsedSec) {
  let picked = MATCHMAKING_EXPANSION_STEPS[0];

  for (const step of MATCHMAKING_EXPANSION_STEPS) {
    if (elapsedSec >= step.minElapsedSec) {
      picked = step;
    }
  }

  return picked;
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const total = values.reduce((acc, value) => acc + value, 0);
  return total / values.length;
}

function stdDev(values) {
  if (!Array.isArray(values) || values.length <= 1) {
    return 0;
  }

  const avg = average(values);
  const variance = average(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function deriveInitialSkill(accountId) {
  const digest = createHash("sha1").update(String(accountId)).digest();
  const seed = ((digest[0] ?? 0) << 8) | (digest[1] ?? 0);

  const sr = 1200 + (seed % 900);
  const rd = 280 + (seed % 120);

  return { sr, rd };
}

function modeToTeamSize(modeId) {
  if (typeof modeId !== "string") return null;
  if (isSoloPracticeMode(modeId)) return 1;

  const match = modeId.match(/^(\d+)v\1/i);
  if (!match) return null;
  const size = Number(match[1]);
  if (!Number.isFinite(size) || size <= 0) return null;
  return size;
}

function isSoloPracticeMode(modeId) {
  return String(modeId ?? "").toLowerCase() === SOLO_TEST_MODE_ID;
}

function partyBucketForSize(size, teamSize) {
  if (size <= 1) return "solo";
  if (size === 2) return "duo";
  if (size >= teamSize) return teamSize === 5 ? "5-stack" : "full-party";
  return `party-${size}`;
}

function isLoopbackHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function resolveRoomEndpointForSession(session) {
  const fallback = ROOM_ENDPOINT;

  try {
    const endpoint = new URL(fallback);
    if (!isLoopbackHost(endpoint.hostname)) {
      return fallback;
    }

    const hostHeader = String(session.controlHost ?? "").trim();
    if (!hostHeader) {
      return fallback;
    }

    const controlUrl = new URL(`ws://${hostHeader}`);
    if (!controlUrl.hostname || isLoopbackHost(controlUrl.hostname)) {
      return fallback;
    }

    endpoint.hostname = controlUrl.hostname;
    return endpoint.toString();
  } catch {
    return fallback;
  }
}

function isDevMode(modeId) {
  return /_dev$/i.test(String(modeId ?? ""));
}

function activeQueuePlayerCount(modeId) {
  const ids = queueBuckets.get(modeId) ?? [];
  let count = 0;

  for (const ticketId of ids) {
    const ticket = queueTickets.get(ticketId);
    if (isActiveQueueTicket(ticket)) {
      count += 1;
    }
  }

  return count;
}

function setFlowState(session, nextState) {
  session.flowState = nextState;
}

function randomFrom(array) {
  if (!Array.isArray(array) || array.length === 0) return null;
  return array[Math.floor(Math.random() * array.length)] ?? null;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isOpen(ws) {
  return ws.readyState === ws.OPEN;
}

function makeOutboundEnvelope(session, event, payload, requestId = null) {
  return {
    event,
    eventId: randomUUID(),
    requestId,
    sessionId: session.sessionId ?? null,
    ts: nowMs(),
    payload,
  };
}

function sendRaw(session, envelope) {
  if (!isOpen(session.ws)) return;
  session.ws.send(JSON.stringify(envelope));
}

function cacheResponse(session, incomingEventId, outboundEnvelope) {
  if (!incomingEventId) return;

  if (!session.responseCache.has(incomingEventId)) {
    session.responseCache.set(incomingEventId, []);
    session.responseCacheOrder.push(incomingEventId);

    if (session.responseCacheOrder.length > 256) {
      const oldest = session.responseCacheOrder.shift();
      if (oldest) {
        session.responseCache.delete(oldest);
      }
    }
  }

  session.responseCache.get(incomingEventId)?.push(outboundEnvelope);
}

function sendFromRequestContext(ctx, event, payload) {
  const envelope = makeOutboundEnvelope(ctx.session, event, payload, ctx.requestId);
  sendRaw(ctx.session, envelope);
  cacheResponse(ctx.session, ctx.incomingEventId, envelope);
}

function sendPush(session, event, payload) {
  const envelope = makeOutboundEnvelope(session, event, payload, null);
  sendRaw(session, envelope);
}

function sendError(ctx, code, message, details = undefined) {
  sendFromRequestContext(ctx, "S2C_ERROR", {
    errorCode: code,
    message,
    details,
    flowState: ctx.session.flowState,
  });
}

function sendErrorPush(session, code, message, details = undefined) {
  sendPush(session, "S2C_ERROR", {
    errorCode: code,
    message,
    details,
    flowState: session.flowState,
  });
}

function sendStatePush(session) {
  sendPush(session, "S2C_FLOW_STATE", {
    state: session.flowState,
  });
}

function requireAuth(ctx) {
  if (!ctx.session.sessionId || !ctx.session.accountId) {
    sendError(ctx, ERROR_CODES.AUTH_INVALID_TOKEN, "Auth required");
    return false;
  }
  return true;
}

function checkSessionId(ctx) {
  if (!ctx.session.sessionId) {
    return true;
  }

  if (typeof ctx.incoming.sessionId !== "string") {
    sendError(ctx, ERROR_CODES.AUTH_INVALID_TOKEN, "Missing sessionId");
    return false;
  }

  if (ctx.incoming.sessionId !== ctx.session.sessionId) {
    sendError(ctx, ERROR_CODES.AUTH_INVALID_TOKEN, "sessionId mismatch");
    return false;
  }

  return true;
}

function requireFlowState(ctx, states) {
  const allow = Array.isArray(states) ? states : [states];
  if (allow.includes(ctx.session.flowState)) {
    return true;
  }

  sendError(
    ctx,
    ERROR_CODES.INVALID_STATE,
    `Invalid flow state: ${ctx.session.flowState}`,
    {
      expected: allow,
    },
  );
  return false;
}

function getPartyMemberRows(party) {
  const rows = [];
  for (const accountId of party.memberAccountIds) {
    const ready = party.readyByAccount.get(accountId) ?? false;
    rows.push({ accountId, ready });
  }
  return rows;
}

function broadcastPartyState(party) {
  const payload = {
    partyId: party.partyId,
    leaderId: party.leaderAccountId,
    members: getPartyMemberRows(party),
    modeId: party.modeId,
  };

  for (const accountId of party.memberAccountIds) {
    const memberSession = sessionsByAccountId.get(accountId);
    if (!memberSession) continue;
    sendPush(memberSession, "S2C_PARTY_STATE", payload);
  }
}

function removeSessionFromParty(session) {
  if (!session.partyId) {
    return;
  }

  const party = parties.get(session.partyId);
  const accountId = session.accountId;
  if (!party || !accountId) {
    session.partyId = null;
    return;
  }

  party.memberAccountIds = party.memberAccountIds.filter((id) => id !== accountId);
  party.readyByAccount.delete(accountId);

  if (party.memberAccountIds.length === 0) {
    parties.delete(party.partyId);
    session.partyId = null;
    return;
  }

  if (party.leaderAccountId === accountId) {
    party.leaderAccountId = party.memberAccountIds[0];
  }

  session.partyId = null;
  broadcastPartyState(party);
}

function upsertPenalty(accountId, seconds) {
  const penaltyUntil = nowMs() + seconds * 1000;
  queuePenaltyUntilByAccount.set(accountId, penaltyUntil);
  return penaltyUntil;
}

function getPenaltyRemainingSec(accountId) {
  const until = queuePenaltyUntilByAccount.get(accountId);
  if (!until) return 0;
  const remainingMs = until - nowMs();
  if (remainingMs <= 0) {
    queuePenaltyUntilByAccount.delete(accountId);
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}

function removeQueueTicket(ticketId) {
  const ticket = queueTickets.get(ticketId);
  if (!ticket) {
    return;
  }

  queueTickets.delete(ticketId);

  const bucket = queueBuckets.get(ticket.modeId);
  if (!bucket) {
    return;
  }

  const next = bucket.filter((id) => id !== ticketId);
  if (next.length === 0) {
    queueBuckets.delete(ticket.modeId);
  } else {
    queueBuckets.set(ticket.modeId, next);
  }

  console.log(
    `[gateway][queue.leave] account=${ticket.accountId} session=${ticket.sessionId} mode=${ticket.modeId} queued=${activeQueuePlayerCount(ticket.modeId)}/${ticket.requiredCount}`,
  );
}

function attachQueueTicketToSession(session, ticketId) {
  if (session.queueTicketId && session.queueTicketId !== ticketId) {
    removeQueueTicket(session.queueTicketId);
  }
  session.queueTicketId = ticketId;
}

function setSessionLobby(session) {
  setFlowState(session, FLOW_STATES.LOBBY);
  session.queueTicketId = null;
  session.activeMatchCandidateId = null;
  session.activeMatchId = null;
}

function startSoloPracticeMatch(session, modeId, requestId, incomingEventId) {
  const matchId = makeId("solo", nextMatchId++);
  const mapId = SOLO_TEST_MAP_POOL[0] ?? "NJD_CR_01";

  const match = {
    matchId,
    modeId,
    participantSessionIds: [session.sessionId],
    teamA: [session.sessionId],
    teamB: [],
    draftType: "SOLO_PRACTICE",
    turnOrder: [],
    timePerTurnSec: 0,
    turnSeq: 0,
    turnStartedAt: nowMs(),
    teamState: {
      teamA: { bans: [], picks: [], locked: [] },
      teamB: { bans: [], picks: [], locked: [] },
    },
    draftActionKeys: new Set(),
    resolved: true,
    draftTimeoutHandle: null,
    matchEndHandle: null,
    rematchVotes: new Map(),
    roomAssignRetryBySessionId: new Map(),
    mapId,
    quality: {
      qualityTier: "SOLO_PRACTICE",
      expansionStage: 0,
      maxPingMs: null,
      srRange: null,
      maxTeamSrDiff: null,
      avgSrDiff: 0,
      partySymmetryPenalty: 0,
      srStdGap: 0,
      anchorWaitSec: 0,
      extremeWait: false,
    },
  };

  matches.set(matchId, match);

  session.queueTicketId = null;
  session.activeMatchCandidateId = null;
  session.activeMatchId = matchId;
  session.teamInfo = { teamId: 1, slot: 1 };
  setFlowState(session, FLOW_STATES.MATCH_LOADING);

  const token = assignRoomToken(matchId, mapId);
  const roomEndpoint = resolveRoomEndpointForSession(session);

  const assignEnvelope = makeOutboundEnvelope(
    session,
    "S2C_MATCH_ASSIGN",
    {
      matchId,
      room: {
        endpoint: roomEndpoint,
        roomToken: token.token,
        region: ROOM_REGION,
        expiresAtMs: token.expiresAtMs,
      },
      mapId,
      modeId,
      teamInfo: { teamId: 1, slot: 1 },
      matchQuality: match.quality,
      reconnectWindowSec: RECONNECT_WINDOW_SEC,
      roomConnectTimeoutSec: MATCH_ASSIGN_CONNECT_TIMEOUT_SEC,
    },
    requestId,
  );

  sendRaw(session, assignEnvelope);
  cacheResponse(session, incomingEventId, assignEnvelope);

  match.matchEndHandle = setTimeout(() => {
    finishMatch(matchId);
  }, SIM_MATCH_DURATION_SEC * 1000);

  console.log(
    `[gateway][solo.start] account=${session.accountId} session=${session.sessionId} mode=${modeId} match=${matchId} map=${mapId}`,
  );

  return true;
}

function enqueueSession(session, payload, requestId, incomingEventId) {
  const modeId = String(payload?.modeId ?? "");
  const teamSize = modeToTeamSize(modeId);

  if (!teamSize) {
    const ctx = {
      session,
      requestId,
      incomingEventId,
      incoming: { payload },
    };
    sendError(
      ctx,
      ERROR_CODES.QUEUE_INVALID_MODE,
      `Invalid modeId: ${modeId}`,
    );
    return false;
  }

  const requestedPartyId =
    typeof payload?.partyId === "string" && payload.partyId.length > 0
      ? payload.partyId
      : null;

  if (requestedPartyId && session.partyId && requestedPartyId !== session.partyId) {
    const ctx = {
      session,
      requestId,
      incomingEventId,
      incoming: { payload },
    };
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "partyId mismatch with current session");
    return false;
  }

  const remainingPenalty = getPenaltyRemainingSec(session.accountId);
  if (remainingPenalty > 0) {
    const ctx = {
      session,
      requestId,
      incomingEventId,
      incoming: { payload },
    };
    sendError(
      ctx,
      ERROR_CODES.QUEUE_PENALTY_ACTIVE,
      `Queue penalty active (${remainingPenalty}s)` ,
      { remainingSec: remainingPenalty },
    );

    sendFromRequestContext(ctx, "S2C_QUEUE_PENALTY_APPLIED", {
      remainingSec: remainingPenalty,
      reason: "PENALTY_ACTIVE",
    });

    return false;
  }

  if (isSoloPracticeMode(modeId)) {
    return startSoloPracticeMatch(session, modeId, requestId, incomingEventId);
  }

  const pingCandidate = Number(
    payload?.avgPingMs ?? payload?.pingMs ?? session.lastKnownPingMs ?? 80,
  );
  const avgPingMs = clamp(Number.isFinite(pingCandidate) ? pingCandidate : 80, 20, 500);
  session.lastKnownPingMs = avgPingMs;

  const ticketId = makeId("qt", nextQueueTicketId++);
  const ticket = {
    queueTicketId: ticketId,
    modeId,
    teamSize,
    requiredCount: teamSize * 2,
    accountId: session.accountId,
    sessionId: session.sessionId,
    partyId: requestedPartyId ?? session.partyId ?? null,
    regionPreference:
      typeof payload?.regionPreference === "string" ? payload.regionPreference : "KR",
    inputDevice: typeof payload?.inputDevice === "string" ? payload.inputDevice : "kbm",
    sr: Number.isFinite(session.hiddenSr) ? session.hiddenSr : 1500,
    rd: Number.isFinite(session.hiddenRd) ? session.hiddenRd : 350,
    avgPingMs,
    joinedAt: nowMs(),
  };

  queueTickets.set(ticketId, ticket);

  const bucket = queueBuckets.get(modeId) ?? [];
  bucket.push(ticketId);
  queueBuckets.set(modeId, bucket);

  attachQueueTicketToSession(session, ticketId);
  setFlowState(session, FLOW_STATES.QUEUEING);

  console.log(
    `[gateway][queue.join] account=${session.accountId} session=${session.sessionId} mode=${modeId} teamSize=${teamSize} queued=${activeQueuePlayerCount(modeId)}/${ticket.requiredCount} party=${ticket.partyId ?? "-"} sr=${Math.round(ticket.sr)} ping=${Math.round(ticket.avgPingMs)}`,
  );

  const joinedEnvelope = makeOutboundEnvelope(session, "S2C_QUEUE_JOINED", {
    queueTicketId: ticketId,
    modeId,
    joinedAt: ticket.joinedAt,
    mmr: {
      sr: Math.round(ticket.sr),
      rd: Math.round(ticket.rd),
    },
    network: {
      avgPingMs: Math.round(ticket.avgPingMs),
    },
  }, requestId);
  sendRaw(session, joinedEnvelope);
  cacheResponse(session, incomingEventId, joinedEnvelope);

  return true;
}

function pushQueueStatusAll() {
  const now = nowMs();

  for (const session of sessions.values()) {
    if (session.flowState !== FLOW_STATES.QUEUEING || !session.queueTicketId) {
      continue;
    }

    const ticket = queueTickets.get(session.queueTicketId);
    if (!ticket) {
      continue;
    }

    const elapsedSec = Math.max(0, Math.floor((now - ticket.joinedAt) / 1000));
    const expansion = getQueueExpansion(elapsedSec);
    const estimatedWaitSec = Math.max(5, ticket.requiredCount * 4 - elapsedSec);

    sendPush(session, "S2C_QUEUE_STATUS", {
      queueTicketId: ticket.queueTicketId,
      elapsedSec,
      estimatedWaitSec,
      searchRange: {
        maxPingMs: expansion.maxPingMs,
        srRange: expansion.srRange,
      },
      stage: expansion.stage,
      mmr: {
        sr: Math.round(ticket.sr),
        rd: Math.round(ticket.rd),
      },
      network: {
        avgPingMs: Math.round(ticket.avgPingMs),
      },
      queueHealth: {
        extremeWait: elapsedSec >= MATCHMAKING_EXTREME_WAIT_SEC,
      },
    });
  }
}

function isActiveQueueTicket(ticket) {
  if (!ticket) {
    return false;
  }

  const session = sessionsBySessionId.get(ticket.sessionId);
  if (!session) {
    return false;
  }

  if (session.flowState !== FLOW_STATES.QUEUEING) {
    return false;
  }

  if (session.activeMatchCandidateId) {
    return false;
  }

  return true;
}

function buildQueueUnits(modeId, ticketIds, teamSize) {
  const groupByKey = new Map();

  for (const ticketId of ticketIds) {
    const ticket = queueTickets.get(ticketId);
    if (!ticket || ticket.modeId !== modeId) {
      continue;
    }

    const groupKey = ticket.partyId
      ? `party:${ticket.partyId}`
      : `solo:${ticket.queueTicketId}`;

    if (!groupByKey.has(groupKey)) {
      groupByKey.set(groupKey, []);
    }

    groupByKey.get(groupKey).push(ticket);
  }

  const units = [];
  const now = nowMs();

  for (const [groupKey, tickets] of groupByKey.entries()) {
    if (!Array.isArray(tickets) || tickets.length === 0) {
      continue;
    }

    if (tickets.length > teamSize) {
      continue;
    }

    const joinedAt = Math.min(...tickets.map((ticket) => ticket.joinedAt));
    const playerSrs = tickets.map((ticket) => ticket.sr);
    const playerRds = tickets.map((ticket) => ticket.rd);
    const pingValues = tickets.map((ticket) => ticket.avgPingMs);

    const waitSec = Math.max(0, Math.floor((now - joinedAt) / 1000));

    units.push({
      key: groupKey,
      partyId: tickets[0].partyId,
      ticketIds: tickets.map((ticket) => ticket.queueTicketId),
      sessionIds: tickets.map((ticket) => ticket.sessionId),
      size: tickets.length,
      joinedAt,
      waitSec,
      avgSr: average(playerSrs),
      avgRd: average(playerRds),
      maxPingMs: Math.max(...pingValues),
      regionPreference: tickets[0].regionPreference,
      partyBucket: partyBucketForSize(tickets.length, teamSize),
      playerSrs,
    });
  }

  units.sort((a, b) => a.joinedAt - b.joinedAt);

  return units;
}

function canUnitJoinAnchor(unit, anchor, expansion) {
  if (!unit || !anchor) {
    return false;
  }

  if (unit.maxPingMs > expansion.maxPingMs) {
    return false;
  }

  if (Math.abs(unit.avgSr - anchor.avgSr) > expansion.srRange) {
    return false;
  }

  if (expansion.strictRegion && unit.regionPreference !== anchor.regionPreference) {
    return false;
  }

  return true;
}

function summarizeTeam(units) {
  const playersSr = [];
  let totalPlayers = 0;
  let weightedSr = 0;

  const partyCountBySize = new Map();

  for (const unit of units) {
    totalPlayers += unit.size;
    weightedSr += unit.avgSr * unit.size;

    for (const sr of unit.playerSrs) {
      playersSr.push(sr);
    }

    const sizeCount = partyCountBySize.get(unit.size) ?? 0;
    partyCountBySize.set(unit.size, sizeCount + 1);
  }

  const avgSr = totalPlayers > 0 ? weightedSr / totalPlayers : 0;
  const srStd = stdDev(playersSr);

  return {
    playersSr,
    totalPlayers,
    avgSr,
    srStd,
    partyCountBySize,
  };
}

function computePartySymmetryPenalty(teamAUnits, teamBUnits, teamSize) {
  const teamA = summarizeTeam(teamAUnits);
  const teamB = summarizeTeam(teamBUnits);

  let penalty = 0;
  for (let size = 1; size <= teamSize; size += 1) {
    const countA = teamA.partyCountBySize.get(size) ?? 0;
    const countB = teamB.partyCountBySize.get(size) ?? 0;
    penalty += Math.abs(countA - countB);
  }

  return penalty;
}

function assignUnitsToTeams(units, teamSize, maxTeamSrDiff) {
  const orderedUnits = [...units].sort((a, b) => b.size - a.size || a.joinedAt - b.joinedAt);

  let best = null;

  function evaluate(teamAUnits, teamBUnits) {
    const summaryA = summarizeTeam(teamAUnits);
    const summaryB = summarizeTeam(teamBUnits);

    if (summaryA.totalPlayers !== teamSize || summaryB.totalPlayers !== teamSize) {
      return;
    }

    const srDiff = Math.abs(summaryA.avgSr - summaryB.avgSr);
    if (srDiff > maxTeamSrDiff) {
      return;
    }

    const srStdGap = Math.abs(summaryA.srStd - summaryB.srStd);
    const partyPenalty = computePartySymmetryPenalty(teamAUnits, teamBUnits, teamSize);

    const score = partyPenalty * 1000 + srDiff * 8 + srStdGap * 4;

    if (!best || score < best.score) {
      best = {
        score,
        teamAUnits: [...teamAUnits],
        teamBUnits: [...teamBUnits],
        srDiff,
        srStdGap,
        partyPenalty,
      };
    }
  }

  function dfs(index, teamAUnits, teamBUnits, teamASize, teamBSize) {
    if (teamASize > teamSize || teamBSize > teamSize) {
      return;
    }

    if (index >= orderedUnits.length) {
      evaluate(teamAUnits, teamBUnits);
      return;
    }

    const unit = orderedUnits[index];

    teamAUnits.push(unit);
    dfs(index + 1, teamAUnits, teamBUnits, teamASize + unit.size, teamBSize);
    teamAUnits.pop();

    teamBUnits.push(unit);
    dfs(index + 1, teamAUnits, teamBUnits, teamASize, teamBSize + unit.size);
    teamBUnits.pop();
  }

  dfs(0, [], [], 0, 0);
  return best;
}

function findBestMatchFromUnits(units, teamSize, modeId) {
  const requiredCount = teamSize * 2;
  if (!Array.isArray(units) || units.length === 0) {
    return null;
  }

  const totalPlayers = units.reduce((acc, unit) => acc + unit.size, 0);
  if (totalPlayers < requiredCount) {
    return null;
  }

  if (isDevMode(modeId) && teamSize === 1) {
    const ordered = [...units]
      .filter((unit) => unit.size === 1)
      .sort((a, b) => a.joinedAt - b.joinedAt);

    if (ordered.length >= 2) {
      const selected = [ordered[0], ordered[1]];
      const ticketIds = selected.flatMap((unit) => unit.ticketIds);
      const teamA = selected[0].sessionIds.slice(0, 1);
      const teamB = selected[1].sessionIds.slice(0, 1);
      return {
        score: 0,
        ticketIds,
        participantSessionIds: [...teamA, ...teamB],
        teamAssignments: { teamA, teamB },
        quality: {
          qualityTier: "DEV_FAST_TRACK",
          expansionStage: 0,
          maxPingMs: null,
          srRange: null,
          maxTeamSrDiff: null,
          avgSrDiff: Number(Math.abs(selected[0].avgSr - selected[1].avgSr).toFixed(2)),
          partySymmetryPenalty: 0,
          srStdGap: 0,
          anchorWaitSec: Math.max(selected[0].waitSec, selected[1].waitSec),
          extremeWait: false,
        },
      };
    }
  }

  for (const anchor of units) {
    const expansion = getQueueExpansion(anchor.waitSec);

    const eligible = units.filter((unit) => canUnitJoinAnchor(unit, anchor, expansion));
    const eligiblePlayers = eligible.reduce((acc, unit) => acc + unit.size, 0);

    if (eligiblePlayers < requiredCount) {
      continue;
    }

    const ordered = [
      anchor,
      ...eligible.filter((unit) => unit.key !== anchor.key),
    ].sort((a, b) => a.joinedAt - b.joinedAt);

    let best = null;

    function evaluateUnitSubset(selectedUnits) {
      const assignment = assignUnitsToTeams(
        selectedUnits,
        teamSize,
        expansion.maxTeamSrDiff,
      );

      if (!assignment) {
        return;
      }

      const ticketIds = selectedUnits.flatMap((unit) => unit.ticketIds);
      const participantSessionIds = selectedUnits.flatMap((unit) => unit.sessionIds);
      const teamA = assignment.teamAUnits.flatMap((unit) => unit.sessionIds);
      const teamB = assignment.teamBUnits.flatMap((unit) => unit.sessionIds);

      const qualityTier =
        assignment.partyPenalty === 0 && assignment.srDiff <= 40
          ? "HIGH"
          : assignment.partyPenalty <= 1 && assignment.srDiff <= 70
            ? "MEDIUM"
            : "LOW";

      const score = assignment.score + expansion.stage * 300;
      if (!best || score < best.score) {
        best = {
          score,
          ticketIds,
          participantSessionIds,
          teamAssignments: { teamA, teamB },
          quality: {
            qualityTier,
            expansionStage: expansion.stage,
            maxPingMs: expansion.maxPingMs,
            srRange: expansion.srRange,
            maxTeamSrDiff: expansion.maxTeamSrDiff,
            avgSrDiff: Number(assignment.srDiff.toFixed(2)),
            partySymmetryPenalty: assignment.partyPenalty,
            srStdGap: Number(assignment.srStdGap.toFixed(2)),
            anchorWaitSec: anchor.waitSec,
            extremeWait: anchor.waitSec >= MATCHMAKING_EXTREME_WAIT_SEC,
          },
        };
      }
    }

    function dfs(index, selectedUnits, selectedPlayers) {
      if (selectedPlayers === requiredCount) {
        evaluateUnitSubset(selectedUnits);
        return;
      }

      if (selectedPlayers > requiredCount || index >= ordered.length) {
        return;
      }

      let remainPlayers = 0;
      for (let i = index; i < ordered.length; i += 1) {
        remainPlayers += ordered[i].size;
      }
      if (selectedPlayers + remainPlayers < requiredCount) {
        return;
      }

      const unit = ordered[index];

      selectedUnits.push(unit);
      dfs(index + 1, selectedUnits, selectedPlayers + unit.size);
      selectedUnits.pop();

      dfs(index + 1, selectedUnits, selectedPlayers);
    }

    dfs(1, [anchor], anchor.size);

    if (best) {
      return best;
    }
  }

  return null;
}

function runMatchmaker() {
  for (const [modeId, ticketIds] of queueBuckets.entries()) {
    let activeIds = ticketIds.filter((ticketId) => {
      const ticket = queueTickets.get(ticketId);
      return isActiveQueueTicket(ticket);
    });

    if (activeIds.length === 0) {
      queueBuckets.delete(modeId);
      continue;
    }

    const firstTicket = queueTickets.get(activeIds[0]);
    if (!firstTicket) {
      queueBuckets.set(modeId, activeIds);
      continue;
    }

    const teamSize = firstTicket.teamSize;
    const requiredCount = teamSize * 2;

    if (activeIds.length < requiredCount) {
      const now = nowMs();
      const lastLogAt = lastQueueNeedLogAtByMode.get(modeId) ?? 0;
      if (now - lastLogAt >= 5000) {
        const joinedAts = activeIds
          .map((ticketId) => queueTickets.get(ticketId)?.joinedAt ?? now)
          .filter((value) => Number.isFinite(value));
        const oldestJoinedAt = joinedAts.length > 0 ? Math.min(...joinedAts) : now;
        const oldestWaitSec = Math.max(0, Math.floor((now - oldestJoinedAt) / 1000));
        console.log(
          `[gateway][queue.wait] mode=${modeId} queued=${activeIds.length}/${requiredCount} oldestWaitSec=${oldestWaitSec}`,
        );
        lastQueueNeedLogAtByMode.set(modeId, now);
      }
    }

    while (activeIds.length >= requiredCount) {
      const units = buildQueueUnits(modeId, activeIds, teamSize);
      const matched = findBestMatchFromUnits(units, teamSize, modeId);

      if (!matched) {
        break;
      }

      createMatchCandidate(modeId, matched.ticketIds, {
        teamAssignments: matched.teamAssignments,
        quality: matched.quality,
      });

      const consumed = new Set(matched.ticketIds);
      activeIds = activeIds.filter((ticketId) => !consumed.has(ticketId));
    }

    if (activeIds.length === 0) {
      queueBuckets.delete(modeId);
    } else {
      queueBuckets.set(modeId, activeIds);
    }
  }
}

function createMatchCandidate(modeId, ticketIds, options = {}) {
  const candidateId = makeId("mc", nextMatchCandidateId++);
  const tickets = ticketIds
    .map((id) => queueTickets.get(id))
    .filter(Boolean);

  if (tickets.length === 0) {
    return;
  }

  const requiredCount = tickets[0].requiredCount;
  const participantSessionIds = tickets.map((ticket) => ticket.sessionId);

  const ticketSnapshotBySessionId = Object.create(null);

  for (const ticket of tickets) {
    ticketSnapshotBySessionId[ticket.sessionId] = {
      partyId: ticket.partyId,
      regionPreference: ticket.regionPreference,
      inputDevice: ticket.inputDevice,
      sr: ticket.sr,
      rd: ticket.rd,
      avgPingMs: ticket.avgPingMs,
    };

    removeQueueTicket(ticket.queueTicketId);
  }

  const candidate = {
    matchCandidateId: candidateId,
    modeId,
    requiredCount,
    participantSessionIds,
    acceptedSessionIds: new Set(),
    declinedSessionIds: new Set(),
    resolved: false,
    createdAt: nowMs(),
    timeoutHandle: null,
    mapPool: ["NJD_CR_01", "HMY_SZ_01"],
    teamAssignments: options.teamAssignments ?? null,
    quality: options.quality ?? null,
    ticketSnapshotBySessionId,
  };

  matchCandidates.set(candidateId, candidate);

  for (const sessionId of participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;

    setFlowState(session, FLOW_STATES.READY_CHECK);
    session.activeMatchCandidateId = candidateId;

    sendPush(session, "S2C_MATCH_FOUND", {
      matchCandidateId: candidateId,
      modeId,
      acceptDeadlineSec: READY_CHECK_TIMEOUT_SEC,
      mapPool: candidate.mapPool,
      quality: candidate.quality,
    });
  }

  if (candidate.quality) {
    console.log(
      `[gateway][matchmaker] candidate=${candidateId} mode=${modeId} quality=${candidate.quality.qualityTier} srDiff=${candidate.quality.avgSrDiff} partyPenalty=${candidate.quality.partySymmetryPenalty} stage=${candidate.quality.expansionStage}`,
    );
  }

  candidate.timeoutHandle = setTimeout(() => {
    resolveReadyCheck(candidateId, "FAILED_TIMEOUT");
  }, READY_CHECK_TIMEOUT_SEC * 1000);
}

function resolveReadyCheck(candidateId, failureReason = null) {
  const candidate = matchCandidates.get(candidateId);
  if (!candidate || candidate.resolved) {
    return;
  }

  candidate.resolved = true;
  clearTimeout(candidate.timeoutHandle);

  const requiredCount = candidate.requiredCount;
  const acceptedCount = candidate.acceptedSessionIds.size;

  const status =
    failureReason ?? (acceptedCount >= requiredCount ? "ALL_ACCEPTED" : "FAILED_TIMEOUT");

  for (const sessionId of candidate.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;

    sendPush(session, "S2C_READY_CHECK_RESULT", {
      matchCandidateId: candidateId,
      status,
      acceptedCount,
      requiredCount,
    });
  }

  if (status === "ALL_ACCEPTED") {
    createDraftMatch(candidate);
    matchCandidates.delete(candidateId);
    return;
  }

  // 실패 처리: 수락자는 큐 복귀, 거절/무응답자는 페널티.
  for (const sessionId of candidate.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;

    const accepted = candidate.acceptedSessionIds.has(sessionId);
    const declined = candidate.declinedSessionIds.has(sessionId);

    if (accepted && !declined) {
      setFlowState(session, FLOW_STATES.QUEUEING);
      session.activeMatchCandidateId = null;

      const ticketId = makeId("qt", nextQueueTicketId++);
      const teamSize = modeToTeamSize(candidate.modeId) ?? 3;

      const snapshot =
        candidate.ticketSnapshotBySessionId?.[sessionId] ?? null;

      const ticket = {
        queueTicketId: ticketId,
        modeId: candidate.modeId,
        teamSize,
        requiredCount: teamSize * 2,
        accountId: session.accountId,
        sessionId: session.sessionId,
        partyId: snapshot?.partyId ?? session.partyId,
        regionPreference: snapshot?.regionPreference ?? "KR",
        inputDevice: snapshot?.inputDevice ?? "kbm",
        sr: Number.isFinite(snapshot?.sr)
          ? snapshot.sr
          : Number.isFinite(session.hiddenSr)
            ? session.hiddenSr
            : 1500,
        rd: Number.isFinite(snapshot?.rd)
          ? snapshot.rd
          : Number.isFinite(session.hiddenRd)
            ? session.hiddenRd
            : 350,
        avgPingMs: clamp(
          Number.isFinite(snapshot?.avgPingMs)
            ? snapshot.avgPingMs
            : session.lastKnownPingMs ?? 80,
          20,
          500,
        ),
        joinedAt: nowMs(),
      };
      queueTickets.set(ticketId, ticket);

      const bucket = queueBuckets.get(candidate.modeId) ?? [];
      bucket.push(ticketId);
      queueBuckets.set(candidate.modeId, bucket);

      session.queueTicketId = ticketId;
      sendPush(session, "S2C_QUEUE_JOINED", {
        queueTicketId: ticketId,
        modeId: candidate.modeId,
        joinedAt: ticket.joinedAt,
        mmr: {
          sr: Math.round(ticket.sr),
          rd: Math.round(ticket.rd),
        },
        network: {
          avgPingMs: Math.round(ticket.avgPingMs),
        },
      });
      continue;
    }

    const penaltyUntil = upsertPenalty(session.accountId, QUEUE_PENALTY_SEC);
    setSessionLobby(session);

    sendPush(session, "S2C_QUEUE_PENALTY_APPLIED", {
      reason: status === "FAILED_DECLINED" ? "DECLINED" : "READY_TIMEOUT",
      penaltyUntilMs: penaltyUntil,
      remainingSec: QUEUE_PENALTY_SEC,
    });
  }

  matchCandidates.delete(candidateId);
}

function makeTeamAssignments(participantSessionIds) {
  const teamA = [];
  const teamB = [];

  for (let i = 0; i < participantSessionIds.length; i += 1) {
    const sessionId = participantSessionIds[i];
    if (i % 2 === 0) {
      teamA.push(sessionId);
    } else {
      teamB.push(sessionId);
    }
  }

  return { teamA, teamB };
}

function createDraftMatch(candidate) {
  const matchId = makeId("m", nextMatchId++);
  const teamAssignments =
    candidate.teamAssignments ?? makeTeamAssignments(candidate.participantSessionIds);

  const match = {
    matchId,
    modeId: candidate.modeId,
    participantSessionIds: [...candidate.participantSessionIds],
    teamA: teamAssignments.teamA,
    teamB: teamAssignments.teamB,
    draftType: "TURN_BAN_PICK",
    turnOrder: ["teamA_ban", "teamB_ban", "teamA_pick", "teamB_pick"],
    timePerTurnSec: DRAFT_TURN_SEC,
    turnSeq: 1,
    turnStartedAt: nowMs(),
    teamState: {
      teamA: { bans: [], picks: [], locked: [] },
      teamB: { bans: [], picks: [], locked: [] },
    },
    draftActionKeys: new Set(),
    resolved: false,
    draftTimeoutHandle: null,
    matchEndHandle: null,
    rematchVotes: new Map(),
    roomAssignRetryBySessionId: new Map(),
    mapId: null,
    quality: candidate.quality ?? null,
  };

  matches.set(matchId, match);

  for (const [index, sessionId] of match.teamA.entries()) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;
    session.activeMatchId = matchId;
    session.activeMatchCandidateId = null;
    setFlowState(session, FLOW_STATES.DRAFT);
    session.teamInfo = { teamId: 1, slot: index + 1 };
  }

  for (const [index, sessionId] of match.teamB.entries()) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;
    session.activeMatchId = matchId;
    session.activeMatchCandidateId = null;
    setFlowState(session, FLOW_STATES.DRAFT);
    session.teamInfo = { teamId: 2, slot: index + 1 };
  }

  broadcastToMatch(match, "S2C_DRAFT_START", {
    matchId,
    modeId: match.modeId,
    draftType: match.draftType,
    turnOrder: match.turnOrder,
    timePerTurnSec: match.timePerTurnSec,
    matchQuality: match.quality,
  });

  broadcastDraftState(match);
  scheduleDraftTurnTimeout(match);
}

function currentTurnToken(match) {
  return match.turnOrder[(match.turnSeq - 1) % match.turnOrder.length] ?? "teamA_pick";
}

function currentTurnTeamKey(match) {
  const token = currentTurnToken(match);
  if (token.startsWith("teamB")) return "teamB";
  return "teamA";
}

function remainingTurnSec(match) {
  const elapsedMs = nowMs() - match.turnStartedAt;
  const remain = Math.ceil(match.timePerTurnSec - elapsedMs / 1000);
  return Math.max(0, remain);
}

function broadcastDraftState(match) {
  broadcastToMatch(match, "S2C_DRAFT_STATE", {
    matchId: match.matchId,
    turnSeq: match.turnSeq,
    remainingSec: remainingTurnSec(match),
    teamA: match.teamState.teamA,
    teamB: match.teamState.teamB,
  });
}

function broadcastToMatch(match, event, payload) {
  for (const sessionId of match.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;
    sendPush(session, event, payload);
  }
}

function scheduleDraftTurnTimeout(match) {
  clearTimeout(match.draftTimeoutHandle);

  match.draftTimeoutHandle = setTimeout(() => {
    handleDraftTimeoutAutopick(match.matchId);
  }, match.timePerTurnSec * 1000);
}

function consumeNextAvailableHero(match) {
  const used = new Set([
    ...match.teamState.teamA.bans,
    ...match.teamState.teamB.bans,
    ...match.teamState.teamA.picks,
    ...match.teamState.teamB.picks,
  ]);

  for (const heroId of HERO_POOL) {
    if (!used.has(heroId)) {
      return heroId;
    }
  }

  return HERO_POOL[0] ?? "iris_wolf";
}

function advanceDraftTurn(match) {
  match.turnSeq += 1;
  match.turnStartedAt = nowMs();

  if (match.turnSeq > match.turnOrder.length) {
    finishDraftAndAssign(match);
    return;
  }

  broadcastDraftState(match);
  scheduleDraftTurnTimeout(match);
}

function handleDraftTimeoutAutopick(matchId) {
  const match = matches.get(matchId);
  if (!match || match.resolved) return;

  const teamKey = currentTurnTeamKey(match);
  const sessionIds = teamKey === "teamA" ? match.teamA : match.teamB;
  const actorSessionId = sessionIds[0] ?? null;
  const actor = actorSessionId ? sessionsBySessionId.get(actorSessionId) : null;

  const pickedHeroId = consumeNextAvailableHero(match);
  match.teamState[teamKey].picks.push(pickedHeroId);

  broadcastToMatch(match, "S2C_DRAFT_TIMEOUT_AUTOPICK", {
    matchId: match.matchId,
    accountId: actor?.accountId ?? "auto",
    pickedHeroId,
    reason: "TURN_TIMEOUT",
  });

  advanceDraftTurn(match);
}

function assignRoomToken(matchId, mapId) {
  const expiresAtMs = nowMs() + ROOM_TOKEN_TTL_SEC * 1000;
  const signature = signRoomToken(matchId, mapId, expiresAtMs);
  return {
    token: `rt1:${matchId}:${mapId}:${expiresAtMs}:${signature}`,
    expiresAtMs,
  };
}

function finishDraftAndAssign(match) {
  clearTimeout(match.draftTimeoutHandle);
  match.resolved = true;

  for (const sessionId of match.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;
    setFlowState(session, FLOW_STATES.MATCH_LOADING);
  }

  const mapId = randomFrom(["NJD_CR_01", "HMY_SZ_01"]) ?? "NJD_CR_01";
  match.mapId = mapId;

  for (const sessionId of match.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;

    const token = assignRoomToken(match.matchId, mapId);
    const teamInfo = session.teamInfo ?? { teamId: 1, slot: 1 };
    const roomEndpoint = resolveRoomEndpointForSession(session);

    sendPush(session, "S2C_MATCH_ASSIGN", {
      matchId: match.matchId,
      room: {
        endpoint: roomEndpoint,
        roomToken: token.token,
        region: ROOM_REGION,
        expiresAtMs: token.expiresAtMs,
      },
      mapId,
      modeId: match.modeId,
      teamInfo,
      matchQuality: match.quality,
      reconnectWindowSec: RECONNECT_WINDOW_SEC,
      roomConnectTimeoutSec: MATCH_ASSIGN_CONNECT_TIMEOUT_SEC,
    });

    // 룸 연결 확인은 클라이언트 C2S_ROOM_CONNECT_RESULT(OK) 수신 시에만 확정한다.
    setFlowState(session, FLOW_STATES.MATCH_LOADING);
  }

  match.matchEndHandle = setTimeout(() => {
    finishMatch(match.matchId);
  }, SIM_MATCH_DURATION_SEC * 1000);
}

function finishMatch(matchId) {
  const match = matches.get(matchId);
  if (!match) return;

  clearTimeout(match.matchEndHandle);

  const scoreA = 10 + Math.floor(Math.random() * 5);
  const scoreB = 8 + Math.floor(Math.random() * 5);

  const teamASessions = match.teamA
    .map((sessionId) => sessionsBySessionId.get(sessionId))
    .filter(Boolean);
  const teamBSessions = match.teamB
    .map((sessionId) => sessionsBySessionId.get(sessionId))
    .filter(Boolean);

  const teamAAvgSr = average(teamASessions.map((session) => session.hiddenSr));
  const teamBAvgSr = average(teamBSessions.map((session) => session.hiddenSr));

  const expectedA = 1 / (1 + 10 ** ((teamBAvgSr - teamAAvgSr) / 400));
  const expectedB = 1 - expectedA;
  const actualA = scoreA >= scoreB ? 1 : 0;
  const actualB = 1 - actualA;

  const baseK = 24;

  for (const sessionId of match.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;

    const team = session.teamInfo?.teamId === 2 ? "B" : "A";
    const result =
      (team === "A" && scoreA >= scoreB) || (team === "B" && scoreB > scoreA)
        ? "WIN"
        : "LOSE";

    const expected = team === "A" ? expectedA : expectedB;
    const actual = team === "A" ? actualA : actualB;
    const rdFactor = clamp((session.hiddenRd ?? 250) / 350, 0.45, 1.0);
    const srDelta = Math.round(baseK * rdFactor * (actual - expected));

    session.hiddenSr = Math.round(clamp((session.hiddenSr ?? 1500) + srDelta, 0, 4000));
    session.hiddenRd = Math.round(clamp((session.hiddenRd ?? 350) * 0.97, 80, 350));
    session.matchesPlayed = (session.matchesPlayed ?? 0) + 1;

    if (session.accountId) {
      const profile = accountProfiles.get(session.accountId);
      if (profile) {
        profile.sr = session.hiddenSr;
        profile.rd = session.hiddenRd;
        profile.matchesPlayed = session.matchesPlayed;
      }
    }

    sendPush(session, "S2C_MATCH_ENDED", {
      matchId,
      result,
      score: { teamA: scoreA, teamB: scoreB },
      mmr: {
        sr: session.hiddenSr,
        rd: session.hiddenRd,
        delta: srDelta,
      },
      rewards: {
        rpDelta: result === "WIN" ? 24 : 8,
        xp: result === "WIN" ? 380 : 210,
        currency: {
          pawCoin: result === "WIN" ? 130 : 80,
        },
      },
    });

    setFlowState(session, FLOW_STATES.RESULT);
  }
}

function allRematchVotesIn(match) {
  for (const sessionId of match.participantSessionIds) {
    if (!match.rematchVotes.has(sessionId)) {
      return false;
    }
  }
  return true;
}

function summarizeRematchVotes(match) {
  const rows = [];
  for (const sessionId of match.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    rows.push({
      accountId: session?.accountId ?? sessionId,
      vote: match.rematchVotes.get(sessionId) ?? null,
    });
  }
  return rows;
}

function handleRematchResolution(match) {
  const votes = [...match.rematchVotes.values()];
  const allAccepted = votes.every((vote) => vote === true);

  if (!allAccepted) {
    broadcastToMatch(match, "S2C_REMATCH_CANCELLED", {
      matchId: match.matchId,
      reason: "VOTE_DECLINED",
    });

    for (const sessionId of match.participantSessionIds) {
      const session = sessionsBySessionId.get(sessionId);
      if (!session) continue;
      setSessionLobby(session);
    }

    matches.delete(match.matchId);
    return;
  }

  broadcastToMatch(match, "S2C_REMATCH_START", {
    matchId: match.matchId,
    modeId: match.modeId,
  });

  // 리매치는 동일 멤버로 새 Ready Check부터 시작.
  const rematchCandidateId = makeId("mc", nextMatchCandidateId++);
  const candidate = {
    matchCandidateId: rematchCandidateId,
    modeId: match.modeId,
    requiredCount: match.participantSessionIds.length,
    participantSessionIds: [...match.participantSessionIds],
    acceptedSessionIds: new Set(),
    declinedSessionIds: new Set(),
    resolved: false,
    createdAt: nowMs(),
    timeoutHandle: null,
    mapPool: ["NJD_CR_01", "HMY_SZ_01"],
    teamAssignments: {
      teamA: [...match.teamA],
      teamB: [...match.teamB],
    },
    quality: match.quality ?? {
      qualityTier: "REMATCH",
      expansionStage: 0,
      maxPingMs: null,
      srRange: null,
      maxTeamSrDiff: null,
      avgSrDiff: null,
      partySymmetryPenalty: 0,
      srStdGap: 0,
      anchorWaitSec: 0,
      extremeWait: false,
    },
    ticketSnapshotBySessionId: Object.create(null),
  };

  matchCandidates.set(rematchCandidateId, candidate);

  for (const sessionId of candidate.participantSessionIds) {
    const session = sessionsBySessionId.get(sessionId);
    if (!session) continue;

    setFlowState(session, FLOW_STATES.READY_CHECK);
    session.activeMatchCandidateId = rematchCandidateId;

    sendPush(session, "S2C_MATCH_FOUND", {
      matchCandidateId: rematchCandidateId,
      modeId: match.modeId,
      acceptDeadlineSec: READY_CHECK_TIMEOUT_SEC,
      mapPool: candidate.mapPool,
    });
  }

  candidate.timeoutHandle = setTimeout(() => {
    resolveReadyCheck(rematchCandidateId, "FAILED_TIMEOUT");
  }, READY_CHECK_TIMEOUT_SEC * 1000);

  matches.delete(match.matchId);
}

function clearSessionQueueAndCandidate(session) {
  if (session.queueTicketId) {
    removeQueueTicket(session.queueTicketId);
    session.queueTicketId = null;
  }

  const candidateId = session.activeMatchCandidateId;
  if (candidateId) {
    const candidate = matchCandidates.get(candidateId);
    if (candidate && !candidate.resolved) {
      candidate.declinedSessionIds.add(session.sessionId);
      resolveReadyCheck(candidateId, "FAILED_DECLINED");
    }
    session.activeMatchCandidateId = null;
  }
}

function handleDisconnect(session) {
  clearSessionQueueAndCandidate(session);
  removeSessionFromParty(session);

  if (session.activeMatchId) {
    const match = matches.get(session.activeMatchId);
    if (match) {
      // 오프라인 알림(남은 멤버에게만)
      for (const sessionId of match.participantSessionIds) {
        if (sessionId === session.sessionId) continue;
        const peer = sessionsBySessionId.get(sessionId);
        if (!peer) continue;
        sendPush(peer, "S2C_RECONNECT_WINDOW", {
          matchId: match.matchId,
          accountId: session.accountId,
          reconnectWindowSec: RECONNECT_WINDOW_SEC,
        });
      }
    }
  }

  sessions.delete(session.ws);
  if (session.sessionId) {
    sessionsBySessionId.delete(session.sessionId);
  }
  if (session.accountId) {
    const mapped = sessionsByAccountId.get(session.accountId);
    if (mapped?.connectionId === session.connectionId) {
      sessionsByAccountId.delete(session.accountId);
    }
  }
}

function validateIncomingEnvelope(raw) {
  const incoming = safeJsonParse(raw);
  if (!incoming || typeof incoming !== "object") {
    return { ok: false, reason: "invalid json" };
  }

  if (typeof incoming.event !== "string") {
    return { ok: false, reason: "missing event" };
  }

  if (typeof incoming.eventId !== "string") {
    return { ok: false, reason: "missing eventId" };
  }

  return { ok: true, incoming };
}

function handleBootReady(ctx) {
  if (!requireFlowState(ctx, FLOW_STATES.BOOT)) return;

  const appVersion = String(ctx.payload?.appVersion ?? "0.0.0");
  if (compareSemver(appVersion, MIN_APP_VERSION) < 0) {
    sendFromRequestContext(ctx, "S2C_FORCE_UPDATE", {
      minVersion: MIN_APP_VERSION,
      storeUrl: STORE_URL,
    });
    return;
  }

  setFlowState(ctx.session, FLOW_STATES.AUTH);

  sendFromRequestContext(ctx, "S2C_BOOT_ACK", {
    minVersion: MIN_APP_VERSION,
    serverTimeMs: nowMs(),
  });
}

function authenticateSession(session, accountId, displayName) {
  session.accountId = accountId;
  session.sessionId = `sess_${hashShort(`${accountId}:${nowMs()}:${Math.random()}`)}`;
  sessionsBySessionId.set(session.sessionId, session);
  sessionsByAccountId.set(accountId, session);

  const skillSeed = deriveInitialSkill(accountId);
  const profile = accountProfiles.get(accountId) ?? {
    displayName,
    onboardingDone: false,
    sr: skillSeed.sr,
    rd: skillSeed.rd,
    matchesPlayed: 0,
  };

  if (!profile.displayName) {
    profile.displayName = displayName;
  }

  if (!Number.isFinite(profile.sr)) {
    profile.sr = skillSeed.sr;
  }

  if (!Number.isFinite(profile.rd)) {
    profile.rd = skillSeed.rd;
  }

  if (!Number.isFinite(profile.matchesPlayed)) {
    profile.matchesPlayed = 0;
  }

  accountProfiles.set(accountId, profile);

  session.hiddenSr = profile.sr;
  session.hiddenRd = profile.rd;
  session.matchesPlayed = profile.matchesPlayed;

  const isFirstUser = !profile.onboardingDone;
  setFlowState(session, isFirstUser ? FLOW_STATES.ONBOARDING : FLOW_STATES.LOBBY);

  return {
    accountId,
    sessionId: session.sessionId,
    isFirstUser,
    displayName: profile.displayName,
    mmr: {
      sr: profile.sr,
      rd: profile.rd,
      matchesPlayed: profile.matchesPlayed,
    },
  };
}

function handleAuthLogin(ctx) {
  if (!requireFlowState(ctx, FLOW_STATES.AUTH)) return;

  const provider = String(ctx.payload?.provider ?? "");
  const idToken = String(ctx.payload?.idToken ?? "");

  if (!provider || !idToken) {
    sendFromRequestContext(ctx, "S2C_AUTH_FAIL", {
      errorCode: ERROR_CODES.AUTH_INVALID_TOKEN,
      message: "provider/idToken required",
    });
    return;
  }

  const accountId = `acc_${hashShort(`${provider}:${idToken}`)}`;
  const displayName = `Player_${accountId.slice(-4)}`;

  const authPayload = authenticateSession(ctx.session, accountId, displayName);
  sendFromRequestContext(ctx, "S2C_AUTH_OK", authPayload);
}

function handleAuthGuest(ctx) {
  if (!requireFlowState(ctx, FLOW_STATES.AUTH)) return;

  const deviceId = String(ctx.payload?.deviceId ?? "").trim();
  const accountId = deviceId
    ? `guest_${hashShort(deviceId)}`
    : `guest_${nextGuestId++}`;
  const displayName = `게스트_${accountId.slice(-4)}`;

  const authPayload = authenticateSession(ctx.session, accountId, displayName);
  sendFromRequestContext(ctx, "S2C_AUTH_OK", authPayload);
}

function handleOnboardingComplete(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, FLOW_STATES.ONBOARDING)) return;

  const nickname = String(ctx.payload?.nickname ?? "").trim();
  if (!nickname) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "nickname required");
    return;
  }

  const profile = accountProfiles.get(ctx.session.accountId) ?? {
    displayName: nickname,
    onboardingDone: false,
  };

  profile.displayName = nickname;
  profile.onboardingDone = true;
  accountProfiles.set(ctx.session.accountId, profile);

  setFlowState(ctx.session, FLOW_STATES.LOBBY);

  sendFromRequestContext(ctx, "S2C_ONBOARDING_SAVED", {
    accountId: ctx.session.accountId,
    nickname,
    tutorialDone: Boolean(ctx.payload?.tutorialDone),
    acceptedTermsVersion: String(ctx.payload?.acceptedTermsVersion ?? ""),
  });
}

function handlePartyCreate(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, FLOW_STATES.LOBBY)) return;

  if (ctx.session.partyId && parties.has(ctx.session.partyId)) {
    const party = parties.get(ctx.session.partyId);
    if (party) {
      broadcastPartyState(party);
    }
    return;
  }

  const partyId = makeId("party", nextPartyId++);
  const party = {
    partyId,
    leaderAccountId: ctx.session.accountId,
    memberAccountIds: [ctx.session.accountId],
    readyByAccount: new Map([[ctx.session.accountId, false]]),
    modeId: String(ctx.payload?.modeId ?? "3v3_normal"),
  };

  parties.set(partyId, party);
  ctx.session.partyId = partyId;

  broadcastPartyState(party);
}

function handlePartyInvite(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!ctx.session.partyId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "No party");
    return;
  }

  const party = parties.get(ctx.session.partyId);
  if (!party) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Party not found");
    return;
  }

  if (party.leaderAccountId !== ctx.session.accountId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Only leader can invite");
    return;
  }

  const targetAccountId = String(ctx.payload?.targetAccountId ?? "");
  const target = sessionsByAccountId.get(targetAccountId);
  if (!target) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Target not online");
    return;
  }

  target.pendingPartyInvites.add(party.partyId);

  sendPush(target, "S2C_PARTY_INVITED", {
    partyId: party.partyId,
    fromAccountId: ctx.session.accountId,
  });

  sendFromRequestContext(ctx, "S2C_PARTY_INVITE_SENT", {
    partyId: party.partyId,
    targetAccountId,
  });
}

function handlePartyAccept(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;

  const partyId = String(ctx.payload?.partyId ?? "");
  const party = parties.get(partyId);
  if (!party) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Party not found");
    return;
  }

  if (!ctx.session.pendingPartyInvites.has(partyId)) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Invite not found");
    return;
  }

  ctx.session.pendingPartyInvites.delete(partyId);

  removeSessionFromParty(ctx.session);

  if (!party.memberAccountIds.includes(ctx.session.accountId)) {
    party.memberAccountIds.push(ctx.session.accountId);
  }
  party.readyByAccount.set(ctx.session.accountId, false);
  ctx.session.partyId = partyId;

  broadcastPartyState(party);
}

function handlePartyLeave(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;

  removeSessionFromParty(ctx.session);
  sendFromRequestContext(ctx, "S2C_PARTY_LEFT", {
    accountId: ctx.session.accountId,
  });
}

function handlePartyKick(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;

  const party = ctx.session.partyId ? parties.get(ctx.session.partyId) : null;
  if (!party) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "No party");
    return;
  }

  if (party.leaderAccountId !== ctx.session.accountId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Only leader can kick");
    return;
  }

  const targetAccountId = String(ctx.payload?.targetAccountId ?? "");
  if (!targetAccountId || targetAccountId === ctx.session.accountId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Invalid target");
    return;
  }

  party.memberAccountIds = party.memberAccountIds.filter((id) => id !== targetAccountId);
  party.readyByAccount.delete(targetAccountId);

  const target = sessionsByAccountId.get(targetAccountId);
  if (target && target.partyId === party.partyId) {
    target.partyId = null;
    sendPush(target, "S2C_PARTY_KICKED", {
      partyId: party.partyId,
    });
  }

  broadcastPartyState(party);
}

function handlePartyReadyToggle(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;

  const party = ctx.session.partyId ? parties.get(ctx.session.partyId) : null;
  if (!party) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "No party");
    return;
  }

  const ready = Boolean(ctx.payload?.ready ?? !party.readyByAccount.get(ctx.session.accountId));
  party.readyByAccount.set(ctx.session.accountId, ready);

  broadcastPartyState(party);
}

function makeDefaultCustomRoomSettings(payload) {
  return {
    modeId: String(payload?.modeId ?? "3v3_normal"),
    teamSize: Number(payload?.teamSize ?? 3),
    allowSpectator: Boolean(payload?.allowSpectator ?? false),
    allowDuplicateHero: Boolean(payload?.allowDuplicateHero ?? false),
    private: Boolean(payload?.private ?? true),
    password: typeof payload?.password === "string" ? payload.password : "",
  };
}

function broadcastCustomRoom(room, event = "S2C_CUSTOM_ROOM_STATE") {
  const payload = {
    customRoomId: room.customRoomId,
    ownerAccountId: room.ownerAccountId,
    members: [...room.memberAccountIds],
    settings: room.settings,
  };

  for (const accountId of room.memberAccountIds) {
    const member = sessionsByAccountId.get(accountId);
    if (!member) continue;
    sendPush(member, event, payload);
  }
}

function handleCustomRoomCreate(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, FLOW_STATES.LOBBY)) return;

  const customRoomId = makeId("cr", nextCustomRoomId++);
  const room = {
    customRoomId,
    ownerAccountId: ctx.session.accountId,
    memberAccountIds: [ctx.session.accountId],
    settings: makeDefaultCustomRoomSettings(ctx.payload),
  };

  customRooms.set(customRoomId, room);
  ctx.session.customRoomId = customRoomId;

  broadcastCustomRoom(room);
}

function handleCustomRoomJoin(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  const customRoomId = String(ctx.payload?.customRoomId ?? "");
  const room = customRooms.get(customRoomId);
  if (!room) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Custom room not found");
    return;
  }

  const providedPassword = String(ctx.payload?.password ?? "");
  if (room.settings.private && room.settings.password && providedPassword !== room.settings.password) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Invalid custom room password");
    return;
  }

  if (!room.memberAccountIds.includes(ctx.session.accountId)) {
    room.memberAccountIds.push(ctx.session.accountId);
  }
  ctx.session.customRoomId = room.customRoomId;
  broadcastCustomRoom(room);
}

function handleCustomRoomUpdateSettings(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;

  const customRoomId = ctx.session.customRoomId;
  if (!customRoomId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "No custom room");
    return;
  }

  const room = customRooms.get(customRoomId);
  if (!room) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Custom room not found");
    return;
  }

  if (room.ownerAccountId !== ctx.session.accountId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Only owner can update settings");
    return;
  }

  room.settings = {
    ...room.settings,
    ...makeDefaultCustomRoomSettings({
      ...room.settings,
      ...ctx.payload,
    }),
  };

  broadcastCustomRoom(room);
}

function handleCustomRoomStart(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;

  const customRoomId = ctx.session.customRoomId;
  if (!customRoomId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "No custom room");
    return;
  }

  const room = customRooms.get(customRoomId);
  if (!room) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Custom room not found");
    return;
  }

  if (room.ownerAccountId !== ctx.session.accountId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "Only owner can start");
    return;
  }

  const modeId = room.settings.modeId;
  const teamSize = modeToTeamSize(modeId);
  const requiredCount = isSoloPracticeMode(modeId)
    ? 1
    : teamSize
      ? teamSize * 2
      : room.memberAccountIds.length;

  if (room.memberAccountIds.length < requiredCount) {
    sendError(
      ctx,
      ERROR_CODES.BAD_REQUEST,
      "Not enough players for mode",
      { requiredCount, currentCount: room.memberAccountIds.length },
    );
    return;
  }

  const participantSessions = room.memberAccountIds
    .map((accountId) => sessionsByAccountId.get(accountId))
    .filter(Boolean)
    .slice(0, requiredCount);

  const participantSessionIds = participantSessions.map((session) => session.sessionId);

  const candidate = {
    matchCandidateId: makeId("mc", nextMatchCandidateId++),
    modeId,
    requiredCount,
    participantSessionIds,
    acceptedSessionIds: new Set(participantSessionIds),
    declinedSessionIds: new Set(),
    resolved: false,
    createdAt: nowMs(),
    timeoutHandle: null,
    mapPool: ["NJD_CR_01", "HMY_SZ_01"],
    teamAssignments: makeTeamAssignments(participantSessionIds),
    quality: {
      qualityTier: "CUSTOM",
      expansionStage: 0,
      maxPingMs: null,
      srRange: null,
      maxTeamSrDiff: null,
      avgSrDiff: null,
      partySymmetryPenalty: 0,
      srStdGap: 0,
      anchorWaitSec: 0,
      extremeWait: false,
    },
    ticketSnapshotBySessionId: Object.create(null),
  };

  matchCandidates.set(candidate.matchCandidateId, candidate);
  resolveReadyCheck(candidate.matchCandidateId, null);
}

function handleQueueJoin(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, [FLOW_STATES.LOBBY, FLOW_STATES.PARTY])) return;

  enqueueSession(ctx.session, ctx.payload, ctx.requestId, ctx.incomingEventId);
}

function handleQueueCancel(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, [FLOW_STATES.QUEUEING, FLOW_STATES.READY_CHECK])) return;

  if (ctx.session.queueTicketId) {
    removeQueueTicket(ctx.session.queueTicketId);
    ctx.session.queueTicketId = null;
  }

  if (ctx.session.activeMatchCandidateId) {
    const candidate = matchCandidates.get(ctx.session.activeMatchCandidateId);
    if (candidate && !candidate.resolved) {
      candidate.declinedSessionIds.add(ctx.session.sessionId);
      resolveReadyCheck(candidate.matchCandidateId, "FAILED_DECLINED");
    }
    ctx.session.activeMatchCandidateId = null;
  }

  setFlowState(ctx.session, FLOW_STATES.LOBBY);

  sendFromRequestContext(ctx, "S2C_QUEUE_CANCELLED", {
    queueTicketId: String(ctx.payload?.queueTicketId ?? ""),
    reason: String(ctx.payload?.reason ?? "user_cancel"),
  });
}

function handleMatchAccept(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, FLOW_STATES.READY_CHECK)) return;

  const candidateId = String(ctx.payload?.matchCandidateId ?? "");
  const accept = Boolean(ctx.payload?.accept);
  const candidate = matchCandidates.get(candidateId);

  if (!candidate || candidate.resolved) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "match candidate not found");
    return;
  }

  if (ctx.session.activeMatchCandidateId !== candidateId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "match candidate mismatch");
    return;
  }

  if (candidate.acceptedSessionIds.has(ctx.session.sessionId)) {
    sendFromRequestContext(ctx, "S2C_MATCH_ACCEPT_ACK", {
      matchCandidateId: candidateId,
      accepted: true,
      dedup: true,
    });
    return;
  }

  if (candidate.declinedSessionIds.has(ctx.session.sessionId)) {
    sendFromRequestContext(ctx, "S2C_MATCH_ACCEPT_ACK", {
      matchCandidateId: candidateId,
      accepted: false,
      dedup: true,
    });
    return;
  }

  if (accept) {
    candidate.acceptedSessionIds.add(ctx.session.sessionId);
  } else {
    candidate.declinedSessionIds.add(ctx.session.sessionId);
  }

  sendFromRequestContext(ctx, "S2C_MATCH_ACCEPT_ACK", {
    matchCandidateId: candidateId,
    accepted: accept,
  });

  if (!accept) {
    resolveReadyCheck(candidateId, "FAILED_DECLINED");
    return;
  }

  if (candidate.acceptedSessionIds.size >= candidate.requiredCount) {
    resolveReadyCheck(candidateId, null);
  }
}

function handleDraftAction(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, FLOW_STATES.DRAFT)) return;

  const matchId = String(ctx.payload?.matchId ?? "");
  const actionType = String(ctx.payload?.actionType ?? "").toUpperCase();
  const heroId = String(ctx.payload?.heroId ?? "");
  const turnSeq = Number(ctx.payload?.turnSeq ?? NaN);

  const match = matches.get(matchId);
  if (!match) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "match not found");
    return;
  }

  if (ctx.session.activeMatchId !== matchId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "active match mismatch");
    return;
  }

  if (turnSeq !== match.turnSeq) {
    sendError(
      ctx,
      ERROR_CODES.DRAFT_INVALID_TURN,
      `turn mismatch (expected=${match.turnSeq}, got=${turnSeq})`,
    );
    return;
  }

  const actionKey = `${matchId}:${turnSeq}:${ctx.session.accountId}`;
  if (match.draftActionKeys.has(actionKey)) {
    sendFromRequestContext(ctx, "S2C_DRAFT_ACTION_ACK", {
      matchId,
      turnSeq,
      dedup: true,
    });
    broadcastDraftState(match);
    return;
  }

  const expectedTeamKey = currentTurnTeamKey(match);
  const actorTeamKey = ctx.session.teamInfo?.teamId === 2 ? "teamB" : "teamA";
  if (actorTeamKey !== expectedTeamKey) {
    sendError(
      ctx,
      ERROR_CODES.DRAFT_INVALID_TURN,
      `Not your team turn (${expectedTeamKey})`,
    );
    return;
  }

  const teamState = match.teamState[expectedTeamKey];

  if (actionType === "HOVER") {
    sendFromRequestContext(ctx, "S2C_DRAFT_ACTION_ACK", {
      matchId,
      turnSeq,
      actionType,
      heroId,
    });
    return;
  }

  if (!["BAN", "PICK", "LOCK"].includes(actionType)) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, `Unsupported actionType=${actionType}`);
    return;
  }

  if (actionType !== "LOCK") {
    if (!heroId) {
      sendError(ctx, ERROR_CODES.BAD_REQUEST, "heroId required");
      return;
    }

    const usedHeroes = new Set([
      ...match.teamState.teamA.bans,
      ...match.teamState.teamB.bans,
      ...match.teamState.teamA.picks,
      ...match.teamState.teamB.picks,
    ]);

    if (usedHeroes.has(heroId)) {
      sendError(
        ctx,
        ERROR_CODES.DRAFT_HERO_UNAVAILABLE,
        `hero unavailable: ${heroId}`,
      );
      return;
    }

    if (actionType === "BAN") {
      teamState.bans.push(heroId);
    } else if (actionType === "PICK") {
      teamState.picks.push(heroId);
    }
  } else {
    if (!teamState.locked.includes(ctx.session.accountId)) {
      teamState.locked.push(ctx.session.accountId);
    }
  }

  match.draftActionKeys.add(actionKey);

  sendFromRequestContext(ctx, "S2C_DRAFT_ACTION_ACK", {
    matchId,
    turnSeq,
    actionType,
    heroId: heroId || null,
  });

  advanceDraftTurn(match);
}

function handleRoomConnectResult(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, [FLOW_STATES.MATCH_LOADING, FLOW_STATES.IN_MATCH])) return;

  const matchId = String(ctx.payload?.matchId ?? "");
  const status = String(ctx.payload?.status ?? "").toUpperCase();
  const match = matches.get(matchId);

  console.log(
    `[gateway][room.connect.result] account=${ctx.session.accountId} session=${ctx.session.sessionId} match=${matchId} status=${status} flow=${ctx.session.flowState}`,
  );

  if (!match) {
    sendError(ctx, ERROR_CODES.MATCH_ASSIGN_EXPIRED, "match assign expired");
    return;
  }

  if (ctx.session.activeMatchId !== matchId) {
    sendError(ctx, ERROR_CODES.MATCH_ASSIGN_EXPIRED, "active match mismatch");
    return;
  }

  if (status === "OK") {
    setFlowState(ctx.session, FLOW_STATES.IN_MATCH);
    sendFromRequestContext(ctx, "S2C_ROOM_CONNECT_CONFIRMED", {
      matchId,
      status: "OK",
      source: "CLIENT_REPORT",
    });
    return;
  }

  if (status !== "FAIL") {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "status must be OK or FAIL");
    return;
  }

  const previousRetry = match.roomAssignRetryBySessionId.get(ctx.session.sessionId) ?? 0;
  const nextRetry = previousRetry + 1;
  match.roomAssignRetryBySessionId.set(ctx.session.sessionId, nextRetry);

  if (nextRetry <= 1) {
    const token = assignRoomToken(matchId, match.mapId ?? "NJD_CR_01");
    const roomEndpoint = resolveRoomEndpointForSession(ctx.session);
    sendFromRequestContext(ctx, "S2C_MATCH_ASSIGN_RETRY", {
      matchId,
      retryCount: nextRetry,
      room: {
        endpoint: roomEndpoint,
        roomToken: token.token,
        region: ROOM_REGION,
        expiresAtMs: token.expiresAtMs,
      },
    });
    return;
  }

  sendFromRequestContext(ctx, "S2C_QUEUE_RECOVERY", {
    matchId,
    reason: ERROR_CODES.ROOM_CONNECT_FAIL,
  });

  sendError(ctx, ERROR_CODES.ROOM_CONNECT_FAIL, "room connect failed twice");

  setSessionLobby(ctx.session);
}

function handleRematchVote(ctx) {
  if (!requireAuth(ctx) || !checkSessionId(ctx)) return;
  if (!requireFlowState(ctx, FLOW_STATES.RESULT)) return;

  const matchId = String(ctx.payload?.matchId ?? "");
  const vote = Boolean(ctx.payload?.vote ?? true);

  const match = matches.get(matchId);
  if (!match) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "match not found");
    return;
  }

  if (ctx.session.activeMatchId !== matchId) {
    sendError(ctx, ERROR_CODES.BAD_REQUEST, "active match mismatch");
    return;
  }

  match.rematchVotes.set(ctx.session.sessionId, vote);

  const rematchStatePayload = {
    matchId,
    votes: summarizeRematchVotes(match),
    requiredCount: match.participantSessionIds.length,
  };

  broadcastToMatch(match, "S2C_REMATCH_STATE", rematchStatePayload);

  if (allRematchVotesIn(match)) {
    handleRematchResolution(match);
  }
}

function handlePing(ctx) {
  if (!checkSessionId(ctx)) return;

  const now = nowMs();
  const reportedPingMs = Number(ctx.payload?.pingMs ?? ctx.payload?.rttMs ?? NaN);
  const clientTimeMs = Number(ctx.payload?.clientTimeMs ?? ctx.payload?.clientTime ?? NaN);

  if (Number.isFinite(reportedPingMs) && reportedPingMs > 0) {
    ctx.session.lastKnownPingMs = clamp(reportedPingMs, 20, 500);
  } else if (Number.isFinite(clientTimeMs) && clientTimeMs > 0 && clientTimeMs <= now) {
    const approximateHalfRtt = (now - clientTimeMs) * 0.5;
    ctx.session.lastKnownPingMs = clamp(approximateHalfRtt, 20, 500);
  }

  sendFromRequestContext(ctx, "S2C_PONG", {
    nowMs: now,
    state: ctx.session.flowState,
    network: {
      serverSeenPingMs: Math.round(ctx.session.lastKnownPingMs),
    },
  });
}

function dispatchIncoming(ctx) {
  switch (ctx.event) {
    case CONTROL_EVENTS.C2S_BOOT_READY:
      return handleBootReady(ctx);

    case CONTROL_EVENTS.C2S_AUTH_LOGIN:
      return handleAuthLogin(ctx);

    case CONTROL_EVENTS.C2S_AUTH_GUEST:
      return handleAuthGuest(ctx);

    case CONTROL_EVENTS.C2S_ONBOARDING_COMPLETE:
      return handleOnboardingComplete(ctx);

    case CONTROL_EVENTS.C2S_PARTY_CREATE:
      return handlePartyCreate(ctx);
    case CONTROL_EVENTS.C2S_PARTY_INVITE:
      return handlePartyInvite(ctx);
    case CONTROL_EVENTS.C2S_PARTY_ACCEPT:
      return handlePartyAccept(ctx);
    case CONTROL_EVENTS.C2S_PARTY_LEAVE:
      return handlePartyLeave(ctx);
    case CONTROL_EVENTS.C2S_PARTY_KICK:
      return handlePartyKick(ctx);
    case CONTROL_EVENTS.C2S_PARTY_READY_TOGGLE:
      return handlePartyReadyToggle(ctx);

    case CONTROL_EVENTS.C2S_CUSTOM_ROOM_CREATE:
      return handleCustomRoomCreate(ctx);
    case CONTROL_EVENTS.C2S_CUSTOM_ROOM_JOIN:
      return handleCustomRoomJoin(ctx);
    case CONTROL_EVENTS.C2S_CUSTOM_ROOM_START:
      return handleCustomRoomStart(ctx);
    case CONTROL_EVENTS.C2S_CUSTOM_ROOM_UPDATE_SETTINGS:
      return handleCustomRoomUpdateSettings(ctx);

    case CONTROL_EVENTS.C2S_QUEUE_JOIN:
      return handleQueueJoin(ctx);
    case CONTROL_EVENTS.C2S_QUEUE_CANCEL:
      return handleQueueCancel(ctx);

    case CONTROL_EVENTS.C2S_MATCH_ACCEPT:
      return handleMatchAccept(ctx);
    case CONTROL_EVENTS.C2S_DRAFT_ACTION:
      return handleDraftAction(ctx);

    case CONTROL_EVENTS.C2S_ROOM_CONNECT_RESULT:
      return handleRoomConnectResult(ctx);

    case CONTROL_EVENTS.C2S_REMATCH_VOTE:
      return handleRematchVote(ctx);

    case CONTROL_EVENTS.C2S_PING:
      return handlePing(ctx);

    default:
      sendError(ctx, ERROR_CODES.UNSUPPORTED_EVENT, `Unsupported event: ${ctx.event}`);
  }
}

function replayCachedResponses(session, eventId) {
  const cached = session.responseCache.get(eventId);
  if (!cached || cached.length === 0) return false;

  for (const envelope of cached) {
    sendRaw(session, envelope);
  }

  return true;
}

const wss = new WebSocketServer({ host: "0.0.0.0", port: CONTROL_PORT });

wss.on("connection", (ws, req) => {
  const connectionId = `conn_${nextConnectionId++}`;
  /** @type {Session} */
  const session = {
    ws,
    connectionId,
    connectedAtMs: nowMs(),
    flowState: FLOW_STATES.BOOT,
    sessionId: null,
    accountId: null,
    displayName: null,
    controlHost: typeof req.headers?.host === "string" ? req.headers.host : null,
    hiddenSr: 1500,
    hiddenRd: 350,
    matchesPlayed: 0,
    lastKnownPingMs: 80,

    partyId: null,
    customRoomId: null,
    queueTicketId: null,
    activeMatchCandidateId: null,
    activeMatchId: null,
    teamInfo: null,

    pendingPartyInvites: new Set(),

    responseCache: new Map(),
    responseCacheOrder: [],
  };

  sessions.set(ws, session);

  sendPush(session, "S2C_HELLO", {
    connectionId,
    state: session.flowState,
    serverTimeMs: nowMs(),
  });

  ws.on("message", (rawBuffer) => {
    const raw = typeof rawBuffer === "string" ? rawBuffer : rawBuffer.toString("utf8");
    const parsed = validateIncomingEnvelope(raw);

    if (!parsed.ok) {
      sendErrorPush(session, ERROR_CODES.BAD_REQUEST, `Malformed envelope: ${parsed.reason}`);
      return;
    }

    const incoming = parsed.incoming;
    if (replayCachedResponses(session, incoming.eventId)) {
      return;
    }

    /** @type {RequestContext} */
    const ctx = {
      session,
      incoming,
      incomingEventId: incoming.eventId,
      requestId: typeof incoming.requestId === "string" ? incoming.requestId : null,
      event: incoming.event,
      payload: incoming.payload ?? {},
    };

    dispatchIncoming(ctx);
  });

  ws.on("close", () => {
    handleDisconnect(session);
  });

  ws.on("error", () => {
    handleDisconnect(session);
  });

  const remote = req.socket?.remoteAddress ? `${req.socket.remoteAddress}:${req.socket.remotePort}` : "unknown";
  console.log(`[gateway] connected ${connectionId} remote=${remote}`);
});

wss.on("listening", () => {
  console.log(
    `[gateway] control server listening on 0.0.0.0:${CONTROL_PORT} minVersion=${MIN_APP_VERSION} roomEndpoint=${ROOM_ENDPOINT}`,
  );
});

wss.on("close", () => {
  console.log("[gateway] control server closed");
});

/**
 * @typedef {object} Session
 * @property {import('ws').WebSocket} ws
 * @property {string} connectionId
 * @property {number} connectedAtMs
 * @property {string} flowState
 * @property {string | null} sessionId
 * @property {string | null} accountId
 * @property {string | null} displayName
 * @property {string | null} controlHost
 * @property {number} hiddenSr
 * @property {number} hiddenRd
 * @property {number} matchesPlayed
 * @property {number} lastKnownPingMs
 * @property {string | null} partyId
 * @property {string | null} customRoomId
 * @property {string | null} queueTicketId
 * @property {string | null} activeMatchCandidateId
 * @property {string | null} activeMatchId
 * @property {{teamId:number, slot:number} | null} teamInfo
 * @property {Set<string>} pendingPartyInvites
 * @property {Map<string, any[]>} responseCache
 * @property {string[]} responseCacheOrder
 */

/**
 * @typedef {object} RequestContext
 * @property {Session} session
 * @property {any} incoming
 * @property {string} incomingEventId
 * @property {string | null} requestId
 * @property {string} event
 * @property {any} payload
 */

/**
 * @typedef {object} Party
 * @property {string} partyId
 * @property {string} leaderAccountId
 * @property {string[]} memberAccountIds
 * @property {Map<string, boolean>} readyByAccount
 * @property {string} modeId
 */

/**
 * @typedef {object} CustomRoom
 * @property {string} customRoomId
 * @property {string} ownerAccountId
 * @property {string[]} memberAccountIds
 * @property {any} settings
 */

/**
 * @typedef {object} QueueTicket
 * @property {string} queueTicketId
 * @property {string} modeId
 * @property {number} teamSize
 * @property {number} requiredCount
 * @property {string} accountId
 * @property {string} sessionId
 * @property {string | null} partyId
 * @property {string} regionPreference
 * @property {string} inputDevice
 * @property {number} sr
 * @property {number} rd
 * @property {number} avgPingMs
 * @property {number} joinedAt
 */

/**
 * @typedef {object} MatchCandidate
 * @property {string} matchCandidateId
 * @property {string} modeId
 * @property {number} requiredCount
 * @property {string[]} participantSessionIds
 * @property {Set<string>} acceptedSessionIds
 * @property {Set<string>} declinedSessionIds
 * @property {boolean} resolved
 * @property {number} createdAt
 * @property {NodeJS.Timeout | null} timeoutHandle
 * @property {string[]} mapPool
 * @property {{teamA: string[], teamB: string[]} | null} teamAssignments
 * @property {any | null} quality
 * @property {Record<string, {partyId: string | null, regionPreference: string, inputDevice: string, sr: number, rd: number, avgPingMs: number}>} ticketSnapshotBySessionId
 */

/**
 * @typedef {object} MatchState
 * @property {string} matchId
 * @property {string} modeId
 * @property {string[]} participantSessionIds
 * @property {string[]} teamA
 * @property {string[]} teamB
 * @property {string} draftType
 * @property {string[]} turnOrder
 * @property {number} timePerTurnSec
 * @property {number} turnSeq
 * @property {number} turnStartedAt
 * @property {{teamA: {bans: string[], picks: string[], locked: string[]}, teamB: {bans: string[], picks: string[], locked: string[]}}} teamState
 * @property {Set<string>} draftActionKeys
 * @property {boolean} resolved
 * @property {NodeJS.Timeout | null} draftTimeoutHandle
 * @property {NodeJS.Timeout | null} matchEndHandle
 * @property {Map<string, boolean>} rematchVotes
 * @property {Map<string, number>} roomAssignRetryBySessionId
 * @property {string | null} mapId
 * @property {any | null} quality
 */
