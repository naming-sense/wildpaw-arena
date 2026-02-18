export type GatewayConnectionState =
  | "Disconnected"
  | "Connecting"
  | "Connected"
  | "Reconnecting"
  | "Failed";

export interface ControlEnvelope {
  event: string;
  eventId: string;
  requestId: string | null;
  sessionId: string | null;
  ts: number;
  payload: unknown;
}

interface ControlGatewayClientOptions {
  url?: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  onStateChange?: (state: GatewayConnectionState) => void;
  onEnvelope?: (envelope: ControlEnvelope) => void;
}

function createUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampReconnectDelay(minMs: number, maxMs: number, attempt: number): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt - 1));
  const jitter = base * (0.82 + Math.random() * 0.36);
  return Math.max(minMs, Math.round(jitter));
}

function toEnvelope(raw: unknown): ControlEnvelope | null {
  if (!raw || typeof raw !== "object") return null;

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.event !== "string") return null;
  if (typeof candidate.eventId !== "string") return null;

  return {
    event: candidate.event,
    eventId: candidate.eventId,
    requestId: typeof candidate.requestId === "string" ? candidate.requestId : null,
    sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : null,
    ts: typeof candidate.ts === "number" ? candidate.ts : Date.now(),
    payload: candidate.payload,
  };
}

export class ControlGatewayClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private state: GatewayConnectionState = "Disconnected";
  private sessionId: string | null = null;

  constructor(private readonly options: ControlGatewayClientOptions) {}

  connect(): void {
    if (!this.options.url) {
      this.setState("Failed");
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setState(this.reconnectAttempt > 0 ? "Reconnecting" : "Connecting");

    this.ws = new WebSocket(this.options.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("Connected");
    };

    this.ws.onerror = () => {
      this.setState("Reconnecting");
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onmessage = (event) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(event.data));
      } catch {
        return;
      }

      const envelope = toEnvelope(decoded);
      if (!envelope) return;

      if (envelope.sessionId) {
        this.sessionId = envelope.sessionId;
      }

      this.options.onEnvelope?.(envelope);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.ws?.close();
    this.ws = null;
    this.setState("Disconnected");
  }

  send(event: string, payload: unknown, requestId?: string | null): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const envelope: ControlEnvelope = {
      event,
      eventId: createUuid(),
      requestId: requestId ?? createUuid(),
      sessionId: this.sessionId,
      ts: Date.now(),
      payload,
    };

    this.ws.send(JSON.stringify(envelope));
    return true;
  }

  private scheduleReconnect(): void {
    if (!this.options.url) {
      this.setState("Failed");
      return;
    }

    if (this.reconnectTimer !== null) {
      return;
    }

    this.reconnectAttempt += 1;
    this.setState("Reconnecting");

    const delayMs = clampReconnectDelay(
      this.options.reconnectMinMs,
      this.options.reconnectMaxMs,
      this.reconnectAttempt,
    );

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private setState(next: GatewayConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
