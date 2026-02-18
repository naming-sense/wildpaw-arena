import { OPCODES } from "./protocol/opcodes";
import type { Envelope, InputCommand, WorldSnapshot } from "./protocol/schemas";

export type ConnectionState =
  | "Disconnected"
  | "Connected"
  | "Unstable"
  | "Reconnecting"
  | "Failed";

export interface RealtimeSocketClientOptions {
  url?: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  heroId?: string;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onStateChange?: (state: ConnectionState) => void;
  onEvent?: (name: string, payload: unknown) => void;
  onPing?: (pingMs: number) => void;
}

const CLIENT_ID_STORAGE_KEY = "wildpaw-client-id";
const HERO_ID_STORAGE_KEY = "wildpaw-hero-id";

function getOrCreateClientId(): string {
  const fallback = `wildpaw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing && existing.length > 0) {
      return existing;
    }

    const generated =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : fallback;

    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return fallback;
  }
}

function normalizeHeroId(rawHeroId: string): string {
  const heroId = rawHeroId.trim();
  return heroId === "whitecat_commando" ? "coral_cat" : heroId;
}

function getPreferredHeroId(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) {
    return normalizeHeroId(explicit);
  }

  if (typeof window === "undefined") {
    return "coral_cat";
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("hero");
    if (fromQuery && fromQuery.trim().length > 0) {
      const hero = normalizeHeroId(fromQuery);
      window.localStorage.setItem(HERO_ID_STORAGE_KEY, hero);
      return hero;
    }

    const stored = window.localStorage.getItem(HERO_ID_STORAGE_KEY);
    if (stored && stored.trim().length > 0) {
      return normalizeHeroId(stored);
    }
  } catch {
    // ignore localStorage/query parsing failures
  }

  return "coral_cat";
}

export class RealtimeSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private state: ConnectionState = "Disconnected";
  private pingSentAt = 0;
  private readonly clientId = getOrCreateClientId();
  private readonly heroId: string;

  constructor(private readonly options: RealtimeSocketClientOptions) {
    this.heroId = getPreferredHeroId(options.heroId);
  }

  connect(roomToken = "dev-room"): void {
    if (!this.options.url) {
      this.setState("Disconnected");
      return;
    }

    this.ws = new WebSocket(this.options.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("Connected");
      this.send(OPCODES.C2S_HELLO, {
        roomToken,
        clientVersion: "0.2.0",
        clientId: this.clientId,
        heroId: this.heroId,
      });
    };

    this.ws.onerror = () => {
      this.setState("Unstable");
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onmessage = (event) => {
      const envelope = JSON.parse(String(event.data)) as Envelope;
      this.handleEnvelope(envelope);
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

  sendInput(command: InputCommand): boolean {
    return this.send(OPCODES.C2S_INPUT, command);
  }

  sendPing(): boolean {
    this.pingSentAt = performance.now();
    return this.send(OPCODES.C2S_PING, { clientTime: Date.now() });
  }

  private handleEnvelope(envelope: Envelope): void {
    switch (envelope.t) {
      case OPCODES.S2C_SNAPSHOT_BASE:
      case OPCODES.S2C_SNAPSHOT_DELTA:
        this.options.onSnapshot?.(envelope.d as WorldSnapshot);
        break;
      case OPCODES.C2S_PING:
      case "S2C_PONG": {
        if (this.pingSentAt > 0) {
          this.options.onPing?.(performance.now() - this.pingSentAt);
        }
        break;
      }
      default:
        this.options.onEvent?.(envelope.t, envelope.d);
        break;
    }
  }

  private scheduleReconnect(): void {
    if (!this.options.url) {
      this.setState("Failed");
      return;
    }

    this.setState("Reconnecting");
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

  private send(type: string, data: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ t: type, d: data } satisfies Envelope));
    return true;
  }

  private setState(next: ConnectionState): void {
    if (next === this.state) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
