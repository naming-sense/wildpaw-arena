import type { SkillDefinition } from "../combat/combatTypes";
import type { SkillRuntime, SkillRuntimeAnchor } from "../../ecs/components";

function readPositiveParam(
  definition: SkillDefinition,
  keys: readonly string[],
  fallback: number,
): number {
  for (const key of keys) {
    const value = definition.params[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return fallback;
}

function resolveAnchor(definition: SkillDefinition): SkillRuntimeAnchor {
  switch (definition.archetype) {
    case "Projectile":
      return "Trajectory";
    case "Zone":
      return "World";
    case "Dash":
    case "Channel":
    case "Buff":
    case "Shield":
    case "Rescue":
      return "Owner";
  }
}

function resolveRangeM(definition: SkillDefinition): number {
  return readPositiveParam(
    definition,
    definition.archetype === "Dash"
      ? ["dashDistanceM", "hookRangeM", "jumpRangeM", "rangeM"]
      : ["rangeM", "hookRangeM", "jumpRangeM", "deployRangeM", "wireLengthM"],
    definition.archetype === "Zone" || definition.archetype === "Buff" ? 0 : 8,
  );
}

function resolveRadiusM(definition: SkillDefinition): number {
  return readPositiveParam(
    definition,
    ["radiusM", "smokeRadiusM", "landingRadiusM", "pathWidthM"],
    definition.archetype === "Zone" || definition.archetype === "Rescue" ? 2.5 : 0,
  );
}

function resolveSpeedMps(definition: SkillDefinition): number {
  return readPositiveParam(
    definition,
    ["travelSpeedMps"],
    definition.archetype === "Dash" ? 18 : definition.archetype === "Projectile" ? 20 : 0,
  );
}

function resolveDurationMs(
  definition: SkillDefinition,
  rangeM: number,
  speedMps: number,
): number {
  switch (definition.archetype) {
    case "Dash":
    case "Projectile":
      return Math.max(250, (rangeM / Math.max(1, speedMps)) * 1000);
    case "Zone":
      return readPositiveParam(
        definition,
        ["durationMs", "dotDurationMs", "slowDurationMs", "statusResistDurationMs"],
        900,
      );
    case "Channel":
      return readPositiveParam(definition, ["channelMaxMs", "durationMs"], 1200);
    case "Buff":
      return readPositiveParam(definition, ["durationMs", "buffDurationMs"], 2500);
    case "Shield":
      return readPositiveParam(definition, ["durationMs", "shieldDurationMs"], 2500);
    case "Rescue":
      return readPositiveParam(
        definition,
        ["durationMs", "shieldDurationMs", "rescueShieldDurationMs", "hotDurationMs"],
        2500,
      );
  }
}

export interface ApprovedSkillRuntimeInput {
  definition: SkillDefinition;
  ownerPlayerId: number;
  serverTick: number;
  approvedAtMs: number;
  originX: number;
  originZ: number;
  aimRadian: number;
}

export function createApprovedSkillRuntime(input: ApprovedSkillRuntimeInput): SkillRuntime {
  const rangeM = resolveRangeM(input.definition);
  const radiusM = resolveRadiusM(input.definition);
  const speedMps = resolveSpeedMps(input.definition);
  const durationMs = resolveDurationMs(input.definition, rangeM, speedMps);

  return {
    skillId: input.definition.id,
    slot: input.definition.slot,
    archetype: input.definition.archetype,
    ownerPlayerId: input.ownerPlayerId,
    serverTick: input.serverTick,
    anchor: resolveAnchor(input.definition),
    approvedAtMs: input.approvedAtMs,
    expiresAtMs: input.approvedAtMs + durationMs,
    remainingMs: durationMs,
    durationMs,
    originX: input.originX,
    originZ: input.originZ,
    currentX: input.originX,
    currentZ: input.originZ,
    directionX: Math.sin(input.aimRadian),
    directionZ: Math.cos(input.aimRadian),
    rangeM,
    radiusM,
    speedMps,
    observedTravelM: 0,
    linkedStatusEffectIds: [],
    authority: "ServerApproved",
  };
}
