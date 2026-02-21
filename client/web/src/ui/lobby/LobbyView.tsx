import { useEffect, useRef, useState } from "react";
import { ControlFlowClient } from "../../flow/controlFlowClient";
import { useUiStore, type AppFlowState } from "../store/useUiStore";

const FALLBACK_DEVICE_ID_PREFIX = "wildpaw-web-device";

const DRAFT_HERO_OPTIONS = [
  "iris_wolf",
  "milky_rabbit",
  "rockhorn_rhino",
  "lumifox",
  "coral_cat",
  "mint_ferret",
];

function resolveDefaultGatewayUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:7200`;
}

function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") {
    return `${FALLBACK_DEVICE_ID_PREFIX}-${Date.now()}`;
  }

  const key = "wildpaw-control-device-id";
  const fallback = `${FALLBACK_DEVICE_ID_PREFIX}-${Date.now()}`;

  try {
    const existing = window.localStorage.getItem(key);
    if (existing && existing.length > 0) {
      return existing;
    }

    const created =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : fallback;

    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return fallback;
  }
}

function isPreMatchState(state: AppFlowState): boolean {
  return (
    state === "BOOT" ||
    state === "AUTH" ||
    state === "ONBOARDING" ||
    state === "LOBBY" ||
    state === "PARTY" ||
    state === "QUEUEING" ||
    state === "READY_CHECK" ||
    state === "DRAFT" ||
    state === "MATCH_LOADING" ||
    state === "RECONNECTING" ||
    state === "RESULT"
  );
}

export function LobbyView(): JSX.Element | null {
  const [nickname, setNickname] = useState("SenseNaming");
  const [modeId, setModeId] = useState("3v3_rank");
  const [draftHeroId, setDraftHeroId] = useState(DRAFT_HERO_OPTIONS[0] ?? "iris_wolf");

  const clientRef = useRef<ControlFlowClient | null>(null);

  const appFlowState = useUiStore((state) => state.appFlowState);
  const controlConnectionState = useUiStore((state) => state.controlConnectionState);
  const controlEndpoint = useUiStore((state) => state.controlEndpoint);
  const sessionId = useUiStore((state) => state.sessionId);
  const accountId = useUiStore((state) => state.accountId);
  const queueTicketId = useUiStore((state) => state.queueTicketId);
  const matchCandidateId = useUiStore((state) => state.matchCandidateId);
  const matchId = useUiStore((state) => state.matchId);
  const draftTurnSeq = useUiStore((state) => state.draftTurnSeq);
  const draftRemainingSec = useUiStore((state) => state.draftRemainingSec);
  const teamId = useUiStore((state) => state.teamId);
  const teamSlot = useUiStore((state) => state.teamSlot);
  const roomEndpoint = useUiStore((state) => state.roomEndpoint);
  const roomToken = useUiStore((state) => state.roomToken);
  const flowEventHint = useUiStore((state) => state.flowEventHint);
  const lastFlowError = useUiStore((state) => state.lastFlowError);
  const flowLogs = useUiStore((state) => state.flowLogs);

  const setFlow = useUiStore((state) => state.setFlow);
  const pushFlowLog = useUiStore((state) => state.pushFlowLog);
  const clearFlowLogs = useUiStore((state) => state.clearFlowLogs);

  useEffect(() => {
    const endpoint = import.meta.env.VITE_GATEWAY_WS_URL ?? resolveDefaultGatewayUrl();
    setFlow({
      controlEndpoint: endpoint ?? "",
      flowEventHint: "Gateway 연결 대기",
    });

    const client = new ControlFlowClient({
      url: endpoint,
      reconnectMinMs: 600,
      reconnectMaxMs: 4000,
      onConnectionState: (next) => {
        setFlow({ controlConnectionState: next });
        pushFlowLog(`control connection => ${next}`);
      },
      onFlowState: (nextState) => {
        setFlow({ appFlowState: nextState });
      },
      onSessionResolved: (nextSessionId, nextAccountId) => {
        setFlow({
          sessionId: nextSessionId,
          accountId: nextAccountId,
        });

        pushFlowLog(`auth ok account=${nextAccountId ?? "-"}`);
      },
      onQueueJoined: (nextQueueTicketId, nextModeId) => {
        setFlow({
          queueTicketId: nextQueueTicketId,
          modeId: nextModeId,
          flowEventHint: `queue joined (${nextModeId})`,
        });
        pushFlowLog(`queue joined ticket=${nextQueueTicketId}`);
      },
      onQueueCancelled: () => {
        setFlow({
          queueTicketId: null,
          matchCandidateId: null,
          flowEventHint: "queue cancelled",
        });
        pushFlowLog("queue cancelled");
      },
      onQueueStatus: (payload) => {
        const p = payload as { elapsedSec?: unknown; estimatedWaitSec?: unknown };
        const elapsed = typeof p.elapsedSec === "number" ? p.elapsedSec : 0;
        const estimate =
          typeof p.estimatedWaitSec === "number" ? p.estimatedWaitSec : 0;
        setFlow({
          flowEventHint: `queue: elapsed=${elapsed}s estimate=${estimate}s`,
        });
      },
      onMatchFound: (payload) => {
        setFlow({
          matchCandidateId: payload.matchCandidateId,
          modeId: payload.modeId,
          flowEventHint: `match found (${payload.acceptDeadlineSec}s)`,
        });
        pushFlowLog(`match found id=${payload.matchCandidateId}`);
      },
      onReadyCheckResult: (payload) => {
        const p = payload as { status?: unknown };
        const status = typeof p.status === "string" ? p.status : "UNKNOWN";
        setFlow({ flowEventHint: `ready-check: ${status}` });
        pushFlowLog(`ready-check result=${status}`);
      },
      onDraftStart: (payload) => {
        const p = payload as { matchId?: unknown; timePerTurnSec?: unknown };
        const nextMatchId = typeof p.matchId === "string" ? p.matchId : null;
        const timePerTurnSec =
          typeof p.timePerTurnSec === "number" ? p.timePerTurnSec : null;

        setFlow({
          matchId: nextMatchId,
          draftTurnSeq: 1,
          draftRemainingSec: timePerTurnSec,
          flowEventHint: `draft start match=${nextMatchId ?? "-"}`,
        });

        pushFlowLog(`draft start match=${nextMatchId ?? "-"}`);
      },
      onDraftState: (payload) => {
        setFlow({
          matchId: payload.matchId,
          draftTurnSeq: payload.turnSeq,
          draftRemainingSec: payload.remainingSec,
          flowEventHint: `draft turn=${payload.turnSeq} remain=${payload.remainingSec}s`,
        });
      },
      onMatchAssign: (payload) => {
        setFlow({
          matchId: payload.matchId,
          modeId: payload.modeId,
          teamId: payload.teamInfo.teamId,
          teamSlot: payload.teamInfo.slot,
          roomEndpoint: payload.room.endpoint,
          roomToken: payload.room.roomToken,
          flowEventHint: `match assign team=${payload.teamInfo.teamId}-${payload.teamInfo.slot}`,
        });

        pushFlowLog(`match assigned room=${payload.room.endpoint}`);
      },
      onMatchEnded: (payload) => {
        const p = payload as { result?: unknown; score?: unknown };
        const result = typeof p.result === "string" ? p.result : "-";
        setFlow({ flowEventHint: `match ended result=${result}` });
        pushFlowLog(`match ended result=${result}`);
      },
      onRematchState: (payload) => {
        const p = payload as { votes?: unknown };
        const votesLen = Array.isArray(p.votes) ? p.votes.length : 0;
        setFlow({ flowEventHint: `rematch votes=${votesLen}` });
      },
      onError: (payload) => {
        const code =
          typeof payload.errorCode === "string" ? payload.errorCode : "UNKNOWN_ERROR";
        const message =
          typeof payload.message === "string" ? payload.message : "Unknown error";

        setFlow({
          lastFlowError: {
            code,
            message,
            details: payload.details,
            atMs: Date.now(),
          },
          flowEventHint: `error: ${code}`,
        });

        pushFlowLog(`error ${code}: ${message}`);
      },
      onEvent: (event) => {
        if (event !== "S2C_QUEUE_STATUS") {
          setFlow({ flowEventHint: event });
        }
      },
    });

    clientRef.current = client;
    client.connect();

    const pingInterval = window.setInterval(() => {
      client.sendPing();
    }, 5000);

    return () => {
      window.clearInterval(pingInterval);
      client.disconnect();
      clientRef.current = null;
    };
  }, [pushFlowLog, setFlow]);

  if (!isPreMatchState(appFlowState)) {
    return null;
  }

  const controlReady = controlConnectionState === "Connected";

  const run = (action: (client: ControlFlowClient) => boolean | void, label: string): void => {
    const client = clientRef.current;
    if (!client) {
      pushFlowLog(`${label}: client unavailable`);
      return;
    }

    const result = action(client);
    if (result === false) {
      pushFlowLog(`${label}: send failed`);
    }
  };

  return (
    <div className="overlay-panel flow-panel">
      <h3>FLOW CONTROL</h3>
      <p>state: <strong>{appFlowState}</strong></p>
      <p>control: {controlConnectionState}</p>
      <p>endpoint: {controlEndpoint || "(none)"}</p>
      <p>session/account: {sessionId ?? "-"} / {accountId ?? "-"}</p>
      <p>queueTicket: {queueTicketId ?? "-"}</p>
      <p>candidate/match: {matchCandidateId ?? "-"} / {matchId ?? "-"}</p>
      <p>draft: turn={draftTurnSeq ?? "-"}, remain={draftRemainingSec ?? "-"}s</p>
      <p>team: {teamId ?? "-"}-{teamSlot ?? "-"}</p>
      <p>room: {roomEndpoint ?? "-"}</p>
      <p className="flow-hint">hint: {flowEventHint || "-"}</p>

      {lastFlowError ? (
        <p className="flow-error">
          error: {lastFlowError.code} / {lastFlowError.message}
        </p>
      ) : null}

      <div className="flow-controls">
        <button
          type="button"
          onClick={() => run((client) => {
            client.connect();
            return true;
          }, "connect")}
        >
          Connect
        </button>

        <button
          type="button"
          disabled={!controlReady}
          onClick={() => run((client) => client.sendBootReady(), "bootReady")}
        >
          BOOT_READY
        </button>

        <button
          type="button"
          disabled={!controlReady}
          onClick={() => run((client) => client.sendAuthGuest(getOrCreateDeviceId()), "authGuest")}
        >
          AUTH_GUEST
        </button>

        <label className="flow-inline-input">
          닉네임
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
          />
        </label>

        <button
          type="button"
          disabled={!controlReady}
          onClick={() =>
            run(
              (client) =>
                client.sendOnboardingComplete({
                  nickname,
                  tutorialDone: true,
                  starterHeroIds: ["iris_wolf", "milky_rabbit"],
                  acceptedTermsVersion: "2026-02",
                }),
              "onboardingComplete",
            )
          }
        >
          ONBOARDING_COMPLETE
        </button>

        <label className="flow-inline-input">
          모드
          <select value={modeId} onChange={(event) => setModeId(event.target.value)}>
            <option value="solo_test">solo_test</option>
            <option value="1v1_dev">1v1_dev</option>
            <option value="3v3_rank">3v3_rank</option>
            <option value="3v3_normal">3v3_normal</option>
            <option value="5v5_event">5v5_event</option>
          </select>
        </label>

        <button
          type="button"
          disabled={!controlReady}
          onClick={() =>
            run(
              (client) =>
                client.sendQueueJoin({
                  modeId,
                  regionPreference: "KR",
                }),
              "queueJoin",
            )
          }
        >
          QUEUE_JOIN
        </button>

        <button
          type="button"
          disabled={!controlReady}
          onClick={() => run((client) => client.sendQueueCancel(), "queueCancel")}
        >
          QUEUE_CANCEL
        </button>

        <button
          type="button"
          disabled={!controlReady || !matchCandidateId}
          onClick={() => run((client) => client.sendMatchAccept(true), "matchAccept")}
        >
          MATCH_ACCEPT
        </button>

        <label className="flow-inline-input">
          Draft Hero
          <select
            value={draftHeroId}
            onChange={(event) => setDraftHeroId(event.target.value)}
          >
            {DRAFT_HERO_OPTIONS.map((heroId) => (
              <option key={heroId} value={heroId}>
                {heroId}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={!controlReady || !matchId || !draftTurnSeq}
          onClick={() =>
            run(
              (client) => client.sendDraftAction("PICK", draftHeroId),
              "draftPick",
            )
          }
        >
          DRAFT_PICK
        </button>

        <button
          type="button"
          disabled={!controlReady || !matchId}
          onClick={() => run((client) => client.sendRoomConnectResult("OK"), "roomConnectOk")}
        >
          ROOM_CONNECT_OK
        </button>

        <button
          type="button"
          disabled={!controlReady || !matchId}
          onClick={() => run((client) => client.sendRoomConnectResult("FAIL"), "roomConnectFail")}
        >
          ROOM_CONNECT_FAIL
        </button>

        <button
          type="button"
          disabled={!controlReady || !matchId}
          onClick={() => run((client) => client.sendRematchVote(true), "rematchYes")}
        >
          REMATCH_YES
        </button>
      </div>

      <div className="flow-logs">
        <div className="flow-logs-header">
          <span>Flow Logs</span>
          <button type="button" onClick={clearFlowLogs}>clear</button>
        </div>
        <pre>
          {flowLogs.length > 0 ? flowLogs.join("\n") : "(no logs)"}
        </pre>
      </div>

      {roomToken ? (
        <details>
          <summary>roomToken</summary>
          <p className="flow-token">{roomToken}</p>
        </details>
      ) : null}
    </div>
  );
}
