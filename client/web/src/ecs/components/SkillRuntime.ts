import type { SkillArchetype, SkillSlot } from "../../gameplay/combat/combatTypes";

export type SkillRuntimeAnchor = "Owner" | "Trajectory" | "World";
export type SkillRuntimeAuthority =
  | "ServerApproved"
  | "StatusLinked"
  | "SnapshotConfirmed";

export interface SkillRuntime {
  skillId: string;
  slot: SkillSlot;
  archetype: SkillArchetype;
  ownerPlayerId: number;
  serverTick: number;
  anchor: SkillRuntimeAnchor;
  approvedAtMs: number;
  expiresAtMs: number;
  remainingMs: number;
  durationMs: number;
  originX: number;
  originZ: number;
  currentX: number;
  currentZ: number;
  directionX: number;
  directionZ: number;
  rangeM: number;
  radiusM: number;
  speedMps: number;
  observedTravelM: number;
  linkedStatusEffectIds: string[];
  authority: SkillRuntimeAuthority;
}
