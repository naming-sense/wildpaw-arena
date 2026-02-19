export interface InputCommand {
  seq: number;
  clientTime: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  // C++ room wire(ActionCommandPayload) 변환용 보조 필드
  aimRadian?: number;
  originX?: number;
  originY?: number;
  fire: boolean;
  skillQ: boolean;
  skillE: boolean;
  skillR: boolean;
}

export interface NetworkPlayerState {
  playerId: number;
  team: number;
  teamSlot?: number;
  x: number;
  y: number;
  rot: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp?: number;
  shield: number;
  alive: boolean;
  lastProcessedInputSeq: number;
  heroId?: string;
  heroName?: string;
  ammo?: number;
  maxAmmo?: number;
  reloading?: boolean;
}

export interface WorldSnapshot {
  serverTick: number;
  serverTimeMs: number;
  ackSeq: number;
  players: NetworkPlayerState[];
}

export interface Envelope<T = unknown> {
  t: string;
  d: T;
}
