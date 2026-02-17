export interface WeaponDef {
  id: string;
  fireRate: number;
  damage: number;
  range: number;
  ammo: number;
}

export const WEAPON_DEFS: WeaponDef[] = [
  {
    id: "assault_rifle",
    fireRate: 8,
    damage: 110,
    range: 18,
    ammo: 30,
  },
];
