import type { CombatDataTables, HeroDefinition, SkillDefinition, WeaponDefinition } from "../combat/combatTypes";

export interface CombatDataValidationIssue {
  path: string;
  message: string;
}

export interface CombatDataValidationResult {
  ok: boolean;
  issues: CombatDataValidationIssue[];
}

function validateHero(hero: HeroDefinition, index: number, issues: CombatDataValidationIssue[]): void {
  if (hero.base.hp < 2200 || hero.base.hp > 3600) {
    issues.push({
      path: `heroes[${index}].base.hp`,
      message: `hp out of range (2200~3600): ${hero.base.hp}`,
    });
  }

  if (hero.base.moveSpeedMps < 4.4 || hero.base.moveSpeedMps > 6.3) {
    issues.push({
      path: `heroes[${index}].base.moveSpeedMps`,
      message: `moveSpeedMps out of range (4.4~6.3): ${hero.base.moveSpeedMps}`,
    });
  }
}

function validateWeapon(
  weapon: WeaponDefinition,
  index: number,
  issues: CombatDataValidationIssue[],
): void {
  if (weapon.critMultiplier < 1.0 || weapon.critMultiplier > 1.6) {
    issues.push({
      path: `weapons[${index}].critMultiplier`,
      message: `critMultiplier out of range (1.0~1.6): ${weapon.critMultiplier}`,
    });
  }

  if (
    typeof weapon.falloffStartM === "number" &&
    typeof weapon.falloffEndM === "number" &&
    weapon.falloffEndM < weapon.falloffStartM
  ) {
    issues.push({
      path: `weapons[${index}]`,
      message: `falloffEndM must be >= falloffStartM (${weapon.falloffStartM} -> ${weapon.falloffEndM})`,
    });
  }
}

function validateSkill(skill: SkillDefinition, index: number, issues: CombatDataValidationIssue[]): void {
  if (skill.cooldownMs < 1000) {
    issues.push({
      path: `skills[${index}].cooldownMs`,
      message: `cooldownMs must be >= 1000: ${skill.cooldownMs}`,
    });
  }
}

export function validateCombatData(tables: CombatDataTables): CombatDataValidationResult {
  const issues: CombatDataValidationIssue[] = [];

  const heroIds = new Set<string>();
  for (let i = 0; i < tables.heroes.length; i += 1) {
    const hero = tables.heroes[i]!;
    if (heroIds.has(hero.id)) {
      issues.push({ path: `heroes[${i}].id`, message: `duplicated hero id: ${hero.id}` });
    }
    heroIds.add(hero.id);
    validateHero(hero, i, issues);
  }

  const weaponIds = new Set<string>();
  for (let i = 0; i < tables.weapons.length; i += 1) {
    const weapon = tables.weapons[i]!;
    if (weaponIds.has(weapon.id)) {
      issues.push({ path: `weapons[${i}].id`, message: `duplicated weapon id: ${weapon.id}` });
    }
    weaponIds.add(weapon.id);
    validateWeapon(weapon, i, issues);
  }

  const skillIds = new Set<string>();
  for (let i = 0; i < tables.skills.length; i += 1) {
    const skill = tables.skills[i]!;
    if (skillIds.has(skill.id)) {
      issues.push({ path: `skills[${i}].id`, message: `duplicated skill id: ${skill.id}` });
    }
    skillIds.add(skill.id);
    validateSkill(skill, i, issues);
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}
