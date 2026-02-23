import { useEffect, useRef } from "react";
import { HERO_DEFS, HERO_DEF_BY_ID } from "../../gameplay/hero/heroDefs";
import { ControlGatewayClient } from "../../net/controlGatewayClient";
import { useUiStore } from "../store/useUiStore";
import {
  bindGatewayTransport,
  isHeroAvailable,
  isModeComingSoon,
  MATCH_MODE_OPTIONS,
  type AppFlowState,
  type MatchLoadingPhase,
  useAppFlowStore,
} from "../store/useAppFlowStore";

function resolveControlWsUrl(): string | undefined {
  const envUrl = import.meta.env.VITE_CONTROL_WS_URL as string | undefined;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl;
  }

  if (typeof window === "undefined") {
    return undefined;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:7200`;
}

function formatDuration(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const minute = Math.floor(safe / 60);
  const second = safe % 60;
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function getBootLabel(phase: string): string {
  switch (phase) {
    case "CHECK_VERSION":
      return "버전 확인 중";
    case "PROBE_REGION":
      return "리전 상태 확인 중";
    case "RESTORE_SESSION":
      return "세션 준비 중";
    case "DONE":
      return "부트 완료";
    case "ERROR":
      return "부트 실패";
    default:
      return "초기화 중";
  }
}

function getLoadingPhaseLabel(phase: MatchLoadingPhase): string {
  switch (phase) {
    case "ALLOCATING_ROOM":
      return "룸 할당 중";
    case "CONNECTING_ROOM":
      return "룸 서버 연결 중";
    case "SYNCING_WORLD":
      return "월드 동기화 중";
    case "READY":
      return "전투 준비 완료";
    default:
      return "준비 중";
  }
}

function getPingTier(pingMs: number): "good" | "normal" | "warn" {
  if (pingMs < 60) return "good";
  if (pingMs <= 100) return "normal";
  return "warn";
}

function getGatewayTier(state: string): "good" | "normal" | "warn" {
  if (state === "Connected") return "good";
  if (state === "Connecting" || state === "Reconnecting") return "normal";
  return "warn";
}

function getCurrentTurnToken(turnOrder: string[], turnSeq: number): string {
  if (turnOrder.length === 0) return "teamA_pick";
  return turnOrder[(turnSeq - 1) % turnOrder.length] ?? turnOrder[0] ?? "teamA_pick";
}

function FlowRuntimeController(): null {
  const flowState = useAppFlowStore((state) => state.flowState);
  const bootRequestPending = useAppFlowStore((state) => state.bootRequestPending);
  const gatewayConnectionState = useAppFlowStore((state) => state.gatewayConnectionState);
  const resumeOnboardingFromDraft = useAppFlowStore((state) => state.resumeOnboardingFromDraft);
  const systemNotice = useAppFlowStore((state) => state.systemNotice);

  const setGatewayConnectionState = useAppFlowStore((state) => state.setGatewayConnectionState);
  const applyGatewayEnvelope = useAppFlowStore((state) => state.applyGatewayEnvelope);
  const requestBootReady = useAppFlowStore((state) => state.requestBootReady);
  const requestAuthGuest = useAppFlowStore((state) => state.requestAuthGuest);
  const requestPing = useAppFlowStore((state) => state.requestPing);
  const tickReadyCheckCountdown = useAppFlowStore((state) => state.tickReadyCheckCountdown);
  const tickDraftCountdown = useAppFlowStore((state) => state.tickDraftCountdown);
  const clearSystemNotice = useAppFlowStore((state) => state.clearSystemNotice);
  const setRealtimeConnectionState = useAppFlowStore((state) => state.setRealtimeConnectionState);

  const realtimeReconnectState = useUiStore((state) => state.reconnectState);

  const gatewayClientRef = useRef<ControlGatewayClient | null>(null);
  const autoGuestAuthTriedRef = useRef(false);

  useEffect(() => {
    const client = new ControlGatewayClient({
      url: resolveControlWsUrl(),
      reconnectMinMs: 500,
      reconnectMaxMs: 4_000,
      onStateChange: setGatewayConnectionState,
      onEnvelope: applyGatewayEnvelope,
    });

    gatewayClientRef.current = client;
    bindGatewayTransport({
      send: (event, payload) => client.send(event, payload),
    });

    client.connect();

    return () => {
      bindGatewayTransport(null);
      client.disconnect();
      gatewayClientRef.current = null;
    };
  }, [applyGatewayEnvelope, setGatewayConnectionState]);

  useEffect(() => {
    if (flowState !== "BOOT") return;
    if (gatewayConnectionState !== "Connected") return;
    if (bootRequestPending) return;

    requestBootReady();
  }, [bootRequestPending, flowState, gatewayConnectionState, requestBootReady]);

  useEffect(() => {
    if (flowState !== "AUTH") {
      autoGuestAuthTriedRef.current = false;
      return;
    }
    if (!resumeOnboardingFromDraft) return;
    if (gatewayConnectionState !== "Connected") return;
    if (autoGuestAuthTriedRef.current) return;

    autoGuestAuthTriedRef.current = true;
    requestAuthGuest();
  }, [flowState, gatewayConnectionState, requestAuthGuest, resumeOnboardingFromDraft]);

  useEffect(() => {
    if (flowState !== "READY_CHECK") return;

    const timer = window.setInterval(() => {
      tickReadyCheckCountdown(Date.now());
    }, 100);

    return () => {
      window.clearInterval(timer);
    };
  }, [flowState, tickReadyCheckCountdown]);

  useEffect(() => {
    if (flowState !== "DRAFT") return;

    const timer = window.setInterval(() => {
      tickDraftCountdown();
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [flowState, tickDraftCountdown]);

  useEffect(() => {
    if (gatewayConnectionState !== "Connected") return;

    const timer = window.setInterval(() => {
      requestPing();
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [gatewayConnectionState, requestPing]);

  useEffect(() => {
    setRealtimeConnectionState(realtimeReconnectState);
  }, [realtimeReconnectState, setRealtimeConnectionState]);

  useEffect(() => {
    if (!systemNotice) return;
    const timer = window.setTimeout(() => {
      clearSystemNotice();
    }, 3_200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [clearSystemNotice, systemNotice]);

  return null;
}

interface LobbyTopBarProps {
  displayName: string;
  pingMs: number;
  gatewayState: string;
}

function LobbyTopBar({ displayName, pingMs, gatewayState }: LobbyTopBarProps): JSX.Element {
  const pingTier = getPingTier(pingMs);
  const gatewayTier = getGatewayTier(gatewayState);

  return (
    <header className="flow-topbar" aria-label="글로벌 상태 바">
      <div className="flow-topbar__profile">
        <span className="flow-topbar__avatar" aria-hidden>
          🐾
        </span>
        <div>
          <p className="flow-topbar__label">PLAYER</p>
          <strong className="flow-topbar__value">{displayName || "Guest"}</strong>
        </div>
      </div>

      <div className="flow-topbar__meta">
        <span className="flow-chip">PAW 12,450</span>
        <span className="flow-chip">GEM 380</span>
        <span className={`flow-chip flow-chip--${pingTier}`}>PING {pingMs.toFixed(0)}ms</span>
        <span className={`flow-chip flow-chip--${gatewayTier}`}>GW {gatewayState}</span>
      </div>
    </header>
  );
}

function BottomNav(): JSX.Element {
  return (
    <nav className="flow-bottom-nav" aria-label="하단 메뉴">
      <button type="button">히어로</button>
      <button type="button">상점</button>
      <button type="button">배틀패스</button>
      <button type="button">미션</button>
      <button type="button">커리어</button>
    </nav>
  );
}

function BootScreen(): JSX.Element {
  const bootPhase = useAppFlowStore((state) => state.bootPhase);
  const bootProgressPct = useAppFlowStore((state) => state.bootProgressPct);
  const gatewayConnectionState = useAppFlowStore((state) => state.gatewayConnectionState);
  const requestBootReady = useAppFlowStore((state) => state.requestBootReady);

  return (
    <section className="flow-screen flow-screen--centered" aria-label="부트 화면">
      <div className="flow-card flow-card--compact">
        <h1 className="flow-title">WILDPAW ARENA</h1>
        <p className="flow-subtitle">{getBootLabel(bootPhase)}</p>
        <div className="flow-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bootProgressPct}>
          <span style={{ width: `${bootProgressPct}%` }} />
        </div>
        <p className="flow-muted">{bootProgressPct}% · Gateway {gatewayConnectionState}</p>

        <button
          type="button"
          className="flow-button"
          onClick={requestBootReady}
          disabled={gatewayConnectionState !== "Connected"}
        >
          부트 재시도
        </button>
      </div>
    </section>
  );
}

function AuthScreen(): JSX.Element {
  const requestAuthGuest = useAppFlowStore((state) => state.requestAuthGuest);

  return (
    <section className="flow-screen flow-screen--centered" aria-label="인증 화면">
      <div className="flow-card flow-card--compact">
        <h2 className="flow-title">로그인</h2>
        <p className="flow-subtitle">게스트/계정 로그인 중 선택해 주세요.</p>
        <div className="flow-stack">
          <button type="button" className="flow-button" disabled aria-disabled="true">
            Google 로그인 (준비중)
          </button>
          <button type="button" className="flow-button" disabled aria-disabled="true">
            Apple 로그인 (준비중)
          </button>
          <button type="button" className="flow-button flow-button--primary" onClick={requestAuthGuest}>게스트 시작</button>
        </div>
        <p className="flow-muted">소셜 로그인은 현재 준비 중입니다. 지금은 게스트 시작으로 이용해 주세요.</p>
      </div>
    </section>
  );
}

function OnboardingScreen(): JSX.Element {
  const onboardingNickname = useAppFlowStore((state) => state.onboardingNickname);
  const termsAccepted = useAppFlowStore((state) => state.termsAccepted);
  const starterHeroId = useAppFlowStore((state) => state.onboardingStarterHeroId);

  const setOnboardingNickname = useAppFlowStore((state) => state.setOnboardingNickname);
  const setTermsAccepted = useAppFlowStore((state) => state.setTermsAccepted);
  const setStarterHero = useAppFlowStore((state) => state.setStarterHero);
  const requestSubmitOnboarding = useAppFlowStore((state) => state.requestSubmitOnboarding);

  const trimmedNickname = onboardingNickname.trim();
  const nicknameValid = trimmedNickname.length >= 2 && trimmedNickname.length <= 12;
  const starterHeroAvailable = starterHeroId.trim().length > 0 && isHeroAvailable(starterHeroId);
  const canSubmit = nicknameValid && termsAccepted && starterHeroAvailable;

  return (
    <section className="flow-screen flow-screen--centered" aria-label="온보딩 화면">
      <form
        className="flow-card flow-card--wide"
        onSubmit={(event) => {
          event.preventDefault();
          requestSubmitOnboarding();
        }}
      >
        <h2 className="flow-title">온보딩</h2>

        <label className="flow-field">
          <span>닉네임 (2~12자)</span>
          <input
            value={onboardingNickname}
            onChange={(event) => setOnboardingNickname(event.target.value)}
            placeholder="예: SenseNaming"
            minLength={2}
            maxLength={12}
            aria-invalid={onboardingNickname.length > 0 && !nicknameValid}
          />
        </label>

        <fieldset className="flow-fieldset">
          <legend>스타터 히어로 선택 (1명)</legend>
          <p className="flow-muted">여기서 고른 히어로 1명이 초반 기본 히어로로 설정됩니다.</p>
          <p className="flow-muted">현재는 코랄 캣 / 브루노 베어만 사용 가능합니다.</p>
          <div className="flow-chip-grid" role="radiogroup" aria-label="스타터 히어로 선택">
            {HERO_DEFS.slice(0, 6).map((hero) => {
              const selected = starterHeroId === hero.id;
              const available = isHeroAvailable(hero.id);
              return (
                <button
                  key={hero.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={!available}
                  disabled={!available}
                  className={`flow-select-chip${selected ? " is-selected" : ""}${!available ? " is-disabled" : ""}`}
                  onClick={() => setStarterHero(hero.id)}
                >
                  <strong>{hero.displayName}</strong>
                  <span>{hero.role}</span>
                  {!available ? <small>준비중</small> : null}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="flow-checkbox">
          <input
            type="checkbox"
            checked={termsAccepted}
            onChange={(event) => setTermsAccepted(event.target.checked)}
          />
          <span>약관/개인정보 처리방침에 동의합니다.</span>
        </label>
        <p className="flow-legal-links">
          <a href="/legal/terms.html">약관 보기</a>
          <span>·</span>
          <a href="/legal/privacy.html">개인정보 처리방침 보기</a>
        </p>

        <button type="submit" className="flow-button flow-button--primary" disabled={!canSubmit}>
          온보딩 완료
        </button>
      </form>
    </section>
  );
}

function LobbyScreen(): JSX.Element {
  const selectedModeId = useAppFlowStore((state) => state.selectedModeId);
  const selectedHeroId = useAppFlowStore((state) => state.selectedHeroId);
  const isGuest = useAppFlowStore((state) => state.isGuest);
  const party = useAppFlowStore((state) => state.party);

  const setSelectedMode = useAppFlowStore((state) => state.setSelectedMode);
  const setSelectedHero = useAppFlowStore((state) => state.setSelectedHero);
  const requestQueueJoin = useAppFlowStore((state) => state.requestQueueJoin);

  const selectedModeComingSoon = isModeComingSoon(selectedModeId);

  return (
    <section className="flow-screen flow-screen--lobby" aria-label="로비 화면">
      <div className="flow-lobby-grid">
        <article className="flow-card">
          <h3>모드 선택</h3>
          <div className="flow-mode-list" role="radiogroup" aria-label="게임 모드 선택">
            {MATCH_MODE_OPTIONS.map((mode) => {
              const selected = mode.id === selectedModeId;
              const comingSoon = isModeComingSoon(mode.id);
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={comingSoon}
                  disabled={comingSoon}
                  className={`flow-mode-card${selected ? " is-selected" : ""}${comingSoon ? " is-disabled" : ""}`}
                  onClick={() => setSelectedMode(mode.id)}
                >
                  <strong>{mode.title}{comingSoon ? " · 준비중" : ""}</strong>
                  <span>{mode.subtitle}</span>
                  <small>{comingSoon ? "콘텐츠 준비중" : `예상 대기 ${mode.estimatedQueueSec}초`}</small>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="flow-button flow-button--primary"
            onClick={requestQueueJoin}
            disabled={selectedModeComingSoon || (selectedModeId === "3v3_rank" && isGuest)}
            aria-label="선택된 모드로 큐 진입"
          >
            빠른 시작
          </button>

          {selectedModeComingSoon ? (
            <p className="flow-muted">현재는 솔로 테스트/1v1 개발 모드만 플레이할 수 있습니다.</p>
          ) : null}
          {selectedModeId === "3v3_rank" && isGuest ? (
            <p className="flow-muted">게스트 계정은 랭크 모드를 시작할 수 없습니다.</p>
          ) : null}
        </article>

        <article className="flow-card">
          <h3>히어로 프리뷰</h3>
          <div className="flow-hero-grid">
            {HERO_DEFS.map((hero) => {
              const selected = hero.id === selectedHeroId;
              const available = isHeroAvailable(hero.id);
              return (
                <button
                  key={hero.id}
                  type="button"
                  aria-disabled={!available}
                  disabled={!available}
                  className={`flow-hero-card${selected ? " is-selected" : ""}${!available ? " is-disabled" : ""}`}
                  onClick={() => setSelectedHero(hero.id)}
                >
                  <strong>{hero.displayName}{!available ? " · 준비중" : ""}</strong>
                  <span>{hero.role}</span>
                  <small>{available ? `HP ${hero.baseHp.toLocaleString()}` : "리소스 준비중"}</small>
                </button>
              );
            })}
          </div>
          <p className="flow-muted">현재 플레이 가능 히어로: 코랄 캣 / 브루노 베어</p>
        </article>

        <aside className="flow-card flow-card--narrow">
          <h3>파티</h3>
          <ul className="flow-party-list">
            {party.members.length > 0
              ? party.members.map((member) => (
                <li key={member.accountId} className={member.accountId === party.leaderId ? "is-leader" : ""}>
                  {member.accountId}
                  {member.ready ? " · READY" : " · NOT READY"}
                </li>
              ))
              : [<li key="empty-1" className="is-empty">빈 슬롯</li>, <li key="empty-2" className="is-empty">빈 슬롯</li>, <li key="empty-3" className="is-empty">빈 슬롯</li>]}
          </ul>
          <button type="button" className="flow-button" disabled>
            친구 초대 (연동 예정)
          </button>
        </aside>
      </div>
    </section>
  );
}

function QueueScreen(): JSX.Element {
  const queue = useAppFlowStore((state) => state.queue);
  const requestQueueCancel = useAppFlowStore((state) => state.requestQueueCancel);

  return (
    <section className="flow-screen flow-screen--centered" aria-label="매칭 대기 화면">
      <div className="flow-card flow-card--compact">
        <h2 className="flow-title">매치 탐색 중…</h2>
        <p className="flow-subtitle">예상 대기 {queue.estimatedWaitSec}초</p>

        <dl className="flow-stat-grid">
          <div>
            <dt>경과 시간</dt>
            <dd>{formatDuration(queue.elapsedSec)}</dd>
          </div>
          <div>
            <dt>최대 핑</dt>
            <dd>{queue.searchRange.maxPingMs}ms</dd>
          </div>
          <div>
            <dt>SR 범위</dt>
            <dd>±{queue.searchRange.srRange}</dd>
          </div>
        </dl>

        <button type="button" className="flow-button" onClick={requestQueueCancel}>
          큐 취소
        </button>
      </div>
    </section>
  );
}

function ReadyCheckModal(): JSX.Element {
  const readyCheck = useAppFlowStore((state) => state.readyCheck);
  const requestMatchAccept = useAppFlowStore((state) => state.requestMatchAccept);

  const remainSec = Math.max(0, Math.ceil(readyCheck.remainingMs / 1000));

  return (
    <div className="flow-modal-backdrop" role="presentation">
      <section className="flow-modal" role="dialog" aria-modal="true" aria-labelledby="ready-check-title">
        <h3 id="ready-check-title">매치를 찾았습니다!</h3>
        <p>{remainSec}초 안에 수락해 주세요.</p>
        <p className="flow-muted">수락 상태: {readyCheck.acceptState}</p>
        <div className="flow-stack flow-stack--row">
          <button
            type="button"
            className="flow-button flow-button--primary"
            onClick={() => requestMatchAccept(true)}
            disabled={readyCheck.acceptState === "pending" || readyCheck.acceptState === "accepted"}
          >
            수락
          </button>
          <button type="button" className="flow-button" onClick={() => requestMatchAccept(false)}>
            거절
          </button>
        </div>
      </section>
    </div>
  );
}

function DraftScreen(): JSX.Element {
  const selectedHeroId = useAppFlowStore((state) => state.selectedHeroId);
  const draft = useAppFlowStore((state) => state.draft);

  const setDraftHoverHero = useAppFlowStore((state) => state.setDraftHoverHero);
  const requestDraftCommit = useAppFlowStore((state) => state.requestDraftCommit);

  const focusedHeroId = draft.myHoverHeroId ?? selectedHeroId;
  const focusedHero = HERO_DEF_BY_ID.get(focusedHeroId);
  const focusedHeroAvailable = Boolean(focusedHeroId) && isHeroAvailable(focusedHeroId);
  const canCommit = focusedHeroAvailable && !draft.myPendingAction && draft.isMyTurn;

  const warnings: string[] = [];
  if (focusedHero && focusedHero.role !== "Vanguard") {
    warnings.push("팀 조합 경고: 탱커가 부족할 수 있어요.");
  }
  if (focusedHero && focusedHero.role !== "Support" && focusedHero.role !== "SupportController") {
    warnings.push("회복/유틸 역할이 부족할 수 있어요.");
  }

  const turnToken = draft.currentTurnToken || getCurrentTurnToken(draft.turnOrder, draft.turnSeq);
  const actionLabel = draft.currentActionType;
  const turnTeamLabel = draft.currentTurnTeam === "teamB" ? "TEAM B" : "TEAM A";
  const myTeamLabel = draft.myTeamKey === null ? "확인 중" : draft.myTeamKey === "teamB" ? "TEAM B" : "TEAM A";
  const turnNotice = draft.isMyTurn ? "지금 내 차례" : "상대 팀 차례";

  return (
    <section className="flow-screen flow-screen--draft" aria-label="드래프트 화면">
      <div className="flow-card flow-card--wide">
        <header className="flow-draft-header">
          <h2>드래프트 · 턴 {draft.turnSeq}</h2>
          <strong className={draft.remainingSec <= 5 ? "flow-text-warn" : ""}>{draft.remainingSec}s</strong>
        </header>

        <div className={`flow-draft-turn-banner ${draft.isMyTurn ? "is-my-turn" : "is-waiting"}`}>
          <strong>{turnNotice}</strong>
          <span>{actionLabel} · {turnTeamLabel}</span>
          <span>내 팀: {myTeamLabel}</span>
          <span className="flow-draft-turn-token">{turnToken}</span>
        </div>

        <div className="flow-draft-grid">
          {HERO_DEFS.map((hero) => {
            const selected = hero.id === focusedHeroId;
            const available = isHeroAvailable(hero.id);
            const banned = draft.teamA.bans.includes(hero.id) || draft.teamB.bans.includes(hero.id);
            const picked = draft.teamA.picks.includes(hero.id) || draft.teamB.picks.includes(hero.id);
            const disabled = !available || banned || picked;

            return (
              <button
                key={hero.id}
                type="button"
                className={`flow-hero-card flow-hero-card--draft${selected ? " is-selected" : ""}${disabled ? " is-locked" : ""}`}
                onClick={() => setDraftHoverHero(hero.id)}
                aria-pressed={selected}
                aria-disabled={disabled}
                disabled={disabled}
              >
                <strong>{hero.displayName}{!available ? " · 준비중" : ""}</strong>
                <span>{hero.role}</span>
              </button>
            );
          })}
        </div>

        <div className="flow-draft-footer">
          <div className="flow-stack">
            <p className="flow-muted">선택: {focusedHero?.displayName ?? "미선택"}</p>
            {!focusedHeroAvailable && focusedHero ? <p className="flow-muted">{focusedHero.displayName}는 현재 준비중입니다.</p> : null}
            {!draft.isMyTurn ? <p className="flow-muted">지금은 {turnTeamLabel} 차례예요. 선픽만 정해두고 기다려 주세요.</p> : null}
            {draft.myPendingAction ? <p className="flow-muted">요청 전송됨 · 서버 확인 중…</p> : null}
            {warnings.map((warning) => (
              <p key={warning} className="flow-text-warn">{warning}</p>
            ))}
          </div>
          <button type="button" className="flow-button flow-button--primary" disabled={!canCommit} onClick={requestDraftCommit}>
            {draft.myPendingAction ? "전송 중..." : `${actionLabel} 확정`}
          </button>
        </div>
      </div>
    </section>
  );
}

function MatchLoadingScreen(): JSX.Element {
  const loading = useAppFlowStore((state) => state.loading);

  return (
    <section className="flow-screen flow-screen--centered" aria-label="매치 로딩 화면">
      <div className="flow-card flow-card--compact">
        <h2 className="flow-title">매치 로딩</h2>
        <p className="flow-subtitle">{getLoadingPhaseLabel(loading.phase)}</p>
        <div className="flow-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={loading.progressPct}>
          <span style={{ width: `${loading.progressPct}%` }} />
        </div>
        <p className="flow-muted">재시도 {loading.retryCount} · {loading.progressPct}%</p>
        <p className="flow-muted">룸: {loading.roomRegion ?? "-"} · {loading.mapId ?? "-"}</p>
      </div>
    </section>
  );
}

function ResultScreen(): JSX.Element {
  const result = useAppFlowStore((state) => state.result);
  const requestQueueJoin = useAppFlowStore((state) => state.requestQueueJoin);
  const requestRematchVote = useAppFlowStore((state) => state.requestRematchVote);
  const backToLobbyLocal = useAppFlowStore((state) => state.backToLobbyLocal);

  return (
    <section className="flow-screen flow-screen--centered" aria-label="결과 화면">
      <div className="flow-card flow-card--compact">
        <h2 className="flow-title">{result.outcome === "WIN" ? "VICTORY" : "DEFEAT"}</h2>
        <p className="flow-subtitle">점수 {result.teamScore} : {result.enemyScore}</p>

        <dl className="flow-stat-grid">
          <div>
            <dt>RP</dt>
            <dd>{result.rpDelta >= 0 ? `+${result.rpDelta}` : result.rpDelta}</dd>
          </div>
          <div>
            <dt>XP</dt>
            <dd>+{result.xp}</dd>
          </div>
          <div>
            <dt>PAW</dt>
            <dd>+{result.pawCoin}</dd>
          </div>
        </dl>

        {result.rematchVotes.length > 0 ? (
          <div className="flow-stack">
            {result.rematchVotes.map((voteRow) => (
              <p key={voteRow.accountId} className="flow-muted">
                {voteRow.accountId}: {voteRow.vote === null ? "대기" : voteRow.vote ? "찬성" : "거절"}
              </p>
            ))}
          </div>
        ) : null}

        <div className="flow-stack flow-stack--row">
          <button type="button" className="flow-button flow-button--primary" onClick={() => requestRematchVote(true)}>리매치</button>
          <button type="button" className="flow-button" onClick={requestQueueJoin}>다음 경기</button>
          <button type="button" className="flow-button" onClick={() => backToLobbyLocal()}>로비</button>
        </div>
      </div>
    </section>
  );
}

function ReconnectingOverlay(): JSX.Element {
  const reconnectState = useUiStore((state) => state.reconnectState);

  return (
    <div className="flow-modal-backdrop" role="presentation">
      <section className="flow-modal" role="dialog" aria-modal="true" aria-labelledby="reconnecting-title">
        <h3 id="reconnecting-title">연결 복구 중</h3>
        <p>{reconnectState}</p>
        <p className="flow-muted">네트워크가 복구되면 자동으로 전투에 재합류합니다.</p>
      </section>
    </div>
  );
}

function FlowContent({ flowState }: { flowState: AppFlowState }): JSX.Element | null {
  switch (flowState) {
    case "BOOT":
      return <BootScreen />;
    case "AUTH":
      return <AuthScreen />;
    case "ONBOARDING":
      return <OnboardingScreen />;
    case "LOBBY":
    case "PARTY":
      return <LobbyScreen />;
    case "QUEUEING":
      return <QueueScreen />;
    case "READY_CHECK":
      return (
        <>
          <QueueScreen />
          <ReadyCheckModal />
        </>
      );
    case "DRAFT":
      return <DraftScreen />;
    case "MATCH_LOADING":
      return <MatchLoadingScreen />;
    case "RESULT":
      return <ResultScreen />;
    case "RECONNECTING":
      return <ReconnectingOverlay />;
    case "IN_MATCH":
      return null;
    default:
      return null;
  }
}

export function AppFlowLayer(): JSX.Element {
  const flowState = useAppFlowStore((state) => state.flowState);
  const displayName = useAppFlowStore((state) => state.displayName);
  const systemNotice = useAppFlowStore((state) => state.systemNotice);
  const gatewayConnectionState = useAppFlowStore((state) => state.gatewayConnectionState);

  const pingMs = useUiStore((state) => state.pingMs);

  const showTopBar =
    flowState === "LOBBY" ||
    flowState === "PARTY" ||
    flowState === "QUEUEING" ||
    flowState === "RESULT";
  const showBottomNav =
    flowState === "LOBBY" ||
    flowState === "PARTY" ||
    flowState === "QUEUEING";

  return (
    <>
      <FlowRuntimeController />

      {showTopBar ? <LobbyTopBar displayName={displayName} pingMs={pingMs} gatewayState={gatewayConnectionState} /> : null}
      {showBottomNav ? <BottomNav /> : null}

      <FlowContent flowState={flowState} />

      {systemNotice ? <div className="flow-toast" role="status" aria-live="polite">{systemNotice}</div> : null}
    </>
  );
}
