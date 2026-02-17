import { GameApp } from "./gameApp";

function resolveDefaultWsUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:8080`;
}

export async function bootstrap(canvas: HTMLCanvasElement): Promise<GameApp> {
  const app = new GameApp(canvas, {
    wsUrl: import.meta.env.VITE_WS_URL ?? resolveDefaultWsUrl(),
  });

  await app.start();
  return app;
}
