export interface HeroAssetManifest {
  heroId: string;
  gltfPath: string;
  idleClip: string;
  walkClip?: string;
  runClip: string;
}

const CORAL_CAT_GLB =
  "/assets/heroes/cat-soldier-variant-regen-50k-webp2k-safe-nogun-anim-pack-mixamo-directrig-png.glb";

const coralCatAnim = {
  gltfPath: CORAL_CAT_GLB,
  idleClip: "Idle",
  walkClip: "Walk",
  runClip: "Run",
} satisfies Omit<HeroAssetManifest, "heroId">;

function animatedHero(gltfPath: string): Omit<HeroAssetManifest, "heroId"> {
  return {
    gltfPath,
    idleClip: "Idle",
    walkClip: "Walk",
    runClip: "Run",
  };
}

function staticHero(gltfPath: string): Omit<HeroAssetManifest, "heroId"> {
  return {
    gltfPath,
    // Static hero exports currently have no clips. These names keep the loader contract
    // stable and are ignored when the GLB animation array is empty.
    idleClip: "Idle",
    runClip: "Run",
  };
}

const brunoAnim = animatedHero(
  "/assets/heroes/bruno_bear_50k-nogun-anim-pack-mixamo-directrig-png.glb",
);
const stinkratAnim = animatedHero(
  "/assets/heroes/sting_weasel_50k-anim-pack-skincopy-inplace.glb",
);
const milkyAnim = animatedHero(
  "/assets/heroes/milky_rabbit_50k-anim-pack-skincopy-inplace.glb",
);
const rockhornAnim = animatedHero(
  "/assets/heroes/rockhorn_rhino_50k-anim-pack-skincopy-inplace.glb",
);
const pearlAnim = animatedHero(
  "/assets/heroes/pearl_panda_50k-anim-pack-skincopy-inplace.glb",
);
const lumifoxStatic = staticHero("/assets/heroes/lumi_fox_50k-nogun.glb");
const irisStatic = staticHero("/assets/heroes/iris_wolf_50k-nogun.glb");

const legacyCoralAnim = {
  gltfPath: CORAL_CAT_GLB,
  idleClip: "Idle",
  walkClip: "Walk",
  runClip: "Run",
} satisfies Omit<HeroAssetManifest, "heroId">;

export const HERO_ASSET_MANIFEST: HeroAssetManifest[] = [
  { heroId: "lumifox", ...lumifoxStatic },
  { heroId: "bruno_bear", ...brunoAnim },
  { heroId: "stinkrat", ...stinkratAnim },
  { heroId: "milky_rabbit", ...milkyAnim },
  { heroId: "iris_wolf", ...irisStatic },
  { heroId: "coral_cat", ...coralCatAnim },
  { heroId: "rockhorn_rhino", ...rockhornAnim },
  { heroId: "pearl_panda", ...pearlAnim },
  // backward compatibility with old id
  { heroId: "whitecat_commando", ...legacyCoralAnim },
];
