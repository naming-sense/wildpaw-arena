import type { CombatRuntimeState, HeroDefinition, SkillDefinition, WeaponDefinition } from "./combatTypes";
import { computeShotDamage } from "./damageFormula";

export interface ResolveShotInput {
  attackerHero: HeroDefinition;
  attackerWeapon: WeaponDefinition;
  targetHero: HeroDefinition;
  distanceM: number;
  isCrit: boolean;
  outgoingAmp?: number;
  incomingReduction?: number;
}

export interface ResolveShotResult {
  damage: number;
  killed: boolean;
}

export interface ResolveSkillInput {
  casterHero: HeroDefinition;
  skill: SkillDefinition;
  state: CombatRuntimeState;
}

export interface ResolveSkillResult {
  started: boolean;
  reason?: "cooldown" | "casting" | "dead";
  nextState: CombatRuntimeState;
}

export function resolveShot(
  input: ResolveShotInput,
  targetState: CombatRuntimeState,
): ResolveShotResult {
  const damage = computeShotDamage({
    baseDamage: input.attackerWeapon.damagePerShot ?? 0,
    distanceM: input.distanceM,
    falloffStartM: input.attackerWeapon.falloffStartM ?? input.attackerWeapon.rangeM,
    falloffEndM: input.attackerWeapon.falloffEndM ?? input.attackerWeapon.rangeM,
    critMultiplier: input.attackerWeapon.critMultiplier,
    isCrit: input.isCrit,
    outgoingAmp: input.outgoingAmp,
    incomingReduction: input.incomingReduction,
  });

  return {
    damage,
    killed: targetState.hp - damage <= 0,
  };
}

export function resolveSkillCast(input: ResolveSkillInput): ResolveSkillResult {
  if (!input.state.alive) {
    return { started: false, reason: "dead", nextState: input.state };
  }

  if (input.state.castingSkill !== 0) {
    return { started: false, reason: "casting", nextState: input.state };
  }

  // TODO: slot-specific cooldown check + archetype dispatch (Dash/Zone/Channel/Shield/Rescue)
  return {
    started: true,
    nextState: {
      ...input.state,
      castingSkill: input.skill.slot === "Q" ? 1 : input.skill.slot === "E" ? 2 : 3,
      castRemainingTicks: Math.max(0, Math.round(input.skill.castTimeMs / (1000 / 30))),
    },
  };
}
