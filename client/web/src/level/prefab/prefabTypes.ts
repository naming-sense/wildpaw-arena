export type PrefabColliderType = "box" | "capsule" | "ramp" | "trigger";

export type MinimapLayerType = "cover" | "bush" | "wall" | "objective" | "path" | "utility";

export interface PrefabCatalogItem {
  code: string;
  collider: PrefabColliderType;
  size: { x: number; y: number; z: number };
  color: number;
  opacity?: number;
  blocksLineOfSight: boolean;
  blocksProjectile: boolean;
  blocksMovement: boolean;
  minimapLayer: MinimapLayerType;
  receivesShadow?: boolean;
  castsShadow?: boolean;
}
