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
}

export interface PlayerSnapshot {
  playerId: EntityId;
  position: Vec2;
  velocity: Vec2;
  hp: number;
  alive: boolean;
  lastProcessedInputSeq: number;
}

export interface WorldSnapshot {
  serverTick: number;
  serverTimeMs: number;
  players: PlayerSnapshot[];
}
