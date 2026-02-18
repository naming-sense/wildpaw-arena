import { create } from "zustand";

export type AppFlowState =
  | "BOOT"
  | "AUTH"
  | "ONBOARDING"
  | "LOBBY"
  | "PARTY"
  | "QUEUEING"
  | "READY_CHECK"
  | "DRAFT"
  | "MATCH_LOADING"
  | "IN_MATCH"
  | "RESULT"
  | "RECONNECTING";

export type MatchModeId = "3v3_normal" | "3v3_rank" | "5v5_event";
export type BootPhase = "CHECK_VERSION" | "PROBE_REGION" | "RESTORE_SESSION" | "DONE" | "ERROR";
export type AcceptState = "idle" | "pending" | "accepted" | "declined";
export type MatchLoadingPhase = "ALLOCATING_ROOM" | "CONNECTING_ROOM" | "SYNCING_WORLD" | "READY";

export interface MatchModeOption {
  id: MatchModeId;
  title: string;
  subtitle: string;
  estimatedQueueSec: number;
}

export const MATCH_MODE_OPTIONS: MatchModeOption[] = [
  {
    id: "3v3_normal",
    title: "3v3 일반",
    subtitle: "빠른 픽 · 캐주얼",
    estimatedQueueSec: 6,
  },
  {
    id: "3v3_rank",
    title: "3v3 랭크",
    subtitle: "턴제 픽 · 경쟁전",
    estimatedQueueSec: 12,
  },
  {
    id: "5v5_event",
    title: "5v5 이벤트",
    subtitle: "대규모 교전",
    estimatedQueueSec: 10,
  },
];

interface QueueSearchRange {
  maxPingMs: number;
  srRange: number;
}

interface QueueState {
  queueTicketId: string | null;
  elapsedSec: number;
  estimatedWaitSec: number;
  searchRange: QueueSearchRange;
}

interface ReadyCheckState {
  matchCandidateId: string | null;
  deadlineAtMs: number;
  remainingMs: number;
  acceptState: AcceptState;
}

interface DraftState {
  turnSeq: number;
  remainingSec: number;
  myHoverHeroId: string | null;
  myLockedHeroId: string | null;
  autoPicked: boolean;
}

interface MatchLoadingState {
  phase: MatchLoadingPhase;
  progressPct: number;
  retryCount: number;
}

interface ResultState {
  outcome: "WIN" | "DEFEAT";
  teamScore: number;
  enemyScore: number;
  rpDelta: number;
  xp: number;
}

interface AppFlowStore {
  flowState: AppFlowState;
  previousFlowState: AppFlowState;
  bootPhase: BootPhase;
  bootProgressPct: number;
  displayName: string;
  isGuest: boolean;
  onboardingNickname: string;
  termsAccepted: boolean;
  onboardingStarterHeroIds: string[];
  selectedModeId: MatchModeId;
  selectedHeroId: string;
  queue: QueueState;
  readyCheck: ReadyCheckState;
  draft: DraftState;
  loading: MatchLoadingState;
  result: ResultState;
  systemNotice: string | null;

  setBootStep: (phase: BootPhase, progressPct: number) => void;
  completeBoot: () => void;
  failBoot: (message: string) => void;

  signInAsGuest: () => void;
  signInWithProvider: (provider: "google" | "apple") => void;

  setOnboardingNickname: (nickname: string) => void;
  setTermsAccepted: (accepted: boolean) => void;
  toggleStarterHero: (heroId: string) => void;
  completeOnboarding: () => void;

  setSelectedMode: (modeId: MatchModeId) => void;
  setSelectedHero: (heroId: string) => void;

  queueJoin: () => void;
  queueTick: () => void;
  queueMatchFound: () => void;
  queueCancel: () => void;

  readyCheckTick: (nowMs: number) => void;
  readyCheckAccept: () => void;
  readyCheckDecline: () => void;
  readyCheckTimeout: () => void;

  draftTick: () => void;
  draftHoverHero: (heroId: string) => void;
  draftLockHero: () => void;

  setMatchLoadingPhase: (phase: MatchLoadingPhase) => void;
  setMatchLoadingProgress: (progressPct: number) => void;
  bumpMatchLoadingRetry: () => void;
  enterInMatch: () => void;
  setReconnectingActive: (active: boolean) => void;

  finishMatch: (result?: Partial<ResultState>) => void;
  rematchVote: () => void;
  backToLobby: (notice?: string) => void;
  clearSystemNotice: () => void;
}

const DEFAULT_HERO_ID = "coral_cat";

function clampProgress(progressPct: number): number {
  return Math.min(100, Math.max(0, Math.round(progressPct)));
}

function buildTicket(prefix: string): string {
  const token = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${token}`;
}

function computeQueueSearchRange(elapsedSec: number): QueueSearchRange {
  if (elapsedSec < 20) {
    return { maxPingMs: 80, srRange: 70 };
  }
  if (elapsedSec < 45) {
    return { maxPingMs: 110, srRange: 120 };
  }
  return { maxPingMs: 140, srRange: 180 };
}

function computeEstimatedQueueWaitSec(modeId: MatchModeId, elapsedSec: number): number {
  const mode = MATCH_MODE_OPTIONS.find((option) => option.id === modeId);
  const baseline = mode?.estimatedQueueSec ?? 8;
  return Math.max(5, baseline + 9 - Math.floor(elapsedSec / 2));
}

function buildDefaultQueueState(): QueueState {
  return {
    queueTicketId: null,
    elapsedSec: 0,
    estimatedWaitSec: 8,
    searchRange: { maxPingMs: 80, srRange: 70 },
  };
}

function buildDefaultReadyCheckState(): ReadyCheckState {
  return {
    matchCandidateId: null,
    deadlineAtMs: 0,
    remainingMs: 0,
    acceptState: "idle",
  };
}

function buildDefaultDraftState(): DraftState {
  return {
    turnSeq: 1,
    remainingSec: 20,
    myHoverHeroId: null,
    myLockedHeroId: null,
    autoPicked: false,
  };
}

function buildDefaultLoadingState(): MatchLoadingState {
  return {
    phase: "ALLOCATING_ROOM",
    progressPct: 0,
    retryCount: 0,
  };
}

function buildDefaultResultState(): ResultState {
  return {
    outcome: "WIN",
    teamScore: 12,
    enemyScore: 9,
    rpDelta: 24,
    xp: 380,
  };
}

export const useAppFlowStore = create<AppFlowStore>((set, get) => ({
  flowState: "BOOT",
  previousFlowState: "BOOT",
  bootPhase: "CHECK_VERSION",
  bootProgressPct: 0,
  displayName: "Guest",
  isGuest: true,
  onboardingNickname: "",
  termsAccepted: false,
  onboardingStarterHeroIds: [DEFAULT_HERO_ID],
  selectedModeId: "3v3_normal",
  selectedHeroId: DEFAULT_HERO_ID,
  queue: buildDefaultQueueState(),
  readyCheck: buildDefaultReadyCheckState(),
  draft: buildDefaultDraftState(),
  loading: buildDefaultLoadingState(),
  result: buildDefaultResultState(),
  systemNotice: null,

  setBootStep: (phase, progressPct) => {
    set((state) => {
      if (state.flowState !== "BOOT") return state;
      return {
        ...state,
        bootPhase: phase,
        bootProgressPct: clampProgress(progressPct),
      };
    });
  },

  completeBoot: () => {
    set((state) => {
      if (state.flowState !== "BOOT") return state;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "AUTH",
        bootPhase: "DONE",
        bootProgressPct: 100,
      };
    });
  },

  failBoot: (message) => {
    set((state) => ({
      ...state,
      bootPhase: "ERROR",
      bootProgressPct: state.bootProgressPct,
      systemNotice: message,
    }));
  },

  signInAsGuest: () => {
    set((state) => ({
      ...state,
      previousFlowState: state.flowState,
      flowState: "ONBOARDING",
      displayName: "게스트",
      isGuest: true,
      systemNotice: "게스트로 시작합니다. 랭크는 로그인 계정에서만 가능해요.",
    }));
  },

  signInWithProvider: (provider) => {
    set((state) => ({
      ...state,
      previousFlowState: state.flowState,
      flowState: "ONBOARDING",
      displayName: provider === "google" ? "Google Player" : "Apple Player",
      isGuest: false,
      systemNotice: `${provider === "google" ? "Google" : "Apple"} 로그인 완료 (모의 흐름)`,
    }));
  },

  setOnboardingNickname: (nickname) => {
    set((state) => ({
      ...state,
      onboardingNickname: nickname.slice(0, 24),
    }));
  },

  setTermsAccepted: (accepted) => {
    set((state) => ({
      ...state,
      termsAccepted: accepted,
    }));
  },

  toggleStarterHero: (heroId) => {
    set((state) => {
      const exists = state.onboardingStarterHeroIds.includes(heroId);
      const next = exists
        ? state.onboardingStarterHeroIds.filter((id) => id !== heroId)
        : [...state.onboardingStarterHeroIds, heroId];

      return {
        ...state,
        onboardingStarterHeroIds: next,
        selectedHeroId: next[0] ?? state.selectedHeroId,
      };
    });
  },

  completeOnboarding: () => {
    set((state) => {
      const trimmedNickname = state.onboardingNickname.trim();
      const nicknameValid = trimmedNickname.length >= 2 && trimmedNickname.length <= 12;
      const hasStarter = state.onboardingStarterHeroIds.length > 0;
      if (!nicknameValid || !state.termsAccepted || !hasStarter) {
        return {
          ...state,
          systemNotice: "닉네임/약관/스타터 히어로를 확인해 주세요.",
        };
      }

      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "LOBBY",
        displayName: trimmedNickname,
        selectedHeroId: state.onboardingStarterHeroIds[0] ?? state.selectedHeroId,
        systemNotice: "온보딩 완료! 로비로 이동합니다.",
      };
    });
  },

  setSelectedMode: (modeId) => {
    set((state) => ({
      ...state,
      selectedModeId: modeId,
    }));
  },

  setSelectedHero: (heroId) => {
    set((state) => ({
      ...state,
      selectedHeroId: heroId,
    }));
  },

  queueJoin: () => {
    set((state) => {
      if (!["LOBBY", "PARTY", "RESULT"].includes(state.flowState)) {
        return state;
      }

      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "QUEUEING",
        queue: {
          queueTicketId: buildTicket("qt"),
          elapsedSec: 0,
          estimatedWaitSec: computeEstimatedQueueWaitSec(state.selectedModeId, 0),
          searchRange: computeQueueSearchRange(0),
        },
        readyCheck: buildDefaultReadyCheckState(),
        draft: buildDefaultDraftState(),
        loading: buildDefaultLoadingState(),
        systemNotice: null,
      };
    });
  },

  queueTick: () => {
    set((state) => {
      if (state.flowState !== "QUEUEING") return state;
      const elapsedSec = state.queue.elapsedSec + 1;
      return {
        ...state,
        queue: {
          ...state.queue,
          elapsedSec,
          estimatedWaitSec: computeEstimatedQueueWaitSec(state.selectedModeId, elapsedSec),
          searchRange: computeQueueSearchRange(elapsedSec),
        },
      };
    });
  },

  queueMatchFound: () => {
    set((state) => {
      if (state.flowState !== "QUEUEING") return state;
      const deadlineAtMs = Date.now() + 10_000;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "READY_CHECK",
        readyCheck: {
          matchCandidateId: buildTicket("mc"),
          deadlineAtMs,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          acceptState: "idle",
        },
      };
    });
  },

  queueCancel: () => {
    set((state) => {
      if (state.flowState !== "QUEUEING") return state;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "LOBBY",
        queue: buildDefaultQueueState(),
        systemNotice: "매칭 대기를 취소했습니다.",
      };
    });
  },

  readyCheckTick: (nowMs) => {
    set((state) => {
      if (state.flowState !== "READY_CHECK") return state;
      const remainingMs = Math.max(0, state.readyCheck.deadlineAtMs - nowMs);
      return {
        ...state,
        readyCheck: {
          ...state.readyCheck,
          remainingMs,
        },
      };
    });
  },

  readyCheckAccept: () => {
    set((state) => {
      if (state.flowState !== "READY_CHECK") return state;
      if (state.readyCheck.acceptState === "accepted") return state;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "DRAFT",
        readyCheck: {
          ...state.readyCheck,
          acceptState: "accepted",
          remainingMs: Math.max(0, state.readyCheck.deadlineAtMs - Date.now()),
        },
        draft: {
          turnSeq: 1,
          remainingSec: 20,
          myHoverHeroId: state.selectedHeroId,
          myLockedHeroId: null,
          autoPicked: false,
        },
      };
    });
  },

  readyCheckDecline: () => {
    set((state) => {
      if (state.flowState !== "READY_CHECK") return state;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "QUEUEING",
        queue: {
          queueTicketId: buildTicket("qt"),
          elapsedSec: 0,
          estimatedWaitSec: computeEstimatedQueueWaitSec(state.selectedModeId, 0),
          searchRange: computeQueueSearchRange(0),
        },
        readyCheck: {
          ...state.readyCheck,
          acceptState: "declined",
        },
        systemNotice: "수락이 취소되어 큐에 재진입했습니다.",
      };
    });
  },

  readyCheckTimeout: () => {
    set((state) => {
      if (state.flowState !== "READY_CHECK") return state;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "QUEUEING",
        queue: {
          queueTicketId: buildTicket("qt"),
          elapsedSec: 0,
          estimatedWaitSec: computeEstimatedQueueWaitSec(state.selectedModeId, 0),
          searchRange: computeQueueSearchRange(0),
        },
        readyCheck: {
          ...state.readyCheck,
          acceptState: "declined",
          remainingMs: 0,
        },
        systemNotice: "수락 시간이 만료되어 큐를 다시 탐색합니다.",
      };
    });
  },

  draftTick: () => {
    set((state) => {
      if (state.flowState !== "DRAFT") return state;

      const nextRemainingSec = Math.max(0, state.draft.remainingSec - 1);
      if (nextRemainingSec > 0) {
        return {
          ...state,
          draft: {
            ...state.draft,
            remainingSec: nextRemainingSec,
          },
        };
      }

      const autoPickedHeroId = state.draft.myHoverHeroId ?? state.selectedHeroId;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "MATCH_LOADING",
        selectedHeroId: autoPickedHeroId,
        draft: {
          ...state.draft,
          remainingSec: 0,
          myLockedHeroId: autoPickedHeroId,
          autoPicked: true,
        },
        loading: {
          phase: "ALLOCATING_ROOM",
          progressPct: 6,
          retryCount: 0,
        },
        systemNotice: "드래프트 시간이 만료되어 자동 픽이 적용됐어요.",
      };
    });
  },

  draftHoverHero: (heroId) => {
    set((state) => {
      if (state.flowState !== "DRAFT") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          myHoverHeroId: heroId,
        },
      };
    });
  },

  draftLockHero: () => {
    set((state) => {
      if (state.flowState !== "DRAFT") return state;
      const lockedHeroId = state.draft.myHoverHeroId ?? state.selectedHeroId;
      if (!lockedHeroId) return state;

      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "MATCH_LOADING",
        selectedHeroId: lockedHeroId,
        draft: {
          ...state.draft,
          myLockedHeroId: lockedHeroId,
          autoPicked: false,
        },
        loading: {
          phase: "ALLOCATING_ROOM",
          progressPct: 10,
          retryCount: 0,
        },
      };
    });
  },

  setMatchLoadingPhase: (phase) => {
    set((state) => {
      if (state.flowState !== "MATCH_LOADING") return state;
      return {
        ...state,
        loading: {
          ...state.loading,
          phase,
        },
      };
    });
  },

  setMatchLoadingProgress: (progressPct) => {
    set((state) => {
      if (state.flowState !== "MATCH_LOADING") return state;
      return {
        ...state,
        loading: {
          ...state.loading,
          progressPct: clampProgress(progressPct),
        },
      };
    });
  },

  bumpMatchLoadingRetry: () => {
    set((state) => {
      if (state.flowState !== "MATCH_LOADING") return state;
      return {
        ...state,
        loading: {
          ...state.loading,
          retryCount: state.loading.retryCount + 1,
        },
      };
    });
  },

  enterInMatch: () => {
    set((state) => {
      if (state.flowState !== "MATCH_LOADING") return state;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "IN_MATCH",
        loading: {
          ...state.loading,
          phase: "READY",
          progressPct: 100,
        },
      };
    });
  },

  setReconnectingActive: (active) => {
    set((state) => {
      if (active && state.flowState === "IN_MATCH") {
        return {
          ...state,
          previousFlowState: state.flowState,
          flowState: "RECONNECTING",
        };
      }
      if (!active && state.flowState === "RECONNECTING") {
        return {
          ...state,
          previousFlowState: state.flowState,
          flowState: "IN_MATCH",
        };
      }
      return state;
    });
  },

  finishMatch: (partialResult) => {
    set((state) => {
      if (!["IN_MATCH", "RECONNECTING"].includes(state.flowState)) return state;

      const randomTeamScore = 10 + Math.floor(Math.random() * 4);
      const randomEnemyScore = 8 + Math.floor(Math.random() * 4);
      const defaultOutcome: ResultState = {
        outcome: randomTeamScore >= randomEnemyScore ? "WIN" : "DEFEAT",
        teamScore: randomTeamScore,
        enemyScore: randomEnemyScore,
        rpDelta: randomTeamScore >= randomEnemyScore ? 24 : -12,
        xp: 320 + Math.floor(Math.random() * 120),
      };

      const nextResult: ResultState = {
        ...defaultOutcome,
        ...partialResult,
      };

      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "RESULT",
        result: nextResult,
      };
    });
  },

  rematchVote: () => {
    set((state) => {
      if (state.flowState !== "RESULT") return state;
      const deadlineAtMs = Date.now() + 8_000;
      return {
        ...state,
        previousFlowState: state.flowState,
        flowState: "READY_CHECK",
        readyCheck: {
          matchCandidateId: buildTicket("mc"),
          deadlineAtMs,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          acceptState: "idle",
        },
        systemNotice: "리매치 수락 확인을 시작합니다.",
      };
    });
  },

  backToLobby: (notice) => {
    set((state) => ({
      ...state,
      previousFlowState: state.flowState,
      flowState: "LOBBY",
      queue: buildDefaultQueueState(),
      readyCheck: buildDefaultReadyCheckState(),
      draft: buildDefaultDraftState(),
      loading: buildDefaultLoadingState(),
      result: buildDefaultResultState(),
      systemNotice: notice ?? null,
    }));
  },

  clearSystemNotice: () => {
    if (!get().systemNotice) return;
    set((state) => ({
      ...state,
      systemNotice: null,
    }));
  },
}));
