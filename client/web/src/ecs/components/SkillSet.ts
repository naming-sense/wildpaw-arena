import type { SkillArchetype, SkillDefinition } from "../../gameplay/combat/combatTypes";

export interface SkillSlotState {
  skillId: string;
  archetype: SkillArchetype;
  definition: SkillDefinition;
  cooldownEndMs: number;
  cooldownRemainingTicks: number;
}

export interface SkillSet {
  q: SkillSlotState;
  e: SkillSlotState;
  r: SkillSlotState;
  castingSkill: 0 | 1 | 2 | 3;
  castRemainingTicks: number;
}
