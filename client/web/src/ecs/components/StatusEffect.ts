import type { StatusEffectKind } from "../../gameplay/combat/combatTypes";

export interface StatusEffect {
  id: string;
  kind: StatusEffectKind;
  sourcePlayerId: number;
  stacks: number;
  magnitude: number;
  serverTick: number;
  remainingMs: number;
}
