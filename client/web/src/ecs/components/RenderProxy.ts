import type * as THREE from "three";

export interface RenderAnimationState {
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  idleClip: string;
  runClip: string;
  activeClip: string;
  moveThreshold: number;
}

export interface RenderProxy {
  object3d: THREE.Object3D;
  animation?: RenderAnimationState;
}
