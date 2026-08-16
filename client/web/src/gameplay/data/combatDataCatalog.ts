import heroBalance from "../../../../../shared/data/hero_balance_mvp_v0.2.json";
import { HERO_DEFS } from "../hero/heroDefs";
import { SKILL_DEF_BY_ID, SKILL_DEFS } from "../skill/skillDefs";
import { loadCombatDataFromObject } from "./combatDataLoader";

export const COMBAT_DATA = loadCombatDataFromObject(heroBalance);

export const COMBAT_SKILL_DEF_BY_ID = new Map(
  COMBAT_DATA.skills.map((skill) => [skill.id, skill]),
);

function assertMainSkillCoverage(): void {
  const referencedSkillIds = new Set<string>();

  for (const hero of HERO_DEFS) {
    if (hero.skillIds.length !== 3) {
      throw new Error(`[combat-data] ${hero.id} must reference exactly three skills.`);
    }

    for (const skillId of hero.skillIds) {
      const runtimeDefinition = COMBAT_SKILL_DEF_BY_ID.get(skillId);
      const scaffoldDefinition = SKILL_DEF_BY_ID.get(skillId);
      if (!runtimeDefinition || !scaffoldDefinition) {
        throw new Error(`[combat-data] missing main runtime skill definition: ${skillId}`);
      }
      if (
        runtimeDefinition.slot !== scaffoldDefinition.slot ||
        runtimeDefinition.archetype !== scaffoldDefinition.archetype
      ) {
        throw new Error(`[combat-data] scaffold mismatch for skill: ${skillId}`);
      }
      referencedSkillIds.add(skillId);
    }
  }

  if (
    HERO_DEFS.length !== 8 ||
    SKILL_DEFS.length !== 24 ||
    referencedSkillIds.size !== SKILL_DEFS.length
  ) {
    throw new Error(
      `[combat-data] expected 8 heroes / 24 unique skills, found ${HERO_DEFS.length} / ${referencedSkillIds.size}.`,
    );
  }
}

assertMainSkillCoverage();
