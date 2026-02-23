import type * as THREE from "three";

export interface RenderAnimationState {
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  idleClip: string;
  walkClip?: string;
  runClip: string;
  hitClip?: string;
  dieClip?: string;
  activeClip: string;
  moveThreshold: number;
  hitReactUntilMs: number;
  isDead: boolean;
}

export interface RenderProxy {
  object3d: THREE.Object3D;
  animation?: RenderAnimationState;
}
