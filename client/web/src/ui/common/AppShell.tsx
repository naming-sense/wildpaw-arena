import { useEffect, useRef, useState } from "react";
import { bootstrap } from "../../app/bootstrap";
import type { GameApp } from "../../app/gameApp";
import { WEBGL_UNSUPPORTED_ERROR } from "../../render/renderer";
import { AppFlowLayer } from "../flow/AppFlowLayer";
import { Hud } from "../hud/Hud";
import { useAppFlowStore } from "../store/useAppFlowStore";
import { useUiStore } from "../store/useUiStore";
import { DebugPanel } from "./DebugPanel";

function isMatchRuntimeFlow(flowState: string): boolean {
  return flowState === "MATCH_LOADING" || flowState === "IN_MATCH" || flowState === "RECONNECTING";
}

export function AppShell(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const appRef = useRef<GameApp | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const flowState = useAppFlowStore((state) => state.flowState);
  const selectedHeroId = useAppFlowStore((state) => state.selectedHeroId);
  const setMatchLoadingPhase = useAppFlowStore((state) => state.setMatchLoadingPhase);
  const setMatchLoadingProgress = useAppFlowStore((state) => state.setMatchLoadingProgress);
  const bumpMatchLoadingRetry = useAppFlowStore((state) => state.bumpMatchLoadingRetry);
  const enterInMatch = useAppFlowStore((state) => state.enterInMatch);
  const backToLobby = useAppFlowStore((state) => state.backToLobby);
  const finishMatch = useAppFlowStore((state) => state.finishMatch);

  const toggleDebug = useUiStore((state) => state.toggleDebug);

  useEffect(() => {
    if (flowState !== "MATCH_LOADING") return;
    if (!canvasRef.current) return;

    if (appRef.current) {
      enterInMatch();
      return;
    }

    let cancelled = false;
    setInitError(null);

    setMatchLoadingPhase("ALLOCATING_ROOM");
    setMatchLoadingProgress(12);

    const t1 = window.setTimeout(() => {
      setMatchLoadingPhase("CONNECTING_ROOM");
      setMatchLoadingProgress(48);
    }, 280);

    const t2 = window.setTimeout(() => {
      setMatchLoadingPhase("SYNCING_WORLD");
      setMatchLoadingProgress(82);
    }, 820);

    bootstrap(canvasRef.current, { heroId: selectedHeroId })
      .then((app) => {
        if (cancelled) {
          app.stop();
          return;
        }

        appRef.current = app;
        setMatchLoadingPhase("READY");
        setMatchLoadingProgress(100);

        window.setTimeout(() => {
          if (!cancelled) {
            enterInMatch();
          }
        }, 120);
      })
      .catch((error: unknown) => {
        console.error("[AppShell] bootstrap failed", error);
        if (cancelled) return;

        bumpMatchLoadingRetry();

        if (error instanceof Error && error.message === WEBGL_UNSUPPORTED_ERROR) {
          setInitError("현재 브라우저에서 WebGL을 사용할 수 없어요. 텔레그램 내장 브라우저 대신 Safari/Chrome으로 열어주세요.");
        } else {
          setInitError("게임 초기화 중 오류가 발생했어요. 페이지를 새로고침하거나 외부 브라우저에서 다시 열어주세요.");
        }

        backToLobby("매치 로딩 실패: 로비로 복귀했습니다.");
      });

    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [
    backToLobby,
    bumpMatchLoadingRetry,
    enterInMatch,
    flowState,
    selectedHeroId,
    setMatchLoadingPhase,
    setMatchLoadingProgress,
  ]);

  useEffect(() => {
    if (isMatchRuntimeFlow(flowState)) return;

    if (appRef.current) {
      appRef.current.stop();
      appRef.current = null;
    }
  }, [flowState]);

  useEffect(() => {
    return () => {
      if (appRef.current) {
        appRef.current.stop();
        appRef.current = null;
      }
    };
  }, []);

  const showMatchUi = flowState === "IN_MATCH" || flowState === "RECONNECTING";
  const showCanvas = isMatchRuntimeFlow(flowState);

  return (
    <div className="app-shell">
      <canvas
        ref={canvasRef}
        className={`game-canvas${showCanvas ? "" : " game-canvas--hidden"}`}
      />

      {showMatchUi ? <Hud /> : null}
      {showMatchUi ? <DebugPanel /> : null}

      {showMatchUi ? (
        <button
          type="button"
          className="debug-toggle-button"
          onClick={toggleDebug}
        >
          Debug
        </button>
      ) : null}

      {flowState === "IN_MATCH" ? (
        <button
          type="button"
          className="match-end-button"
          onClick={() => finishMatch()}
        >
          전투 종료(테스트)
        </button>
      ) : null}

      {showMatchUi ? (
        <button
          type="button"
          className="mobile-fire-button"
          data-fire-button
          aria-label="공격"
        >
          공격
        </button>
      ) : null}

      <AppFlowLayer />
      {initError ? <div className="overlay-panel">{initError}</div> : null}
    </div>
  );
}
