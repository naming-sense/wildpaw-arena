export interface WeaponDef {
  id: string;
  className: string;
  fireRate: number;
  damage: number;
  range: number;
  ammo: number;
  reloadMs: number;
  critMultiplier: number;
}

export const WEAPON_DEFS: WeaponDef[] = [
  {
    id: "dual_smg",
    className: "Dual SMG",
    fireRate: 10.4,
    damage: 62,
    range: 9.0,
    ammo: 28,
    reloadMs: 1450,
    critMultiplier: 1.3,
  },
  {
    id: "heavy_shotgun",
    className: "Heavy Shotgun",
    fireRate: 1.05,
    damage: 637,
    range: 5.5,
    ammo: 6,
    reloadMs: 1900,
    critMultiplier: 1.2,
  },
  {
    id: "gas_launcher",
    className: "Gas Launcher",
    fireRate: 2.35,
    damage: 205,
    range: 10.5,
    ammo: 8,
    reloadMs: 1800,
    critMultiplier: 1.15,
  },
  {
    id: "burst_pistol",
    className: "Burst Pistol",
    fireRate: 6.1,
    damage: 79,
    range: 10.5,
    ammo: 18,
    reloadMs: 1550,
    critMultiplier: 1.35,
  },
  {
    id: "assault_rifle",
    className: "AR",
    fireRate: 8.5,
    damage: 72,
    range: 11.5,
    ammo: 30,
    reloadMs: 1650,
    critMultiplier: 1.35,
  },
  {
    id: "dmr",
    className: "DMR",
    fireRate: 3.1,
    damage: 178,
    range: 16.0,
    ammo: 12,
    reloadMs: 1750,
    critMultiplier: 1.45,
  },
  {
    id: "minigun",
    className: "Minigun",
    fireRate: 11.5,
    damage: 44,
    range: 10.5,
    ammo: 120,
    reloadMs: 2200,
    critMultiplier: 1.2,
  },
  {
    id: "beamgun",
    className: "Energy Beamgun",
    fireRate: 12.0,
    damage: 44,
    range: 9.5,
    ammo: 100,
    reloadMs: 1700,
    critMultiplier: 1.1,
  },
];

export const WEAPON_DEF_BY_ID = new Map(WEAPON_DEFS.map((weapon) => [weapon.id, weapon]));
