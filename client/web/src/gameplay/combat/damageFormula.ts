export function computeDistanceFalloff(
  distanceM: number,
  falloffStartM: number,
  falloffEndM: number,
  minFalloffRatio = 0.62,
): number {
  if (distanceM <= falloffStartM) return 1;
  if (distanceM >= falloffEndM) return minFalloffRatio;

  const t = (distanceM - falloffStartM) / Math.max(0.001, falloffEndM - falloffStartM);
  return 1 - (1 - minFalloffRatio) * t;
}

export function computeShotDamage(args: {
  baseDamage: number;
  distanceM: number;
  falloffStartM: number;
  falloffEndM: number;
  critMultiplier: number;
  isCrit: boolean;
  outgoingAmp?: number;
  incomingReduction?: number;
}): number {
  const {
    baseDamage,
    distanceM,
    falloffStartM,
    falloffEndM,
    critMultiplier,
    isCrit,
    outgoingAmp = 0,
    incomingReduction = 0,
  } = args;

  let damage = baseDamage;
  damage *= computeDistanceFalloff(distanceM, falloffStartM, falloffEndM);

  if (isCrit) {
    damage *= Math.max(1, critMultiplier);
  }

  damage *= 1 + Math.max(0, outgoingAmp);
  damage *= 1 - Math.min(0.9, Math.max(0, incomingReduction));

  return Math.max(1, Math.round(damage));
}
