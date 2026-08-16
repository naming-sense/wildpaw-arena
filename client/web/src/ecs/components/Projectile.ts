export interface Projectile {
  networkProjectileId: number;
  ownerPlayerId: number;
  targetPlayerId: number;
  velocityX: number;
  velocityZ: number;
  expiresAtMs: number;
  active: boolean;
}
