import type { EntityId, World } from "./world";

const MAX_SLOW_MAGNITUDE = 1;

export interface PredictionStatusModifiers {
  stunned: boolean;
  moveSpeedMultiplier: number;
}

export function resolvePredictionStatusModifiers(
  world: World,
  entityId: EntityId,
): PredictionStatusModifiers {
  const effects = world.statusEffects.get(entityId);
  if (!effects || effects.length === 0) {
    return { stunned: false, moveSpeedMultiplier: 1 };
  }

  let stunned = false;
  let strongestSlow = 0;
  for (const effect of effects) {
    if (effect.remainingMs <= 0) {
      continue;
    }

    if (effect.kind === "Stun") {
      stunned = true;
      continue;
    }

    if (effect.kind === "Slow" && Number.isFinite(effect.magnitude)) {
      strongestSlow = Math.max(strongestSlow, effect.magnitude);
    }
  }

  return {
    stunned,
    moveSpeedMultiplier: 1 - Math.min(MAX_SLOW_MAGNITUDE, Math.max(0, strongestSlow)),
  };
}
