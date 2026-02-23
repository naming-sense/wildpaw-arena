export interface HeroAssetManifest {
  heroId: string;
  gltfPath: string;
  idleClip: string;
  walkClip?: string;
  runClip: string;
}

const CAT_SOLDIER_GLB =
  "/assets/heroes/cat-soldier-variant-regen-50k-webp2k-safe-nogun-anim-pack-mixamo-directrig-png.glb";
const BRUNO_DIRECTRIG_GLB =
  "/assets/heroes/bruno_bear_50k-nogun-anim-pack-mixamo-directrig-png.glb";

const sharedAnim = {
  gltfPath: CAT_SOLDIER_GLB,
  idleClip: "Idle",
  walkClip: "Walk",
  runClip: "Run",
} satisfies Omit<HeroAssetManifest, "heroId">;

const brunoAnim = {
  gltfPath: BRUNO_DIRECTRIG_GLB,
  idleClip: "Idle",
  walkClip: "Walk",
  runClip: "Run",
} satisfies Omit<HeroAssetManifest, "heroId">;

export const HERO_ASSET_MANIFEST: HeroAssetManifest[] = [
  { heroId: "lumifox", ...sharedAnim },
  { heroId: "bruno_bear", ...brunoAnim },
  { heroId: "stinkrat", ...sharedAnim },
  { heroId: "milky_rabbit", ...sharedAnim },
  { heroId: "iris_wolf", ...sharedAnim },
  { heroId: "coral_cat", ...sharedAnim },
  { heroId: "rockhorn_rhino", ...sharedAnim },
  { heroId: "pearl_panda", ...sharedAnim },
  // backward compatibility with old id
  { heroId: "whitecat_commando", ...sharedAnim },
];
