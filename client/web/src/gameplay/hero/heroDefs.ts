export interface HeroDef {
  id: string;
  displayName: string;
  baseHp: number;
  moveSpeed: number;
  weaponId: string;
  skillIds: [string, string, string];
}

export const HERO_DEFS: HeroDef[] = [
  {
    id: "whitecat_commando",
    displayName: "화이트캣 코만도",
    baseHp: 2400,
    moveSpeed: 5.0,
    weaponId: "assault_rifle",
    skillIds: ["dash_q", "smoke_e", "barrage_r"],
  },
];
