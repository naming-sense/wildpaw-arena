import { GameApp } from "./gameApp";

interface BootstrapOptions {
  wsUrl?: string;
  heroId?: string;
}

function resolveDefaultWsUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:8080`;
}

export async function bootstrap(canvas: HTMLCanvasElement, options: BootstrapOptions = {}): Promise<GameApp> {
  const app = new GameApp(canvas, {
    wsUrl: options.wsUrl ?? import.meta.env.VITE_WS_URL ?? resolveDefaultWsUrl(),
    heroId: options.heroId,
  });

  await app.start();
  return app;
}
