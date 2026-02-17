export interface HeroAssetManifest {
  heroId: string;
  gltfPath: string;
  idleClip: string;
  walkClip?: string;
  runClip: string;
}

export const HERO_ASSET_MANIFEST: HeroAssetManifest[] = [
  {
    heroId: "whitecat_commando",
    gltfPath: "/assets/heroes/cat-soldier-variant-regen-50k-webp2k-safe-nogun-anim-pack-mixamo-directrig-png.glb",
    idleClip: "Idle",
    walkClip: "Walk",
    runClip: "Run",
  },
];
