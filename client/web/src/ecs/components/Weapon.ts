export interface Weapon {
  weaponId: string;
  cooldownMs: number;
  lastFiredAtMs: number;
  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  reloadRemainingTicks: number;
}
