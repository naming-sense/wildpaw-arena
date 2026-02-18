import type { AppFlowState, ControlConnectionState } from "../ui/store/useUiStore";

interface ControlEnvelope<TPayload = unknown> {
  event: string;
  eventId: string;
  requestId: string;
  sessionId: string | null;
  ts: number;
  payload: TPayload;
}

interface MatchFoundPayload {
  matchCandidateId: string;
  modeId: string;
  acceptDeadlineSec: number;
  mapPool: string[];
}

interface DraftStatePayload {
  matchId: string;
  turnSeq: number;
  remainingSec: number;
}

interface MatchAssignPayload {
  matchId: string;
  room: {
    endpoint: string;
    roomToken: string;
    region: string;
    expiresAtMs?: number;
  };
  mapId: string;
  modeId: string;
  teamInfo: {
    teamId: number;
    slot: number;
  };
}

interface FlowErrorPayload {
  errorCode?: string;
  message?: string;
  details?: unknown;
  flowState?: string;
}

interface ControlFlowClientOptions {
  url?: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  onConnectionState?: (state: ControlConnectionState) => void;
  onFlowState?: (state: AppFlowState) => void;
  onSessionResolved?: (sessionId: string | null, accountId: string | null) => void;
  onQueueJoined?: (queueTicketId: string, modeId: string) => void;
  onQueueCancelled?: () => void;
  onQueueStatus?: (payload: unknown) => void;
  onMatchFound?: (payload: MatchFoundPayload) => void;
  onReadyCheckResult?: (payload: unknown) => void;
  onDraftStart?: (payload: unknown) => void;
  onDraftState?: (payload: DraftStatePayload) => void;
  onMatchAssign?: (payload: MatchAssignPayload) => void;
  onMatchEnded?: (payload: unknown) => void;
  onRematchState?: (payload: unknown) => void;
  onError?: (payload: FlowErrorPayload) => void;
  onEvent?: (event: string, payload: unknown) => void;
}

function nowMs(): number {
  return Date.now();
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toFlowState(raw: unknown): AppFlowState | null {
  if (typeof raw !== "string") return null;

  const state = raw.toUpperCase();
  switch (state) {
    case "BOOT":
    case "AUTH":
    case "ONBOARDING":
    case "LOBBY":
    case "PARTY":
    case "QUEUEING":
    case "READY_CHECK":
    case "DRAFT":
    case "MATCH_LOADING":
    case "IN_MATCH":
    case "RESULT":
    case "RECONNECTING":
      return state;
    default:
      return null;
  }
}

export class ControlFlowClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;

  private state: ControlConnectionState = "Disconnected";

  private sessionId: string | null = null;
  private accountId: string | null = null;
  private queueTicketId: string | null = null;
  private matchCandidateId: string | null = null;
  private matchId: string | null = null;
  private draftTurnSeq: number | null = null;

  constructor(private readonly options: ControlFlowClientOptions) {}

  get endpoint(): string | undefined {
    return this.options.url;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getMatchCandidateId(): string | null {
    return this.matchCandidateId;
  }

  getMatchId(): string | null {
    return this.matchId;
  }

  getDraftTurnSeq(): number | null {
    return this.draftTurnSeq;
  }

  connect(): void {
    if (!this.options.url) {
      this.setConnectionState("Failed");
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.ws = new WebSocket(this.options.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setConnectionState("Connected");
    };

    this.ws.onerror = () => {
      this.setConnectionState("Reconnecting");
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onmessage = (event) => {
      this.handleIncoming(String(event.data));
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.ws?.close();
    this.ws = null;

    this.setConnectionState("Disconnected");
  }

  sendBootReady(payload?: {
    appVersion?: string;
    platform?: string;
    locale?: string;
    regionCandidates?: string[];
  }): boolean {
    return this.send("C2S_BOOT_READY", {
      appVersion: payload?.appVersion ?? "0.2.1",
      platform: payload?.platform ?? "web",
      locale: payload?.locale ?? "ko-KR",
      regionCandidates: payload?.regionCandidates ?? ["KR"],
    });
  }

  sendAuthGuest(deviceId: string): boolean {
    return this.send("C2S_AUTH_GUEST", { deviceId });
  }

  sendAuthLogin(provider: string, idToken: string): boolean {
    return this.send("C2S_AUTH_LOGIN", { provider, idToken });
  }

  sendOnboardingComplete(payload: {
    nickname: string;
    tutorialDone: boolean;
    starterHeroIds: string[];
    acceptedTermsVersion: string;
  }): boolean {
    return this.send("C2S_ONBOARDING_COMPLETE", payload);
  }

  sendQueueJoin(payload: {
    modeId: string;
    regionPreference?: string;
    partyId?: string | null;
    inputDevice?: string;
  }): boolean {
    return this.send("C2S_QUEUE_JOIN", {
      modeId: payload.modeId,
      regionPreference: payload.regionPreference ?? "KR",
      partyId: payload.partyId ?? null,
      inputDevice: payload.inputDevice ?? "kbm",
    });
  }

  sendQueueCancel(reason = "user_cancel"): boolean {
    return this.send("C2S_QUEUE_CANCEL", {
      queueTicketId: this.queueTicketId,
      reason,
    });
  }

  sendMatchAccept(accept: boolean): boolean {
    if (!this.matchCandidateId) {
      return false;
    }

    return this.send("C2S_MATCH_ACCEPT", {
      matchCandidateId: this.matchCandidateId,
      accept,
    });
  }

  sendDraftAction(actionType: "HOVER" | "BAN" | "PICK" | "LOCK", heroId?: string): boolean {
    if (!this.matchId || !this.draftTurnSeq) {
      return false;
    }

    return this.send("C2S_DRAFT_ACTION", {
      matchId: this.matchId,
      actionType,
      heroId: heroId ?? null,
      turnSeq: this.draftTurnSeq,
    });
  }

  sendRoomConnectResult(status: "OK" | "FAIL"): boolean {
    if (!this.matchId) {
      return false;
    }

    return this.send("C2S_ROOM_CONNECT_RESULT", {
      matchId: this.matchId,
      status,
    });
  }

  sendRematchVote(vote: boolean): boolean {
    if (!this.matchId) {
      return false;
    }

    return this.send("C2S_REMATCH_VOTE", {
      matchId: this.matchId,
      vote,
    });
  }

  sendPing(): boolean {
    return this.send("C2S_PING", {
      clientTimeMs: nowMs(),
    });
  }

  private send(event: string, payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const envelope: ControlEnvelope = {
      event,
      eventId: makeId(),
      requestId: makeId(),
      sessionId: this.sessionId,
      ts: nowMs(),
      payload,
    };

    this.ws.send(JSON.stringify(envelope));
    return true;
  }

  private handleIncoming(raw: string): void {
    let envelope: ControlEnvelope;
    try {
      envelope = JSON.parse(raw) as ControlEnvelope;
    } catch {
      return;
    }

    const event = envelope.event;
    const payload = envelope.payload;

    this.options.onEvent?.(event, payload);

    switch (event) {
      case "S2C_HELLO": {
        const maybeState = toFlowState((payload as { state?: unknown })?.state);
        if (maybeState) {
          this.options.onFlowState?.(maybeState);
        }
        return;
      }

      case "S2C_FLOW_STATE": {
        const state = toFlowState((payload as { state?: unknown })?.state);
        if (state) {
          this.options.onFlowState?.(state);
        }
        return;
      }

      case "S2C_BOOT_ACK": {
        this.options.onFlowState?.("AUTH");
        return;
      }

      case "S2C_FORCE_UPDATE": {
        this.options.onError?.({
          errorCode: "FORCE_UPDATE",
          message: "Client update required",
          details: payload,
        });
        return;
      }

      case "S2C_AUTH_OK": {
        const authPayload = payload as {
          sessionId?: unknown;
          accountId?: unknown;
          isFirstUser?: unknown;
        };

        this.sessionId =
          typeof authPayload.sessionId === "string" ? authPayload.sessionId : null;
        this.accountId =
          typeof authPayload.accountId === "string" ? authPayload.accountId : null;

        this.options.onSessionResolved?.(this.sessionId, this.accountId);

        this.options.onFlowState?.(
          authPayload.isFirstUser ? "ONBOARDING" : "LOBBY",
        );
        return;
      }

      case "S2C_AUTH_FAIL": {
        this.options.onError?.(payload as FlowErrorPayload);
        this.options.onFlowState?.("AUTH");
        return;
      }

      case "S2C_ONBOARDING_SAVED": {
        this.options.onFlowState?.("LOBBY");
        return;
      }

      case "S2C_QUEUE_JOINED": {
        const queue = payload as { queueTicketId?: unknown; modeId?: unknown };
        this.queueTicketId =
          typeof queue.queueTicketId === "string" ? queue.queueTicketId : null;

        this.options.onQueueJoined?.(
          this.queueTicketId ?? "",
          typeof queue.modeId === "string" ? queue.modeId : "",
        );
        this.options.onFlowState?.("QUEUEING");
        return;
      }

      case "S2C_QUEUE_STATUS": {
        this.options.onQueueStatus?.(payload);
        return;
      }

      case "S2C_QUEUE_CANCELLED": {
        this.queueTicketId = null;
        this.options.onQueueCancelled?.();
        this.options.onFlowState?.("LOBBY");
        return;
      }

      case "S2C_MATCH_FOUND": {
        const found = payload as MatchFoundPayload;
        this.matchCandidateId = found.matchCandidateId;
        this.options.onMatchFound?.(found);
        this.options.onFlowState?.("READY_CHECK");
        return;
      }

      case "S2C_READY_CHECK_RESULT": {
        const result = payload as { status?: unknown };
        this.options.onReadyCheckResult?.(payload);
        if (result.status === "ALL_ACCEPTED") {
          this.options.onFlowState?.("DRAFT");
        } else if (result.status === "FAILED_DECLINED") {
          this.options.onFlowState?.("LOBBY");
        }
        return;
      }

      case "S2C_DRAFT_START": {
        const draftStart = payload as { matchId?: unknown };
        this.matchId =
          typeof draftStart.matchId === "string" ? draftStart.matchId : this.matchId;
        this.options.onDraftStart?.(payload);
        this.options.onFlowState?.("DRAFT");
        return;
      }

      case "S2C_DRAFT_STATE": {
        const draftState = payload as DraftStatePayload;
        this.matchId = draftState.matchId;
        this.draftTurnSeq = draftState.turnSeq;
        this.options.onDraftState?.(draftState);
        return;
      }

      case "S2C_DRAFT_TIMEOUT_AUTOPICK": {
        this.options.onEvent?.(event, payload);
        return;
      }

      case "S2C_MATCH_ASSIGN": {
        const assign = payload as MatchAssignPayload;
        this.matchId = assign.matchId;
        this.options.onMatchAssign?.(assign);
        this.options.onFlowState?.("MATCH_LOADING");
        return;
      }

      case "S2C_MATCH_ASSIGN_RETRY": {
        this.options.onEvent?.(event, payload);
        this.options.onFlowState?.("MATCH_LOADING");
        return;
      }

      case "S2C_ROOM_CONNECT_CONFIRMED": {
        this.options.onFlowState?.("IN_MATCH");
        return;
      }

      case "S2C_QUEUE_RECOVERY": {
        this.options.onEvent?.(event, payload);
        this.options.onFlowState?.("LOBBY");
        return;
      }

      case "S2C_RECONNECT_WINDOW": {
        this.options.onEvent?.(event, payload);
        this.options.onFlowState?.("RECONNECTING");
        return;
      }

      case "S2C_MATCH_ENDED": {
        this.options.onMatchEnded?.(payload);
        this.options.onFlowState?.("RESULT");
        return;
      }

      case "S2C_REMATCH_STATE": {
        this.options.onRematchState?.(payload);
        return;
      }

      case "S2C_REMATCH_START": {
        this.options.onFlowState?.("READY_CHECK");
        return;
      }

      case "S2C_REMATCH_CANCELLED": {
        this.options.onFlowState?.("LOBBY");
        return;
      }

      case "S2C_ERROR": {
        const err = payload as FlowErrorPayload;
        this.options.onError?.(err);

        const maybeFlow = toFlowState(err.flowState);
        if (maybeFlow) {
          this.options.onFlowState?.(maybeFlow);
        }
        return;
      }

      case "S2C_PONG": {
        return;
      }

      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    if (!this.options.url) {
      this.setConnectionState("Failed");
      return;
    }

    this.setConnectionState("Reconnecting");

    this.reconnectAttempt += 1;
    const base = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** (this.reconnectAttempt - 1),
    );

    const jittered = base * (0.8 + Math.random() * 0.4);

    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, jittered);
  }

  private setConnectionState(next: ControlConnectionState): void {
    if (this.state === next) {
      return;
    }

    this.state = next;
    this.options.onConnectionState?.(next);
  }
}
