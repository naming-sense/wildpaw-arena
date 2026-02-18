import type { ActiveStatusEffect } from "./combatTypes";

export interface ApplyStatusEffectArgs {
  current: ActiveStatusEffect[];
  incoming: ActiveStatusEffect;
  stackPolicy: "refresh" | "max";
  maxStacks?: number;
}

export function applyStatusEffect(args: ApplyStatusEffectArgs): ActiveStatusEffect[] {
  const { current, incoming, stackPolicy, maxStacks = 1 } = args;

  const index = current.findIndex((effect) => effect.id === incoming.id);
  if (index < 0) {
    return [...current, incoming];
  }

  const next = [...current];
  const existing = next[index]!;

  if (stackPolicy === "max") {
    next[index] = {
      ...existing,
      endTick: Math.max(existing.endTick, incoming.endTick),
      stacks: Math.max(existing.stacks, incoming.stacks),
    };
    return next;
  }

  next[index] = {
    ...incoming,
    stacks: Math.min(maxStacks, Math.max(existing.stacks, incoming.stacks)),
  };
  return next;
}

export function pruneExpiredStatusEffects(
  effects: ActiveStatusEffect[],
  nowTick: number,
): ActiveStatusEffect[] {
  return effects.filter((effect) => effect.endTick > nowTick);
}
