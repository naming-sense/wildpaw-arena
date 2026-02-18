import crypto from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const URL = process.env.GATEWAY_URL ?? "ws://127.0.0.1:7200";
const CLIENTS = Number(process.env.SMOKE_CLIENTS ?? 6);
const MODE_ID = process.env.SMOKE_MODE_ID ?? "3v3_rank";

function nowMs() {
  return Date.now();
}

function makeEvent(event, sessionId, payload, requestId = null) {
  return {
    event,
    eventId: crypto.randomUUID(),
    requestId: requestId ?? crypto.randomUUID(),
    sessionId,
    ts: nowMs(),
    payload,
  };
}

class GatewayClient {
  constructor(index) {
    this.index = index;
    this.ws = null;
    this.sessionId = null;
    this.accountId = null;
    this.teamInfo = null;
    this.turnOrder = [];
    this.closed = false;
    this.events = [];
    this.matchAssign = null;
    this.matchFound = null;
    this.matchId = null;
  }

  async connect() {
    this.ws = new WebSocket(URL);

    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });

    this.ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      this.events.push(msg);

      if (msg.event === "S2C_AUTH_OK") {
        this.sessionId = msg.payload.sessionId;
        this.accountId = msg.payload.accountId;
      }

      if (msg.event === "S2C_MATCH_FOUND") {
        this.matchFound = msg.payload;
      }

      if (msg.event === "S2C_DRAFT_START") {
        this.turnOrder = msg.payload.turnOrder ?? [];
        this.matchId = msg.payload.matchId;
      }

      if (msg.event === "S2C_MATCH_ASSIGN") {
        this.matchAssign = msg.payload;
        this.matchId = msg.payload.matchId;
        this.teamInfo = msg.payload.teamInfo;
      }
    });

    this.ws.on("close", () => {
      this.closed = true;
    });

    await this.send("C2S_BOOT_READY", {
      appVersion: "0.2.1",
      platform: "web",
      locale: "ko-KR",
      regionCandidates: ["KR"],
    }, null);

    await delay(30);

    await this.send("C2S_AUTH_GUEST", {
      deviceId: `smoke_device_${this.index}`,
    }, null);

    await this.waitFor((msg) => msg.event === "S2C_AUTH_OK", 1200);

    const authOk = this.findLast("S2C_AUTH_OK");
    if (authOk?.payload?.isFirstUser) {
      await this.send("C2S_ONBOARDING_COMPLETE", {
        nickname: `smoke_${this.index}`,
        tutorialDone: true,
        starterHeroIds: ["iris_wolf"],
        acceptedTermsVersion: "2026-02",
      });
      await this.waitFor((msg) => msg.event === "S2C_ONBOARDING_SAVED", 1200);
    }
  }

  findLast(event) {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      if (this.events[i]?.event === event) {
        return this.events[i];
      }
    }
    return null;
  }

  async send(event, payload, requestId = null) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      throw new Error(`client ${this.index} ws not open`);
    }

    const packet = makeEvent(event, this.sessionId, payload, requestId);
    this.ws.send(JSON.stringify(packet));
    return packet;
  }

  waitFor(predicate, timeoutMs = 1500) {
    const startedAt = nowMs();

    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const found = this.events.find(predicate);
        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }

        if (nowMs() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`client ${this.index} wait timeout`));
        }
      }, 20);
    });
  }

  async close() {
    if (!this.ws) return;
    this.ws.close();
    await delay(20);
  }
}

function heroesForTurn(turnIndex) {
  const picks = ["iris_wolf", "milky_rabbit", "rockhorn_rhino", "lumifox"];
  return picks[turnIndex % picks.length];
}

async function run() {
  const clients = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    const client = new GatewayClient(i + 1);
    await client.connect();
    clients.push(client);
  }

  for (const client of clients) {
    await client.send("C2S_QUEUE_JOIN", {
      modeId: MODE_ID,
      regionPreference: "KR",
      partyId: null,
      inputDevice: "kbm",
    });
  }

  await Promise.all(
    clients.map((client) => client.waitFor((msg) => msg.event === "S2C_MATCH_FOUND", 3000)),
  );

  for (const client of clients) {
    await client.send("C2S_MATCH_ACCEPT", {
      matchCandidateId: client.matchFound.matchCandidateId,
      accept: true,
    });
  }

  await Promise.all(
    clients.map((client) =>
      client.waitFor((msg) => msg.event === "S2C_DRAFT_START", 4000),
    ),
  );

  const actors = new Map();
  for (const client of clients) {
    const teamId = client.teamInfo?.teamId;
    if (!teamId && client.matchAssign?.teamInfo?.teamId) {
      // no-op
    }
    if (!actors.has("teamA") || !actors.has("teamB")) {
      // teamInfo는 match assign 이후 채워짐. draft 중에는 세션 이벤트에서 teamInfo가 없으므로 임시로 index parity 사용.
    }
  }

  // Draft action은 팀별 첫 클라이언트를 고정 actor로 사용한다.
  const teamAActor = clients[0];
  const teamBActor = clients[1] ?? clients[0];

  const draftStart = clients[0].findLast("S2C_DRAFT_START");
  const turnOrder = draftStart?.payload?.turnOrder ?? [
    "teamA_ban",
    "teamB_ban",
    "teamA_pick",
    "teamB_pick",
  ];

  for (let i = 0; i < turnOrder.length; i += 1) {
    const turnSeq = i + 1;
    const turnToken = turnOrder[i];
    const actionType = turnToken.includes("ban") ? "BAN" : "PICK";
    const actor = turnToken.startsWith("teamB") ? teamBActor : teamAActor;

    await actor.send("C2S_DRAFT_ACTION", {
      matchId: draftStart.payload.matchId,
      actionType,
      heroId: heroesForTurn(i),
      turnSeq,
    });

    await delay(60);
  }

  await Promise.all(
    clients.map((client) =>
      client.waitFor((msg) => msg.event === "S2C_MATCH_ASSIGN", 4000),
    ),
  );

  for (const client of clients) {
    await client.send("C2S_ROOM_CONNECT_RESULT", {
      matchId: client.matchAssign.matchId,
      status: "OK",
    });
  }

  const summary = {
    url: URL,
    clients: CLIENTS,
    modeId: MODE_ID,
    authOkCount: clients.filter((client) => client.findLast("S2C_AUTH_OK")).length,
    queueJoinedCount: clients.filter((client) => client.findLast("S2C_QUEUE_JOINED")).length,
    matchFoundCount: clients.filter((client) => client.findLast("S2C_MATCH_FOUND")).length,
    draftStartCount: clients.filter((client) => client.findLast("S2C_DRAFT_START")).length,
    matchAssignCount: clients.filter((client) => client.findLast("S2C_MATCH_ASSIGN")).length,
    teamInfo: clients.map((client) => client.matchAssign?.teamInfo ?? null),
    errors: clients.map((client) => client.events.filter((e) => e.event === "S2C_ERROR")).flat(),
  };

  console.log(JSON.stringify(summary, null, 2));

  for (const client of clients) {
    await client.close();
  }
}

run().catch((error) => {
  console.error("[smoke] failed", error);
  process.exitCode = 1;
});
