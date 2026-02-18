import type {
  CombatDataTables,
  HeroDefinition,
  SkillDefinition,
  WeaponDefinition,
} from "../combat/combatTypes";
import { validateCombatData } from "./combatDataValidator";

export class CombatDataValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`combat data validation failed:\n${issues.join("\n")}`);
  }
}

function inferWeaponClass(rawClass: unknown): WeaponDefinition["class"] {
  const text = String(rawClass ?? "").toLowerCase();
  if (text.includes("smg")) return "SMG";
  if (text.includes("shotgun")) return "Shotgun";
  if (text.includes("launcher")) return "Launcher";
  if (text.includes("pistol")) return "Pistol";
  if (text.includes("dmr")) return "DMR";
  if (text.includes("mini")) return "Minigun";
  if (text.includes("beam") || text.includes("energy")) return "Beam";
  return "AR";
}

function toHeroDefinition(raw: any): HeroDefinition {
  const heroId = String(raw?.id ?? "coral_cat");
  const normalizedId = heroId === "whitecat_commando" ? "coral_cat" : heroId;

  return {
    id: normalizedId as HeroDefinition["id"],
    role: String(raw?.role ?? "Striker") as HeroDefinition["role"],
    base: {
      hp: Number(raw?.stats?.hp ?? 2500),
      moveSpeedMps: Number(raw?.stats?.moveSpeedMps ?? 5),
      hitboxRadiusM: Number(raw?.stats?.hitboxRadiusM ?? 0.5),
      ultChargeRequired: Number(raw?.stats?.ultChargeRequired ?? 2000),
    },
    weaponId: normalizedId,
    passiveId: `${normalizedId}_passive`,
    skillQId: `${normalizedId}_q`,
    skillEId: `${normalizedId}_e`,
    skillRId: `${normalizedId}_r`,
  };
}

function toWeaponDefinition(raw: any, heroId: string): WeaponDefinition {
  const shotsPerSec = Number(raw?.weapon?.shotsPerSec ?? 0);
  const damagePerSec = Number(raw?.weapon?.damagePerSec ?? 0);

  return {
    id: heroId,
    class: inferWeaponClass(raw?.weapon?.class),
    rangeM: Number(raw?.weapon?.rangeM ?? 10),
    falloffStartM: Number(raw?.weapon?.falloffStartM ?? 7),
    falloffEndM: Number(raw?.weapon?.falloffEndM ?? 14),
    damagePerShot:
      Number(raw?.weapon?.damagePerShot ?? 0) ||
      Number(raw?.weapon?.pelletCount ?? 0) * Number(raw?.weapon?.pelletDamage ?? 0) ||
      (damagePerSec > 0 && shotsPerSec > 0 ? damagePerSec / shotsPerSec : 80),
    shotsPerSec: shotsPerSec > 0 ? shotsPerSec : 6,
    damagePerSec: damagePerSec > 0 ? damagePerSec : undefined,
    ammo: Number(raw?.weapon?.ammo ?? raw?.weapon?.overheatMax ?? 12),
    reloadSec: Number(raw?.weapon?.reloadSec ?? 1.7),
    critMultiplier: Number(raw?.weapon?.critMultiplier ?? 1.25),
  };
}

function toSkillDefinition(raw: any, heroId: string): SkillDefinition[] {
  const skillRows: SkillDefinition[] = [];

  const slots: Array<["Q" | "E" | "R", "q" | "e" | "r"]> = [
    ["Q", "q"],
    ["E", "e"],
    ["R", "r"],
  ];

  for (const [slot, key] of slots) {
    const skill = raw?.skills?.[key];
    if (!skill) continue;

    const params: Record<string, number | boolean | string> = {};
    for (const [paramKey, paramValue] of Object.entries(skill)) {
      if (paramKey === "name" || paramKey === "cooldownMs" || paramKey === "castTimeMs") {
        continue;
      }

      if (
        typeof paramValue === "number" ||
        typeof paramValue === "boolean" ||
        typeof paramValue === "string"
      ) {
        params[paramKey] = paramValue;
      }
    }

    skillRows.push({
      id: `${heroId}_${key}`,
      slot,
      archetype: "Projectile",
      cooldownMs: Number(skill.cooldownMs ?? 1000),
      castTimeMs: Number(skill.castTimeMs ?? skill.castTime ?? 0),
      params,
    });
  }

  return skillRows;
}

export function buildCombatTablesFromHeroBalance(heroRows: any[]): CombatDataTables {
  const heroes: HeroDefinition[] = [];
  const weapons: WeaponDefinition[] = [];
  const skills: SkillDefinition[] = [];

  for (const rawHero of heroRows) {
    const heroDef = toHeroDefinition(rawHero);
    heroes.push(heroDef);
    weapons.push(toWeaponDefinition(rawHero, heroDef.id));
    skills.push(...toSkillDefinition(rawHero, heroDef.id));
  }

  return { heroes, weapons, skills };
}

export function loadCombatDataFromObject(rawData: any): CombatDataTables {
  const tables = buildCombatTablesFromHeroBalance(Array.isArray(rawData?.heroes) ? rawData.heroes : []);
  const validation = validateCombatData(tables);
  if (!validation.ok) {
    throw new CombatDataValidationError(
      validation.issues.map((issue) => `- ${issue.path}: ${issue.message}`),
    );
  }
  return tables;
}

export function loadCombatDataFromJson(jsonText: string): CombatDataTables {
  const parsed = JSON.parse(jsonText);
  return loadCombatDataFromObject(parsed);
}
