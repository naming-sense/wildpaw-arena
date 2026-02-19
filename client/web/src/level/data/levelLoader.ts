import fddPh01 from "./maps/fdd_ph_01.json";
import hmySz01 from "./maps/hmy_sz_01.json";
import njdCr01 from "./maps/njd_cr_01.json";
import { type LevelMapDefinition, type LevelMapId, LEVEL_MAP_IDS, isLevelMapId } from "./levelSchema";
import { validateLevelMapDefinition } from "./levelValidator";

const DEFAULT_MAP_ID: LevelMapId = "NJD_CR_01";

const MAP_REGISTRY: Record<LevelMapId, LevelMapDefinition> = {
  NJD_CR_01: njdCr01 as LevelMapDefinition,
  HMY_SZ_01: hmySz01 as LevelMapDefinition,
  FDD_PH_01: fddPh01 as LevelMapDefinition,
};

export class LevelDataError extends Error {
  readonly code = "LEVEL_DATA_INVALID";
  readonly mapId: string;
  readonly details: string[];

  constructor(mapId: string, details: string[]) {
    super(`[LEVEL_DATA_INVALID] map=${mapId} :: ${details.join(" | ")}`);
    this.name = "LevelDataError";
    this.mapId = mapId;
    this.details = details;
  }
}

export function listLevelMapIds(): readonly LevelMapId[] {
  return LEVEL_MAP_IDS;
}

export function resolveLevelMapId(rawMapId?: string | null): LevelMapId {
  if (!rawMapId) {
    return DEFAULT_MAP_ID;
  }

  const normalized = rawMapId.trim().toUpperCase();
  return isLevelMapId(normalized) ? normalized : DEFAULT_MAP_ID;
}

function cloneMapDefinition(definition: LevelMapDefinition): LevelMapDefinition {
  return JSON.parse(JSON.stringify(definition)) as LevelMapDefinition;
}

export function loadLevelMapDefinition(rawMapId?: string | null): LevelMapDefinition {
  const mapId = resolveLevelMapId(rawMapId);
  const source = MAP_REGISTRY[mapId];

  const definition = cloneMapDefinition(source);
  const validation = validateLevelMapDefinition(definition);

  if (!validation.ok) {
    throw new LevelDataError(mapId, validation.errors);
  }

  if (validation.warnings.length > 0) {
    console.warn(`[level] validation warnings map=${mapId}`, validation.warnings);
  }

  return definition;
}
