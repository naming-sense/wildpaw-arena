import { create } from "zustand";
import type { ControlEnvelope, GatewayConnectionState } from "../../net/controlGatewayClient";

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
  status: string | null;
  acceptedCount: number;
  requiredCount: number;
}

interface DraftTeamState {
  bans: string[];
  picks: string[];
  locked: string[];
}

interface DraftState {
  matchId: string | null;
  modeId: string | null;
  draftType: string;
  turnOrder: string[];
  turnSeq: number;
  remainingSec: number;
  timePerTurnSec: number;
  myHoverHeroId: string | null;
  myPendingAction: boolean;
  teamA: DraftTeamState;
  teamB: DraftTeamState;
}

interface LoadingState {
  matchId: string | null;
  phase: MatchLoadingPhase;
  progressPct: number;
  retryCount: number;
  roomEndpoint: string | null;
  roomToken: string | null;
  roomRegion: string | null;
  roomTokenExpiresAtMs: number | null;
  mapId: string | null;
  teamInfo: { teamId: number; slot: number } | null;
  reconnectWindowSec: number;
  roomConnectTimeoutSec: number;
  assignmentVersion: number;
}

interface ResultState {
  matchId: string | null;
  outcome: "WIN" | "DEFEAT";
  teamScore: number;
  enemyScore: number;
  rpDelta: number;
  xp: number;
  pawCoin: number;
  rematchVotes: Array<{ accountId: string; vote: boolean | null }>;
}

interface PartyState {
  partyId: string | null;
  leaderId: string | null;
  modeId: string;
  members: Array<{ accountId: string; ready: boolean }>;
}

interface GatewayTransport {
  send: (event: string, payload: unknown) => boolean;
}

let gatewayTransport: GatewayTransport | null = null;

export function bindGatewayTransport(transport: GatewayTransport | null): void {
  gatewayTransport = transport;
}

function sendControlEvent(event: string, payload: unknown): boolean {
  if (!gatewayTransport) return false;
  return gatewayTransport.send(event, payload);
}

const DEVICE_ID_STORAGE_KEY = "wildpaw-control-device-id";
const ONBOARDING_DRAFT_STORAGE_KEY = "wildpaw-onboarding-draft-v1";
const DEFAULT_HERO_ID = "coral_cat";

interface OnboardingDraftSnapshot {
  nickname: string;
  termsAccepted: boolean;
  starterHeroId: string;
  resume: boolean;
}

function readOnboardingDraft(): OnboardingDraftSnapshot | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(ONBOARDING_DRAFT_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<OnboardingDraftSnapshot> | null;
    if (!parsed || typeof parsed !== "object") return null;

    const nickname = typeof parsed.nickname === "string" ? parsed.nickname.slice(0, 24) : "";
    const termsAccepted = Boolean(parsed.termsAccepted);
    const starterHeroId =
      typeof parsed.starterHeroId === "string" && parsed.starterHeroId.trim().length > 0
        ? parsed.starterHeroId
        : DEFAULT_HERO_ID;
    const resume = Boolean(parsed.resume);

    return {
      nickname,
      termsAccepted,
      starterHeroId,
      resume,
    };
  } catch {
    return null;
  }
}

function writeOnboardingDraft(snapshot: OnboardingDraftSnapshot): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage failures
  }
}

function clearOnboardingDraft(): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(ONBOARDING_DRAFT_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

const initialOnboardingDraft = readOnboardingDraft();

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

function getOrCreateDeviceId(): string {
  const fallback = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  if (typeof window === "undefined") return fallback;

  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) return existing;

    const created = typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : fallback;
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return fallback;
  }
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function defaultQueueState(): QueueState {
  return {
    queueTicketId: null,
    elapsedSec: 0,
    estimatedWaitSec: 8,
    searchRange: {
      maxPingMs: 80,
      srRange: 70,
    },
  };
}

function defaultReadyCheckState(): ReadyCheckState {
  return {
    matchCandidateId: null,
    deadlineAtMs: 0,
    remainingMs: 0,
    acceptState: "idle",
    status: null,
    acceptedCount: 0,
    requiredCount: 0,
  };
}

function defaultDraftTeamState(): DraftTeamState {
  return {
    bans: [],
    picks: [],
    locked: [],
  };
}

function defaultDraftState(): DraftState {
  return {
    matchId: null,
    modeId: null,
    draftType: "TURN_BAN_PICK",
    turnOrder: [],
    turnSeq: 1,
    remainingSec: 20,
    timePerTurnSec: 20,
    myHoverHeroId: null,
    myPendingAction: false,
    teamA: defaultDraftTeamState(),
    teamB: defaultDraftTeamState(),
  };
}

function defaultLoadingState(): LoadingState {
  return {
    matchId: null,
    phase: "ALLOCATING_ROOM",
    progressPct: 0,
    retryCount: 0,
    roomEndpoint: null,
    roomToken: null,
    roomRegion: null,
    roomTokenExpiresAtMs: null,
    mapId: null,
    teamInfo: null,
    reconnectWindowSec: 20,
    roomConnectTimeoutSec: 8,
    assignmentVersion: 0,
  };
}

function defaultResultState(): ResultState {
  return {
    matchId: null,
    outcome: "WIN",
    teamScore: 0,
    enemyScore: 0,
    rpDelta: 0,
    xp: 0,
    pawCoin: 0,
    rematchVotes: [],
  };
}

function defaultPartyState(): PartyState {
  return {
    partyId: null,
    leaderId: null,
    modeId: "3v3_normal",
    members: [],
  };
}

function asFlowState(value: unknown): AppFlowState | null {
  if (typeof value !== "string") return null;
  const candidates: AppFlowState[] = [
    "BOOT",
    "AUTH",
    "ONBOARDING",
    "LOBBY",
    "PARTY",
    "QUEUEING",
    "READY_CHECK",
    "DRAFT",
    "MATCH_LOADING",
    "IN_MATCH",
    "RESULT",
    "RECONNECTING",
  ];
  return candidates.includes(value as AppFlowState) ? (value as AppFlowState) : null;
}

function normalizeOutcome(value: unknown): "WIN" | "DEFEAT" {
  const upper = typeof value === "string" ? value.toUpperCase() : "";
  if (upper === "WIN") return "WIN";
  return "DEFEAT";
}

function toReadableErrorMessage(payload: Record<string, unknown>): string {
  const code = typeof payload.errorCode === "string" ? payload.errorCode : "UNKNOWN";
  const message = typeof payload.message === "string" ? payload.message : "오류가 발생했습니다.";
  return `[${code}] ${message}`;
}

interface AppFlowStore {
  flowState: AppFlowState;
  previousFlowState: AppFlowState;
  bootPhase: BootPhase;
  bootProgressPct: number;
  bootRequestPending: boolean;

  gatewayConnectionState: GatewayConnectionState;

  accountId: string | null;
  sessionId: string | null;
  displayName: string;
  isGuest: boolean;

  onboardingNickname: string;
  termsAccepted: boolean;
  onboardingStarterHeroId: string;
  resumeOnboardingFromDraft: boolean;

  selectedModeId: MatchModeId;
  selectedHeroId: string;

  party: PartyState;
  queue: QueueState;
  readyCheck: ReadyCheckState;
  draft: DraftState;
  loading: LoadingState;
  result: ResultState;

  systemNotice: string | null;

  setGatewayConnectionState: (state: GatewayConnectionState) => void;
  applyGatewayEnvelope: (envelope: ControlEnvelope) => void;
  requestBootReady: () => void;
  requestPing: () => void;

  requestAuthGuest: () => void;
  requestAuthProvider: (provider: "google" | "apple") => void;

  setOnboardingNickname: (nickname: string) => void;
  setTermsAccepted: (accepted: boolean) => void;
  setStarterHero: (heroId: string) => void;
  requestSubmitOnboarding: () => void;

  setSelectedMode: (modeId: MatchModeId) => void;
  setSelectedHero: (heroId: string) => void;

  requestQueueJoin: () => void;
  requestQueueCancel: () => void;

  requestMatchAccept: (accept: boolean) => void;
  tickReadyCheckCountdown: (nowMs: number) => void;

  setDraftHoverHero: (heroId: string) => void;
  requestDraftCommit: () => void;
  tickDraftCountdown: () => void;

  setLoadingVisual: (phase: MatchLoadingPhase, progressPct: number) => void;
  bumpLoadingRetry: () => void;
  reportRoomConnectResult: (status: "OK" | "FAIL") => void;

  setRealtimeConnectionState: (reconnectState: string) => void;

  requestRematchVote: (vote?: boolean) => void;
  backToLobbyLocal: (notice?: string) => void;

  clearSystemNotice: () => void;
}

export const useAppFlowStore = create<AppFlowStore>((set, get) => ({
  flowState: "BOOT",
  previousFlowState: "BOOT",
  bootPhase: "CHECK_VERSION",
  bootProgressPct: 0,
  bootRequestPending: false,

  gatewayConnectionState: "Disconnected",

  accountId: null,
  sessionId: null,
  displayName: "Guest",
  isGuest: true,

  onboardingNickname: initialOnboardingDraft?.nickname ?? "",
  termsAccepted: initialOnboardingDraft?.termsAccepted ?? false,
  onboardingStarterHeroId: initialOnboardingDraft?.starterHeroId ?? DEFAULT_HERO_ID,
  resumeOnboardingFromDraft: initialOnboardingDraft?.resume ?? false,

  selectedModeId: "3v3_normal",
  selectedHeroId: DEFAULT_HERO_ID,

  party: defaultPartyState(),
  queue: defaultQueueState(),
  readyCheck: defaultReadyCheckState(),
  draft: defaultDraftState(),
  loading: defaultLoadingState(),
  result: defaultResultState(),

  systemNotice: null,

  setGatewayConnectionState: (gatewayConnectionState) => {
    set((state) => {
      const nextNotice =
        gatewayConnectionState === "Failed"
          ? "Gateway 연결에 실패했습니다. 서버를 확인해 주세요."
          : state.systemNotice;

      return {
        ...state,
        gatewayConnectionState,
        systemNotice: nextNotice,
      };
    });
  },

  applyGatewayEnvelope: (envelope) => {
    set((state) => {
      const payload =
        envelope.payload && typeof envelope.payload === "object"
          ? (envelope.payload as Record<string, unknown>)
          : {};

      const sessionId = envelope.sessionId ?? state.sessionId;
      const baseState = {
        ...state,
        sessionId,
      };

      switch (envelope.event) {
        case "S2C_HELLO": {
          return {
            ...baseState,
            systemNotice: "Gateway control channel 연결됨",
          };
        }

        case "S2C_FLOW_STATE": {
          const nextFlow = asFlowState(payload.state);
          if (!nextFlow) return baseState;
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: nextFlow,
          };
        }

        case "S2C_BOOT_ACK": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "AUTH",
            bootPhase: "DONE",
            bootProgressPct: 100,
            bootRequestPending: false,
            systemNotice: null,
          };
        }

        case "S2C_FORCE_UPDATE": {
          const minVersion = typeof payload.minVersion === "string" ? payload.minVersion : "";
          return {
            ...baseState,
            bootPhase: "ERROR",
            bootRequestPending: false,
            systemNotice: `강제 업데이트 필요 (min ${minVersion || "unknown"})`,
          };
        }

        case "S2C_AUTH_OK": {
          const accountId = typeof payload.accountId === "string" ? payload.accountId : null;
          const displayName = typeof payload.displayName === "string" ? payload.displayName : "Player";
          const isFirstUser = Boolean(payload.isFirstUser);
          const flowState = isFirstUser ? "ONBOARDING" : "LOBBY";

          if (isFirstUser) {
            writeOnboardingDraft({
              nickname: baseState.onboardingNickname,
              termsAccepted: baseState.termsAccepted,
              starterHeroId: baseState.onboardingStarterHeroId,
              resume: true,
            });
          } else {
            clearOnboardingDraft();
          }

          return {
            ...baseState,
            accountId,
            displayName,
            isGuest: accountId?.startsWith("guest_") ?? true,
            previousFlowState: baseState.flowState,
            flowState,
            resumeOnboardingFromDraft: isFirstUser,
            systemNotice: isFirstUser
              ? "온보딩을 진행해 주세요."
              : "로그인 완료. 로비로 이동합니다.",
          };
        }

        case "S2C_AUTH_FAIL": {
          return {
            ...baseState,
            systemNotice: toReadableErrorMessage(payload),
          };
        }

        case "S2C_ONBOARDING_SAVED": {
          const nickname = typeof payload.nickname === "string" ? payload.nickname : baseState.displayName;
          clearOnboardingDraft();

          return {
            ...baseState,
            displayName: nickname,
            previousFlowState: baseState.flowState,
            flowState: "LOBBY",
            resumeOnboardingFromDraft: false,
            systemNotice: "온보딩 저장 완료",
          };
        }

        case "S2C_PARTY_STATE": {
          const membersRaw = Array.isArray(payload.members) ? payload.members : [];
          const members = membersRaw
            .map((row) => {
              if (!row || typeof row !== "object") return null;
              const accountId = typeof (row as Record<string, unknown>).accountId === "string"
                ? (row as Record<string, unknown>).accountId as string
                : null;
              if (!accountId) return null;
              return {
                accountId,
                ready: Boolean((row as Record<string, unknown>).ready),
              };
            })
            .filter((row): row is { accountId: string; ready: boolean } => Boolean(row));

          const nextFlow = members.length > 0 ? "PARTY" : baseState.flowState;

          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: nextFlow,
            party: {
              partyId: typeof payload.partyId === "string" ? payload.partyId : null,
              leaderId: typeof payload.leaderId === "string" ? payload.leaderId : null,
              modeId: typeof payload.modeId === "string" ? payload.modeId : baseState.selectedModeId,
              members,
            },
          };
        }

        case "S2C_PARTY_LEFT": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "LOBBY",
            party: defaultPartyState(),
          };
        }

        case "S2C_QUEUE_JOINED": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "QUEUEING",
            queue: {
              ...baseState.queue,
              queueTicketId: typeof payload.queueTicketId === "string" ? payload.queueTicketId : baseState.queue.queueTicketId,
              elapsedSec: 0,
            },
            readyCheck: defaultReadyCheckState(),
            draft: defaultDraftState(),
            loading: defaultLoadingState(),
            systemNotice: null,
          };
        }

        case "S2C_QUEUE_STATUS": {
          return {
            ...baseState,
            queue: {
              queueTicketId:
                typeof payload.queueTicketId === "string" ? payload.queueTicketId : baseState.queue.queueTicketId,
              elapsedSec: typeof payload.elapsedSec === "number" ? payload.elapsedSec : baseState.queue.elapsedSec,
              estimatedWaitSec:
                typeof payload.estimatedWaitSec === "number"
                  ? payload.estimatedWaitSec
                  : baseState.queue.estimatedWaitSec,
              searchRange: {
                maxPingMs:
                  payload.searchRange && typeof payload.searchRange === "object" &&
                  typeof (payload.searchRange as Record<string, unknown>).maxPingMs === "number"
                    ? (payload.searchRange as Record<string, unknown>).maxPingMs as number
                    : baseState.queue.searchRange.maxPingMs,
                srRange:
                  payload.searchRange && typeof payload.searchRange === "object" &&
                  typeof (payload.searchRange as Record<string, unknown>).srRange === "number"
                    ? (payload.searchRange as Record<string, unknown>).srRange as number
                    : baseState.queue.searchRange.srRange,
              },
            },
          };
        }

        case "S2C_QUEUE_CANCELLED": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "LOBBY",
            queue: defaultQueueState(),
            systemNotice: "큐 취소 완료",
          };
        }

        case "S2C_MATCH_FOUND": {
          const acceptDeadlineSec = typeof payload.acceptDeadlineSec === "number" ? payload.acceptDeadlineSec : 10;
          const deadlineAtMs = Date.now() + acceptDeadlineSec * 1000;
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "READY_CHECK",
            readyCheck: {
              matchCandidateId:
                typeof payload.matchCandidateId === "string" ? payload.matchCandidateId : baseState.readyCheck.matchCandidateId,
              deadlineAtMs,
              remainingMs: Math.max(0, deadlineAtMs - Date.now()),
              acceptState: "idle",
              status: null,
              acceptedCount: 0,
              requiredCount:
                typeof payload.requiredCount === "number" ? payload.requiredCount : baseState.readyCheck.requiredCount,
            },
          };
        }

        case "S2C_MATCH_ACCEPT_ACK": {
          const accepted = Boolean(payload.accepted);
          return {
            ...baseState,
            readyCheck: {
              ...baseState.readyCheck,
              acceptState: accepted ? "accepted" : "declined",
            },
          };
        }

        case "S2C_READY_CHECK_RESULT": {
          const status = typeof payload.status === "string" ? payload.status : null;
          const acceptedCount = typeof payload.acceptedCount === "number" ? payload.acceptedCount : baseState.readyCheck.acceptedCount;
          const requiredCount = typeof payload.requiredCount === "number" ? payload.requiredCount : baseState.readyCheck.requiredCount;

          return {
            ...baseState,
            readyCheck: {
              ...baseState.readyCheck,
              status,
              acceptedCount,
              requiredCount,
            },
            systemNotice:
              status === "ALL_ACCEPTED"
                ? "전원 수락 완료. 드래프트 시작 대기 중"
                : `레디체크 실패 (${status ?? "UNKNOWN"})`,
          };
        }

        case "S2C_QUEUE_PENALTY_APPLIED": {
          const remainingSec = typeof payload.remainingSec === "number" ? payload.remainingSec : 0;
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "LOBBY",
            queue: defaultQueueState(),
            readyCheck: defaultReadyCheckState(),
            systemNotice: `큐 페널티 적용 (${remainingSec}s)`,
          };
        }

        case "S2C_DRAFT_START": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "DRAFT",
            draft: {
              ...defaultDraftState(),
              matchId: typeof payload.matchId === "string" ? payload.matchId : baseState.draft.matchId,
              modeId: typeof payload.modeId === "string" ? payload.modeId : null,
              draftType: typeof payload.draftType === "string" ? payload.draftType : "TURN_BAN_PICK",
              turnOrder: Array.isArray(payload.turnOrder)
                ? payload.turnOrder.filter((entry): entry is string => typeof entry === "string")
                : [],
              turnSeq: 1,
              remainingSec: typeof payload.timePerTurnSec === "number" ? payload.timePerTurnSec : 20,
              timePerTurnSec: typeof payload.timePerTurnSec === "number" ? payload.timePerTurnSec : 20,
              myHoverHeroId: baseState.selectedHeroId,
            },
            systemNotice: null,
          };
        }

        case "S2C_DRAFT_STATE": {
          const teamA = payload.teamA && typeof payload.teamA === "object"
            ? payload.teamA as Record<string, unknown>
            : null;
          const teamB = payload.teamB && typeof payload.teamB === "object"
            ? payload.teamB as Record<string, unknown>
            : null;

          return {
            ...baseState,
            draft: {
              ...baseState.draft,
              matchId: typeof payload.matchId === "string" ? payload.matchId : baseState.draft.matchId,
              turnSeq: typeof payload.turnSeq === "number" ? payload.turnSeq : baseState.draft.turnSeq,
              remainingSec: typeof payload.remainingSec === "number" ? payload.remainingSec : baseState.draft.remainingSec,
              myPendingAction: false,
              teamA: {
                bans: Array.isArray(teamA?.bans) ? teamA?.bans.filter((entry): entry is string => typeof entry === "string") : baseState.draft.teamA.bans,
                picks: Array.isArray(teamA?.picks) ? teamA?.picks.filter((entry): entry is string => typeof entry === "string") : baseState.draft.teamA.picks,
                locked: Array.isArray(teamA?.locked) ? teamA?.locked.filter((entry): entry is string => typeof entry === "string") : baseState.draft.teamA.locked,
              },
              teamB: {
                bans: Array.isArray(teamB?.bans) ? teamB?.bans.filter((entry): entry is string => typeof entry === "string") : baseState.draft.teamB.bans,
                picks: Array.isArray(teamB?.picks) ? teamB?.picks.filter((entry): entry is string => typeof entry === "string") : baseState.draft.teamB.picks,
                locked: Array.isArray(teamB?.locked) ? teamB?.locked.filter((entry): entry is string => typeof entry === "string") : baseState.draft.teamB.locked,
              },
            },
          };
        }

        case "S2C_DRAFT_TIMEOUT_AUTOPICK": {
          const pickedHeroId = typeof payload.pickedHeroId === "string" ? payload.pickedHeroId : null;
          const accountId = typeof payload.accountId === "string" ? payload.accountId : null;
          const mine = accountId !== null && accountId === baseState.accountId;

          return {
            ...baseState,
            selectedHeroId: mine && pickedHeroId ? pickedHeroId : baseState.selectedHeroId,
            systemNotice: `드래프트 시간 초과: ${pickedHeroId ?? "unknown"} 자동 선택`,
          };
        }

        case "S2C_DRAFT_ACTION_ACK": {
          return {
            ...baseState,
            draft: {
              ...baseState.draft,
              myPendingAction: false,
            },
          };
        }

        case "S2C_MATCH_ASSIGN": {
          const room = payload.room && typeof payload.room === "object"
            ? payload.room as Record<string, unknown>
            : null;
          const teamInfo = payload.teamInfo && typeof payload.teamInfo === "object"
            ? payload.teamInfo as Record<string, unknown>
            : null;

          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "MATCH_LOADING",
            loading: {
              matchId: typeof payload.matchId === "string" ? payload.matchId : baseState.loading.matchId,
              phase: "ALLOCATING_ROOM",
              progressPct: 12,
              retryCount: 0,
              roomEndpoint: typeof room?.endpoint === "string" ? room.endpoint : null,
              roomToken: typeof room?.roomToken === "string" ? room.roomToken : null,
              roomRegion: typeof room?.region === "string" ? room.region : null,
              roomTokenExpiresAtMs:
                typeof room?.expiresAtMs === "number" ? room.expiresAtMs : null,
              mapId: typeof payload.mapId === "string" ? payload.mapId : null,
              teamInfo:
                typeof teamInfo?.teamId === "number" && typeof teamInfo?.slot === "number"
                  ? { teamId: teamInfo.teamId, slot: teamInfo.slot }
                  : null,
              reconnectWindowSec:
                typeof payload.reconnectWindowSec === "number" ? payload.reconnectWindowSec : baseState.loading.reconnectWindowSec,
              roomConnectTimeoutSec:
                typeof payload.roomConnectTimeoutSec === "number" ? payload.roomConnectTimeoutSec : baseState.loading.roomConnectTimeoutSec,
              assignmentVersion: baseState.loading.assignmentVersion + 1,
            },
            systemNotice: "룸 할당 완료. 서버 연결 중…",
          };
        }

        case "S2C_MATCH_ASSIGN_RETRY": {
          const room = payload.room && typeof payload.room === "object"
            ? payload.room as Record<string, unknown>
            : null;

          return {
            ...baseState,
            flowState: "MATCH_LOADING",
            loading: {
              ...baseState.loading,
              phase: "CONNECTING_ROOM",
              retryCount: typeof payload.retryCount === "number" ? payload.retryCount : baseState.loading.retryCount + 1,
              roomEndpoint: typeof room?.endpoint === "string" ? room.endpoint : baseState.loading.roomEndpoint,
              roomToken: typeof room?.roomToken === "string" ? room.roomToken : baseState.loading.roomToken,
              roomRegion: typeof room?.region === "string" ? room.region : baseState.loading.roomRegion,
              roomTokenExpiresAtMs:
                typeof room?.expiresAtMs === "number" ? room.expiresAtMs : baseState.loading.roomTokenExpiresAtMs,
              assignmentVersion: baseState.loading.assignmentVersion + 1,
            },
            systemNotice: "룸 연결 재시도 토큰 수신",
          };
        }

        case "S2C_QUEUE_RECOVERY": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "LOBBY",
            loading: defaultLoadingState(),
            systemNotice: "룸 연결 실패로 로비에 복귀했습니다.",
          };
        }

        case "S2C_ROOM_CONNECT_CONFIRMED": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "IN_MATCH",
            loading: {
              ...baseState.loading,
              phase: "READY",
              progressPct: 100,
            },
            systemNotice: null,
          };
        }

        case "S2C_RECONNECT_WINDOW": {
          const reconnectWindowSec = typeof payload.reconnectWindowSec === "number" ? payload.reconnectWindowSec : baseState.loading.reconnectWindowSec;
          return {
            ...baseState,
            loading: {
              ...baseState.loading,
              reconnectWindowSec,
            },
            systemNotice: `팀원이 연결 끊김 (복귀 창 ${reconnectWindowSec}s)`,
          };
        }

        case "S2C_MATCH_ENDED": {
          const rewards = payload.rewards && typeof payload.rewards === "object"
            ? payload.rewards as Record<string, unknown>
            : null;
          const score = payload.score && typeof payload.score === "object"
            ? payload.score as Record<string, unknown>
            : null;
          const currency = rewards?.currency && typeof rewards.currency === "object"
            ? rewards.currency as Record<string, unknown>
            : null;

          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "RESULT",
            result: {
              matchId: typeof payload.matchId === "string" ? payload.matchId : baseState.loading.matchId,
              outcome: normalizeOutcome(payload.result),
              teamScore: typeof score?.teamA === "number" ? score.teamA : 0,
              enemyScore: typeof score?.teamB === "number" ? score.teamB : 0,
              rpDelta: typeof rewards?.rpDelta === "number" ? rewards.rpDelta : 0,
              xp: typeof rewards?.xp === "number" ? rewards.xp : 0,
              pawCoin: typeof currency?.pawCoin === "number" ? currency.pawCoin : 0,
              rematchVotes: [],
            },
            loading: defaultLoadingState(),
            queue: defaultQueueState(),
            readyCheck: defaultReadyCheckState(),
            draft: defaultDraftState(),
            systemNotice: null,
          };
        }

        case "S2C_REMATCH_STATE": {
          const votesRaw = Array.isArray(payload.votes) ? payload.votes : [];
          const votes = votesRaw
            .map((row) => {
              if (!row || typeof row !== "object") return null;
              const accountId = typeof (row as Record<string, unknown>).accountId === "string"
                ? (row as Record<string, unknown>).accountId as string
                : null;
              if (!accountId) return null;

              const voteRaw = (row as Record<string, unknown>).vote;
              const vote = typeof voteRaw === "boolean" ? voteRaw : null;

              return {
                accountId,
                vote,
              };
            })
            .filter((row): row is { accountId: string; vote: boolean | null } => Boolean(row));

          return {
            ...baseState,
            result: {
              ...baseState.result,
              rematchVotes: votes,
            },
          };
        }

        case "S2C_REMATCH_START": {
          return {
            ...baseState,
            systemNotice: "리매치 준비 중…",
          };
        }

        case "S2C_REMATCH_CANCELLED": {
          return {
            ...baseState,
            previousFlowState: baseState.flowState,
            flowState: "LOBBY",
            result: defaultResultState(),
            systemNotice: "리매치가 취소되어 로비로 이동합니다.",
          };
        }

        case "S2C_PONG": {
          return baseState;
        }

        case "S2C_ERROR": {
          return {
            ...baseState,
            systemNotice: toReadableErrorMessage(payload),
          };
        }

        default:
          return baseState;
      }
    });
  },

  requestBootReady: () => {
    const state = get();
    if (state.flowState !== "BOOT") return;

    const sent = sendControlEvent("C2S_BOOT_READY", {
      appVersion: "0.2.1",
      platform: "web",
      locale: typeof navigator !== "undefined" ? navigator.language : "ko-KR",
      regionCandidates: ["KR", "JP", "SG"],
    });

    set((prev) => ({
      ...prev,
      bootRequestPending: sent,
      bootPhase: sent ? "RESTORE_SESSION" : "ERROR",
      bootProgressPct: sent ? 62 : prev.bootProgressPct,
      systemNotice: sent ? null : "Gateway 연결이 없어 부트를 진행할 수 없습니다.",
    }));
  },

  requestPing: () => {
    sendControlEvent("C2S_PING", {
      nowMs: Date.now(),
    });
  },

  requestAuthGuest: () => {
    const state = get();
    if (state.flowState !== "AUTH") return;

    const sent = sendControlEvent("C2S_AUTH_GUEST", {
      deviceId: getOrCreateDeviceId(),
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "Gateway 연결이 끊겨 로그인 요청을 보낼 수 없어요.",
      }));
    }
  },

  requestAuthProvider: (provider) => {
    const state = get();
    if (state.flowState !== "AUTH") return;

    const providerName = provider === "google" ? "Google" : "Apple";
    set((prev) => ({
      ...prev,
      systemNotice: `${providerName} 로그인은 준비 중입니다. 현재는 게스트 시작만 지원합니다.`,
    }));
  },

  setOnboardingNickname: (nickname) => {
    set((state) => {
      const nextNickname = nickname.slice(0, 24);
      writeOnboardingDraft({
        nickname: nextNickname,
        termsAccepted: state.termsAccepted,
        starterHeroId: state.onboardingStarterHeroId,
        resume: true,
      });

      return {
        ...state,
        onboardingNickname: nextNickname,
        resumeOnboardingFromDraft: true,
      };
    });
  },

  setTermsAccepted: (accepted) => {
    set((state) => {
      writeOnboardingDraft({
        nickname: state.onboardingNickname,
        termsAccepted: accepted,
        starterHeroId: state.onboardingStarterHeroId,
        resume: true,
      });

      return {
        ...state,
        termsAccepted: accepted,
        resumeOnboardingFromDraft: true,
      };
    });
  },

  setStarterHero: (heroId) => {
    set((state) => {
      writeOnboardingDraft({
        nickname: state.onboardingNickname,
        termsAccepted: state.termsAccepted,
        starterHeroId: heroId,
        resume: true,
      });

      return {
        ...state,
        onboardingStarterHeroId: heroId,
        selectedHeroId: heroId,
        resumeOnboardingFromDraft: true,
      };
    });
  },

  requestSubmitOnboarding: () => {
    const state = get();
    if (state.flowState !== "ONBOARDING") return;

    const nickname = state.onboardingNickname.trim();
    const nicknameValid = nickname.length >= 2 && nickname.length <= 12;
    const hasStarter = state.onboardingStarterHeroId.trim().length > 0;

    if (!nicknameValid || !state.termsAccepted || !hasStarter) {
      set((prev) => ({
        ...prev,
        systemNotice: "닉네임/약관/스타터 히어로를 확인해 주세요.",
      }));
      return;
    }

    const sent = sendControlEvent("C2S_ONBOARDING_COMPLETE", {
      nickname,
      tutorialDone: true,
      starterHeroIds: [state.onboardingStarterHeroId],
      acceptedTermsVersion: "2026-02",
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "온보딩 저장 요청 전송에 실패했습니다.",
      }));
    }
  },

  setSelectedMode: (selectedModeId) => {
    set((state) => ({
      ...state,
      selectedModeId,
      party: {
        ...state.party,
        modeId: selectedModeId,
      },
    }));
  },

  setSelectedHero: (selectedHeroId) => {
    set((state) => ({
      ...state,
      selectedHeroId,
    }));
  },

  requestQueueJoin: () => {
    const state = get();

    if (!["LOBBY", "PARTY", "RESULT"].includes(state.flowState)) {
      return;
    }

    if (state.selectedModeId === "3v3_rank" && state.isGuest) {
      set((prev) => ({
        ...prev,
        systemNotice: "게스트 계정은 랭크 모드를 시작할 수 없습니다.",
      }));
      return;
    }

    const sent = sendControlEvent("C2S_QUEUE_JOIN", {
      modeId: state.selectedModeId,
      regionPreference: "KR",
      partyId: state.party.partyId,
      inputDevice: "kbm",
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "큐 요청 전송에 실패했습니다.",
      }));
    }
  },

  requestQueueCancel: () => {
    const state = get();
    if (!["QUEUEING", "READY_CHECK"].includes(state.flowState)) return;

    const sent = sendControlEvent("C2S_QUEUE_CANCEL", {
      queueTicketId: state.queue.queueTicketId,
      reason: "user_cancel",
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "큐 취소 요청 전송에 실패했습니다.",
      }));
    }
  },

  requestMatchAccept: (accept) => {
    const state = get();
    if (state.flowState !== "READY_CHECK") return;
    if (!state.readyCheck.matchCandidateId) return;

    const sent = sendControlEvent("C2S_MATCH_ACCEPT", {
      matchCandidateId: state.readyCheck.matchCandidateId,
      accept,
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "매치 수락 요청 전송에 실패했습니다.",
      }));
      return;
    }

    set((prev) => ({
      ...prev,
      readyCheck: {
        ...prev.readyCheck,
        acceptState: accept ? "pending" : "declined",
      },
    }));
  },

  tickReadyCheckCountdown: (nowMs) => {
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

  setDraftHoverHero: (heroId) => {
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

  requestDraftCommit: () => {
    const state = get();
    if (state.flowState !== "DRAFT") return;
    if (!state.draft.matchId) return;

    const heroId = state.draft.myHoverHeroId ?? state.selectedHeroId;
    if (!heroId) return;

    const turnToken =
      state.draft.turnOrder[(state.draft.turnSeq - 1) % Math.max(1, state.draft.turnOrder.length)] ??
      "teamA_pick";
    const actionType = turnToken.toLowerCase().includes("ban") ? "BAN" : "PICK";

    const sent = sendControlEvent("C2S_DRAFT_ACTION", {
      matchId: state.draft.matchId,
      actionType,
      heroId,
      turnSeq: state.draft.turnSeq,
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "드래프트 액션 요청 전송에 실패했습니다.",
      }));
      return;
    }

    set((prev) => ({
      ...prev,
      selectedHeroId: heroId,
      draft: {
        ...prev.draft,
        myPendingAction: true,
      },
    }));
  },

  tickDraftCountdown: () => {
    set((state) => {
      if (state.flowState !== "DRAFT") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          remainingSec: Math.max(0, state.draft.remainingSec - 1),
        },
      };
    });
  },

  setLoadingVisual: (phase, progressPct) => {
    set((state) => {
      if (state.flowState !== "MATCH_LOADING") return state;
      return {
        ...state,
        loading: {
          ...state.loading,
          phase,
          progressPct: clampProgress(progressPct),
        },
      };
    });
  },

  bumpLoadingRetry: () => {
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

  reportRoomConnectResult: (status) => {
    const state = get();
    if (!state.loading.matchId) return;

    const sent = sendControlEvent("C2S_ROOM_CONNECT_RESULT", {
      matchId: state.loading.matchId,
      status,
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "룸 연결 결과 보고에 실패했습니다.",
      }));
    }
  },

  setRealtimeConnectionState: (reconnectState) => {
    const normalized = reconnectState.trim().toLowerCase();
    const reconnecting =
      normalized.includes("reconnect") ||
      normalized.includes("disconnect") ||
      normalized.includes("connecting");

    set((state) => {
      if (reconnecting && state.flowState === "IN_MATCH") {
        return {
          ...state,
          previousFlowState: state.flowState,
          flowState: "RECONNECTING",
        };
      }

      if (!reconnecting && state.flowState === "RECONNECTING") {
        return {
          ...state,
          previousFlowState: state.flowState,
          flowState: "IN_MATCH",
        };
      }

      return state;
    });
  },

  requestRematchVote: (vote = true) => {
    const state = get();
    if (state.flowState !== "RESULT") return;
    if (!state.result.matchId) return;

    const sent = sendControlEvent("C2S_REMATCH_VOTE", {
      matchId: state.result.matchId,
      vote,
    });

    if (!sent) {
      set((prev) => ({
        ...prev,
        systemNotice: "리매치 투표 요청 전송에 실패했습니다.",
      }));
    }
  },

  backToLobbyLocal: (notice) => {
    set((state) => ({
      ...state,
      previousFlowState: state.flowState,
      flowState: "LOBBY",
      queue: defaultQueueState(),
      readyCheck: defaultReadyCheckState(),
      draft: defaultDraftState(),
      loading: defaultLoadingState(),
      result: defaultResultState(),
      systemNotice: notice ?? null,
    }));
  },

  clearSystemNotice: () => {
    const state = get();
    if (!state.systemNotice) return;
    set((prev) => ({
      ...prev,
      systemNotice: null,
    }));
  },
}));
