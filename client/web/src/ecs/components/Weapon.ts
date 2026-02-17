export interface Weapon {
  weaponId: string;
  cooldownMs: number;
  lastFiredAtMs: number;
  ammo: number;
}
