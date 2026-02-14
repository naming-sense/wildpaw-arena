import type { InputFrame, WorldSnapshot } from "./types";

export interface RealtimeClientOptions {
  url: string;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onEvent?: (eventName: string, payload: unknown) => void;
}

type Envelope = {
  t: string;
  d: unknown;
};

export class RealtimeClient {
  private ws: WebSocket | null = null;

  constructor(private readonly options: RealtimeClientOptions) {}

  connect(roomToken: string): void {
    this.ws = new WebSocket(this.options.url);

    this.ws.onopen = () => {
      this.send("C2S_HELLO", { roomToken, clientVersion: "0.1.0" });
    };

    this.ws.onmessage = (event: MessageEvent<string>) => {
      const parsed = JSON.parse(event.data) as Envelope;
      this.handleEnvelope(parsed);
    };
  }

  sendInput(input: InputFrame): void {
    this.send("C2S_INPUT", input);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(type: string, data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ t: type, d: data }));
  }

  private handleEnvelope(envelope: Envelope): void {
    if (envelope.t === "S2C_SNAPSHOT_BASE" || envelope.t === "S2C_SNAPSHOT_DELTA") {
      this.options.onSnapshot?.(envelope.d as WorldSnapshot);
      return;
    }

    this.options.onEvent?.(envelope.t, envelope.d);
  }
}
