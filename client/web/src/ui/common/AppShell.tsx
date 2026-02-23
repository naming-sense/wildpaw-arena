import { useEffect, useRef, useState } from "react";
import { bootstrap } from "../../app/bootstrap";
import type { GameApp } from "../../app/gameApp";
import { WEBGL_UNSUPPORTED_ERROR } from "../../render/renderer";
import { AppFlowLayer } from "../flow/AppFlowLayer";
import { Hud } from "../hud/Hud";
import { useAppFlowStore } from "../store/useAppFlowStore";
import { useUiStore } from "../store/useUiStore";
import { DebugPanel } from "./DebugPanel";

function isRuntimeFlow(flowState: string): boolean {
  return flowState === "MATCH_LOADING" || flowState === "IN_MATCH" || flowState === "RECONNECTING";
}

type SkillSlot = "Q" | "E" | "R";

const SKILL_SLOT_ORDER: SkillSlot[] = ["Q", "E", "R"];

const DEFAULT_SKILL_LABELS: Record<SkillSlot, string> = {
  Q: "스킬1",
  E: "스킬2",
  R: "궁극기",
};

const HERO_SKILL_LABELS: Record<string, Record<SkillSlot, string>> = {
  coral_cat: {
    Q: "관통 사격",
    E: "사이드 스텝",
    R: "집속 폭발",
  },
  bruno_bear: {
    Q: "돌진 강타",
    E: "야수 포효",
    R: "지면 분쇄",
  },
};

function getSkillLabels(heroId: string): Record<SkillSlot, string> {
  return HERO_SKILL_LABELS[heroId] ?? DEFAULT_SKILL_LABELS;
}

export function AppShell(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const appRef = useRef<GameApp | null>(null);
  const loadingAttemptKeyRef = useRef<string | null>(null);

  const [initError, setInitError] = useState<string | null>(null);

  const flowState = useAppFlowStore((state) => state.flowState);
  const selectedHeroId = useAppFlowStore((state) => state.selectedHeroId);
  const loading = useAppFlowStore((state) => state.loading);
  const shouldBootstrapRuntime = isRuntimeFlow(flowState);
  const skillLabels = getSkillLabels(selectedHeroId);

  const setLoadingVisual = useAppFlowStore((state) => state.setLoadingVisual);
  const bumpLoadingRetry = useAppFlowStore((state) => state.bumpLoadingRetry);
  const reportRoomConnectResult = useAppFlowStore((state) => state.reportRoomConnectResult);

  const toggleDebug = useUiStore((state) => state.toggleDebug);

  useEffect(() => {
    if (!shouldBootstrapRuntime) return;
    if (!canvasRef.current) return;
    if (!loading.matchId || !loading.roomEndpoint || !loading.roomToken) return;

    const loadingAttemptKey = `${loading.assignmentVersion}:${loading.matchId}:${loading.roomEndpoint}:${loading.roomToken}`;
    if (loadingAttemptKeyRef.current === loadingAttemptKey) {
      return;
    }
    loadingAttemptKeyRef.current = loadingAttemptKey;

    if (appRef.current) {
      appRef.current.stop();
      appRef.current = null;
    }

    let cancelled = false;
    setInitError(null);

    setLoadingVisual("CONNECTING_ROOM", 38);

    bootstrap(canvasRef.current, {
      wsUrl: loading.roomEndpoint,
      heroId: selectedHeroId,
      roomToken: loading.roomToken,
      mapId: loading.mapId ?? undefined,
    })
      .then((app) => {
        if (cancelled) {
          app.stop();
          return;
        }

        appRef.current = app;
        setLoadingVisual("SYNCING_WORLD", 94);

        window.setTimeout(() => {
          if (cancelled) return;
          setLoadingVisual("READY", 100);
          reportRoomConnectResult("OK");
        }, 80);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        console.error("[AppShell] bootstrap failed", error);
        bumpLoadingRetry();
        reportRoomConnectResult("FAIL");

        if (error instanceof Error && error.message === WEBGL_UNSUPPORTED_ERROR) {
          setInitError("현재 브라우저에서 WebGL을 사용할 수 없어요. 텔레그램 내장 브라우저 대신 Safari/Chrome으로 열어주세요.");
          return;
        }

        setInitError("룸 서버 연결 중 오류가 발생했어요. 토큰 재할당/복구를 기다립니다.");
      });

    return () => {
      cancelled = true;
    };
  }, [
    bumpLoadingRetry,
    loading.assignmentVersion,
    loading.matchId,
    loading.roomEndpoint,
    loading.roomToken,
    reportRoomConnectResult,
    selectedHeroId,
    setLoadingVisual,
    shouldBootstrapRuntime,
  ]);

  useEffect(() => {
    if (isRuntimeFlow(flowState)) return;

    if (appRef.current) {
      appRef.current.stop();
      appRef.current = null;
    }

    loadingAttemptKeyRef.current = null;
  }, [flowState]);

  useEffect(() => {
    return () => {
      if (appRef.current) {
        appRef.current.stop();
        appRef.current = null;
      }
    };
  }, []);

  const showRuntimeUi = isRuntimeFlow(flowState);
  const showMatchHud = flowState === "IN_MATCH" || flowState === "RECONNECTING";

  return (
    <div className="app-shell">
      <canvas
        ref={canvasRef}
        className={`game-canvas${showRuntimeUi ? "" : " game-canvas--hidden"}`}
      />

      {showMatchHud ? <Hud /> : null}
      {showMatchHud ? <DebugPanel /> : null}

      {showMatchHud ? (
        <button
          type="button"
          className="debug-toggle-button"
          onClick={toggleDebug}
        >
          Debug
        </button>
      ) : null}

      {showRuntimeUi ? (
        <>
          <button
            type="button"
            className="mobile-fire-button"
            data-fire-button
            aria-label="공격"
          >
            공격
          </button>

          <div className="mobile-skill-cluster" aria-label="모바일 스킬 버튼">
            {SKILL_SLOT_ORDER.map((slot) => (
              <button
                key={slot}
                type="button"
                className={`mobile-skill-button mobile-skill-button--${slot.toLowerCase()}`}
                data-skill-button={slot}
                aria-label={`${slot} 스킬 ${skillLabels[slot]}`}
                title={`${slot} · ${skillLabels[slot]}`}
              >
                <img
                  src={`/assets/ui/skills/skill-${slot.toLowerCase()}.svg`}
                  alt=""
                  aria-hidden="true"
                  className="mobile-skill-button__icon"
                />
                <span className="mobile-skill-button__slot">{slot}</span>
                <span className="mobile-skill-button__name">{skillLabels[slot]}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <AppFlowLayer />
      {initError ? <div className="overlay-panel">{initError}</div> : null}
    </div>
  );
}
