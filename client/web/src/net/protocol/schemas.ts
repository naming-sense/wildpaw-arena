export interface InputCommand {
  seq: number;
  clientTime: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  skillQ: boolean;
  skillE: boolean;
  skillR: boolean;
}

export interface NetworkPlayerState {
  playerId: number;
  team: number;
  x: number;
  y: number;
  rot: number;
  vx: number;
  vy: number;
  hp: number;
  shield: number;
  alive: boolean;
  lastProcessedInputSeq: number;
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
