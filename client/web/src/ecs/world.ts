import type { InputCommand } from "../net/protocol/schemas";
import type {
  Health,
  Projectile,
  RenderProxy,
  SkillSet,
  SkillRuntime,
  StatusEffect,
  Team,
  Transform,
  Velocity,
  Weapon,
} from "./components";

export type EntityId = number;

export interface SimulationContext {
  nowMs: number;
  dtMs: number;
  localPlayerId: EntityId;
  command?: InputCommand;
  worldBounds: {
    min: number;
    max: number;
    minX?: number;
    maxX?: number;
    minZ?: number;
    maxZ?: number;
  };
  staticColliders?: ReadonlyArray<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    blocksMovement: boolean;
  }>;
}

export interface EcsSystem {
  name: string;
  update(world: World, ctx: SimulationContext): void;
}

export class World {
  private nextEntityId = 1;
  readonly transforms = new Map<EntityId, Transform>();
  readonly velocities = new Map<EntityId, Velocity>();
  readonly healths = new Map<EntityId, Health>();
  readonly teams = new Map<EntityId, Team>();
  readonly weapons = new Map<EntityId, Weapon>();
  readonly skills = new Map<EntityId, SkillSet>();
  readonly skillRuntimes = new Map<EntityId, SkillRuntime[]>();
  readonly statusEffects = new Map<EntityId, StatusEffect[]>();
  readonly projectiles = new Map<EntityId, Projectile>();
  readonly renderProxies = new Map<EntityId, RenderProxy>();

  private readonly systems: EcsSystem[] = [];

  createEntity(): EntityId {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  addSystem(system: EcsSystem): void {
    this.systems.push(system);
  }

  update(ctx: SimulationContext): void {
    for (const system of this.systems) {
      system.update(this, ctx);
    }
  }
}
