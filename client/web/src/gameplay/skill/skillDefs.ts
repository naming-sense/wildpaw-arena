export interface SkillDef {
  id: string;
  cooldownMs: number;
  range: number;
  damage: number;
  radius: number;
  castTime: number;
  fxId: string;
  sfxId: string;
}

export const SKILL_DEFS: SkillDef[] = [
  {
    id: "dash_q",
    cooldownMs: 4000,
    range: 6,
    damage: 80,
    radius: 0,
    castTime: 0,
    fxId: "fx_dash",
    sfxId: "sfx_dash",
  },
  {
    id: "smoke_e",
    cooldownMs: 6500,
    range: 10,
    damage: 0,
    radius: 3,
    castTime: 150,
    fxId: "fx_smoke",
    sfxId: "sfx_smoke",
  },
  {
    id: "barrage_r",
    cooldownMs: 18000,
    range: 12,
    damage: 320,
    radius: 2,
    castTime: 500,
    fxId: "fx_barrage",
    sfxId: "sfx_barrage",
  },
];
