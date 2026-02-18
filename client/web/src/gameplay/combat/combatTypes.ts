export type HeroId =
  | "lumifox"
  | "bruno_bear"
  | "stinkrat"
  | "milky_rabbit"
  | "iris_wolf"
  | "coral_cat"
  | "rockhorn_rhino"
  | "pearl_panda";

export type HeroRole =
  | "Vanguard"
  | "Striker"
  | "Skirmisher"
  | "Controller"
  | "Support"
  | "SupportController";

export interface HeroDefinition {
  id: HeroId;
  role: HeroRole;
  base: {
    hp: number;
    moveSpeedMps: number;
    hitboxRadiusM: number;
    ultChargeRequired: number;
  };
  weaponId: string;
  passiveId: string;
  skillQId: string;
  skillEId: string;
  skillRId: string;
}

export type WeaponClass =
  | "SMG"
  | "Shotgun"
  | "Launcher"
  | "Pistol"
  | "AR"
  | "DMR"
  | "Minigun"
  | "Beam";

export interface WeaponDefinition {
  id: string;
  class: WeaponClass;
  rangeM: number;
  falloffStartM?: number;
  falloffEndM?: number;
  damagePerShot?: number;
  shotsPerSec?: number;
  damagePerSec?: number;
  ammo?: number;
  reloadSec?: number;
  critMultiplier: number;
}

export type SkillSlot = "Q" | "E" | "R";
export type SkillArchetype =
  | "Dash"
  | "Projectile"
  | "Zone"
  | "Channel"
  | "Buff"
  | "Shield"
  | "Rescue";

export interface SkillDefinition {
  id: string;
  slot: SkillSlot;
  archetype: SkillArchetype;
  cooldownMs: number;
  castTimeMs: number;
  params: Record<string, number | boolean | string>;
}

export type StatusEffectKind =
  | "Slow"
  | "Root"
  | "Stun"
  | "DamageAmp"
  | "Shield"
  | "HealOverTime";

export interface ActiveStatusEffect {
  id: string;
  kind: StatusEffectKind;
  sourcePlayerId: number;
  startedTick: number;
  endTick: number;
  stacks: number;
}

export interface CombatRuntimeState {
  hp: number;
  alive: boolean;

  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  reloadRemainingTicks: number;

  cooldownQ: number;
  cooldownE: number;
  cooldownR: number;

  castingSkill: 0 | 1 | 2 | 3;
  castRemainingTicks: number;

  activeEffects: ActiveStatusEffect[];
}

export interface CombatDataTables {
  heroes: HeroDefinition[];
  weapons: WeaponDefinition[];
  skills: SkillDefinition[];
}
