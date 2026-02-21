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

export type ControlConnectionState =
  | "Disconnected"
  | "Connected"
  | "Reconnecting"
  | "Failed";

export interface FlowErrorState {
  code: string;
  message: string;
  details?: unknown;
  atMs: number;
}

interface HudSlice {
  hp: number;
  maxHp: number;
  heroName: string;
  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  kills: number;
  wave: number;
  fps: number;
  frameMs: number;
  pingMs: number;
  jitterMs: number;
  packetLossPct: number;
  reconnectState: string;
  drawCalls: number;
  renderDpr: number;
  fowMode: string;
  buildTag: string;
  showDebug: boolean;
}

interface FlowSlice {
  appFlowState: AppFlowState;
  controlConnectionState: ControlConnectionState;
  controlEndpoint: string;
  sessionId: string | null;
  accountId: string | null;
  queueTicketId: string | null;
  modeId: string | null;
  matchCandidateId: string | null;
  matchId: string | null;
  draftTurnSeq: number | null;
  draftRemainingSec: number | null;
  teamId: number | null;
  teamSlot: number | null;
  roomEndpoint: string | null;
  roomToken: string | null;
  flowEventHint: string;
  lastFlowError: FlowErrorState | null;
  flowLogs: string[];
}

type HudPatch = Partial<HudSlice>;
type FlowPatch = Partial<FlowSlice>;

interface UiState extends HudSlice, FlowSlice {
  setHud: (partial: HudPatch) => void;
  setFlow: (partial: FlowPatch) => void;
  pushFlowLog: (line: string) => void;
  clearFlowLogs: () => void;
  toggleDebug: () => void;
}

const MAX_FLOW_LOGS = 60;

export const useUiStore = create<UiState>((set) => ({
  hp: 100,
  maxHp: 100,
  heroName: "코랄 캣",
  ammo: 0,
  maxAmmo: 0,
  reloading: false,
  kills: 0,
  wave: 1,
  fps: 0,
  frameMs: 0,
  pingMs: 0,
  jitterMs: 0,
  packetLossPct: 0,
  reconnectState: "Disconnected",
  drawCalls: 0,
  renderDpr: 1,
  fowMode: "-",
  buildTag: "-",
  showDebug: true,

  appFlowState: "BOOT",
  controlConnectionState: "Disconnected",
  controlEndpoint: "",
  sessionId: null,
  accountId: null,
  queueTicketId: null,
  modeId: null,
  matchCandidateId: null,
  matchId: null,
  draftTurnSeq: null,
  draftRemainingSec: null,
  teamId: null,
  teamSlot: null,
  roomEndpoint: null,
  roomToken: null,
  flowEventHint: "",
  lastFlowError: null,
  flowLogs: [],

  setHud: (partial) => set((state) => ({ ...state, ...partial })),
  setFlow: (partial) => set((state) => ({ ...state, ...partial })),
  pushFlowLog: (line) =>
    set((state) => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      const next = [...state.flowLogs, `[${hh}:${mm}:${ss}] ${line}`];
      if (next.length > MAX_FLOW_LOGS) {
        next.splice(0, next.length - MAX_FLOW_LOGS);
      }
      return { ...state, flowLogs: next };
    }),
  clearFlowLogs: () => set((state) => ({ ...state, flowLogs: [] })),
  toggleDebug: () => set((state) => ({ showDebug: !state.showDebug })),
}));
