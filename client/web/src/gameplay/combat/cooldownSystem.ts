export interface CooldownSnapshot {
  qTicks: number;
  eTicks: number;
  rTicks: number;
}

export function tickCooldowns(cooldowns: CooldownSnapshot, elapsedTicks: number): CooldownSnapshot {
  const step = Math.max(0, Math.floor(elapsedTicks));
  return {
    qTicks: Math.max(0, cooldowns.qTicks - step),
    eTicks: Math.max(0, cooldowns.eTicks - step),
    rTicks: Math.max(0, cooldowns.rTicks - step),
  };
}

export function startCooldown(
  cooldowns: CooldownSnapshot,
  slot: "Q" | "E" | "R",
  cooldownTicks: number,
): CooldownSnapshot {
  const next = { ...cooldowns };
  const ticks = Math.max(0, Math.floor(cooldownTicks));

  if (slot === "Q") next.qTicks = ticks;
  if (slot === "E") next.eTicks = ticks;
  if (slot === "R") next.rTicks = ticks;

  return next;
}
