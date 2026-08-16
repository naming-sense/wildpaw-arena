import type { HeroId, SkillArchetype, SkillSlot } from "../combat/combatTypes";

export interface SkillDef {
  id: string;
  slot: SkillSlot;
  archetype: SkillArchetype;
}

export type HeroSkillDefs = readonly [
  SkillDef & { slot: "Q" },
  SkillDef & { slot: "E" },
  SkillDef & { slot: "R" },
];

export const SKILL_DEFS_BY_HERO = {
  lumifox: [
    { id: "lumifox_q", slot: "Q", archetype: "Dash" },
    { id: "lumifox_e", slot: "E", archetype: "Zone" },
    { id: "lumifox_r", slot: "R", archetype: "Buff" },
  ],
  bruno_bear: [
    { id: "bruno_q", slot: "Q", archetype: "Dash" },
    { id: "bruno_e", slot: "E", archetype: "Shield" },
    { id: "bruno_r", slot: "R", archetype: "Zone" },
  ],
  stinkrat: [
    { id: "stinkrat_q", slot: "Q", archetype: "Zone" },
    { id: "stinkrat_e", slot: "E", archetype: "Zone" },
    { id: "stinkrat_r", slot: "R", archetype: "Zone" },
  ],
  milky_rabbit: [
    { id: "milky_q", slot: "Q", archetype: "Projectile" },
    { id: "milky_e", slot: "E", archetype: "Rescue" },
    { id: "milky_r", slot: "R", archetype: "Zone" },
  ],
  iris_wolf: [
    { id: "iris_q", slot: "Q", archetype: "Projectile" },
    { id: "iris_e", slot: "E", archetype: "Projectile" },
    { id: "iris_r", slot: "R", archetype: "Buff" },
  ],
  coral_cat: [
    { id: "coral_q", slot: "Q", archetype: "Dash" },
    { id: "coral_e", slot: "E", archetype: "Zone" },
    { id: "coral_r", slot: "R", archetype: "Buff" },
  ],
  rockhorn_rhino: [
    { id: "rhino_q", slot: "Q", archetype: "Shield" },
    { id: "rhino_e", slot: "E", archetype: "Zone" },
    { id: "rhino_r", slot: "R", archetype: "Dash" },
  ],
  pearl_panda: [
    { id: "panda_q", slot: "Q", archetype: "Channel" },
    { id: "panda_e", slot: "E", archetype: "Channel" },
    { id: "panda_r", slot: "R", archetype: "Rescue" },
  ],
} as const satisfies Record<HeroId, HeroSkillDefs>;

export const SKILL_DEFS: SkillDef[] = Object.values(SKILL_DEFS_BY_HERO).flatMap(
  (heroSkills) => [...heroSkills],
);

export const SKILL_DEF_BY_ID = new Map(SKILL_DEFS.map((skill) => [skill.id, skill]));
