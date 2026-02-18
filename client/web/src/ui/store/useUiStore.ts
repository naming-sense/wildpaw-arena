import { create } from "zustand";

interface HudState {
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
  showDebug: boolean;
  setHud: (partial: Partial<HudState>) => void;
  toggleDebug: () => void;
}

export const useUiStore = create<HudState>((set) => ({
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
  showDebug: true,
  setHud: (partial) => set((state) => ({ ...state, ...partial })),
  toggleDebug: () => set((state) => ({ showDebug: !state.showDebug })),
}));
