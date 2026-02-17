import { useEffect, useRef, useState } from "react";
import { bootstrap } from "../../app/bootstrap";
import { WEBGL_UNSUPPORTED_ERROR } from "../../render/renderer";
import { Hud } from "../hud/Hud";
import { DebugPanel } from "./DebugPanel";
import { useUiStore } from "../store/useUiStore";

export function AppShell(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const toggleDebug = useUiStore((state) => state.toggleDebug);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    let dispose: (() => void) | null = null;
    let cancelled = false;

    bootstrap(canvasRef.current)
      .then((app) => {
        if (cancelled) {
          app.stop();
          return;
        }
        dispose = () => app.stop();
      })
      .catch((error: unknown) => {
        console.error("[AppShell] bootstrap failed", error);
        if (cancelled) return;

        if (error instanceof Error && error.message === WEBGL_UNSUPPORTED_ERROR) {
          setInitError("현재 브라우저에서 WebGL을 사용할 수 없어요. 텔레그램 내장 브라우저 대신 Safari/Chrome으로 열어주세요.");
          return;
        }

        setInitError("게임 초기화 중 오류가 발생했어요. 페이지를 새로고침하거나 외부 브라우저에서 다시 열어주세요.");
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return (
    <div className="app-shell">
      <canvas ref={canvasRef} className="game-canvas" />
      <Hud />
      <DebugPanel />
      {initError ? <div className="overlay-panel">{initError}</div> : null}
      <button
        type="button"
        style={{ position: "absolute", right: 12, bottom: 12, zIndex: 8 }}
        onClick={toggleDebug}
      >
        Debug
      </button>
    </div>
  );
}
