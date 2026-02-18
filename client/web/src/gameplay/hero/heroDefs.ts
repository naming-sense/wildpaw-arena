export interface HeroDef {
  id: string;
  displayName: string;
  role: "Vanguard" | "Striker" | "Skirmisher" | "Controller" | "Support" | "SupportController";
  baseHp: number;
  moveSpeed: number;
  weaponId: string;
  skillIds: [string, string, string];
}

export const HERO_DEFS: HeroDef[] = [
  {
    id: "lumifox",
    displayName: "루미폭스",
    role: "Skirmisher",
    baseHp: 2400,
    moveSpeed: 6.1,
    weaponId: "dual_smg",
    skillIds: ["lumifox_q", "lumifox_e", "lumifox_r"],
  },
  {
    id: "bruno_bear",
    displayName: "브루노 베어",
    role: "Vanguard",
    baseHp: 3400,
    moveSpeed: 4.7,
    weaponId: "heavy_shotgun",
    skillIds: ["bruno_q", "bruno_e", "bruno_r"],
  },
  {
    id: "stinkrat",
    displayName: "스팅크랫",
    role: "Controller",
    baseHp: 2800,
    moveSpeed: 5.0,
    weaponId: "gas_launcher",
    skillIds: ["stinkrat_q", "stinkrat_e", "stinkrat_r"],
  },
  {
    id: "milky_rabbit",
    displayName: "밀키 래빗",
    role: "Support",
    baseHp: 2550,
    moveSpeed: 5.6,
    weaponId: "burst_pistol",
    skillIds: ["milky_q", "milky_e", "milky_r"],
  },
  {
    id: "iris_wolf",
    displayName: "아이리스 울프",
    role: "Striker",
    baseHp: 2950,
    moveSpeed: 5.4,
    weaponId: "assault_rifle",
    skillIds: ["iris_q", "iris_e", "iris_r"],
  },
  {
    id: "coral_cat",
    displayName: "코랄 캣",
    role: "Skirmisher",
    baseHp: 2450,
    moveSpeed: 5.9,
    weaponId: "dmr",
    skillIds: ["coral_q", "coral_e", "coral_r"],
  },
  {
    id: "rockhorn_rhino",
    displayName: "록혼 라이노",
    role: "Vanguard",
    baseHp: 3350,
    moveSpeed: 4.6,
    weaponId: "minigun",
    skillIds: ["rhino_q", "rhino_e", "rhino_r"],
  },
  {
    id: "pearl_panda",
    displayName: "펄 팬더",
    role: "SupportController",
    baseHp: 2750,
    moveSpeed: 5.2,
    weaponId: "beamgun",
    skillIds: ["panda_q", "panda_e", "panda_r"],
  },
];

export const HERO_DEF_BY_ID = new Map(HERO_DEFS.map((hero) => [hero.id, hero]));
