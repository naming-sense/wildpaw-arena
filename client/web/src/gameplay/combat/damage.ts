export function applyDamage(currentHp: number, shield: number, amount: number): {
  hp: number;
  shield: number;
} {
  const absorbed = Math.min(shield, amount);
  const nextShield = shield - absorbed;
  const overflow = amount - absorbed;

  return {
    hp: Math.max(0, currentHp - overflow),
    shield: nextShield,
  };
}
