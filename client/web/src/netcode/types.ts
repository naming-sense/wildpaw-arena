export type EntityId = number;

export interface Vec2 {
  x: number;
  y: number;
}

export interface InputFrame {
  inputSeq: number;
  localTick: number;
  moveX: -1 | 0 | 1;
  moveY: -1 | 0 | 1;
  fire: boolean;
  aimRadian: number;
  skillQ?: boolean;
  skillE?: boolean;
  skillR?: boolean;
}

export interface PlayerSnapshot {
  playerId: EntityId;
  position: Vec2;
  velocity: Vec2;
  hp: number;
  alive: boolean;
  lastProcessedInputSeq: number;

  ammo: number;
  maxAmmo: number;
  reloading: boolean;
  reloadRemainingTicks: number;

  skillQCooldownTicks: number;
  skillECooldownTicks: number;
  skillRCooldownTicks: number;
  castingSkill: number;
  castRemainingTicks: number;
}

export interface WorldSnapshot {
  serverTick: number;
  serverTimeMs: number;
  players: PlayerSnapshot[];
}

export interface CombatEventPacket {
  eventType: number;
  sourcePlayerId: number;
  targetPlayerId: number;
  skillSlot: number;
  damage: number;
  isCritical: boolean;
  serverTick: number;
  position: Vec2;
}

export interface ProjectileEventPacket {
  projectileId: number;
  ownerPlayerId: number;
  targetPlayerId: number;
  phase: number;
  serverTick: number;
  position: Vec2;
  velocity: Vec2;
}
