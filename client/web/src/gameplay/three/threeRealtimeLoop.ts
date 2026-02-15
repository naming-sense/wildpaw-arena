import * as THREE from "three";

import {
  RealtimeEcsRuntime,
  type RuntimeInputState,
} from "../ecs/realtimeEcsRuntime";
import { ThreeCombatSceneAdapter } from "./threeCombatSceneAdapter";

export interface ThreeRealtimeLoopOptions {
  roomToken: string;
  url: string;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  sampleInput: () => RuntimeInputState;
  inputIntervalMs?: number;
}

export function startThreeRealtimeLoop(options: ThreeRealtimeLoopOptions): () => void {
  const adapter = new ThreeCombatSceneAdapter(options.scene);
  const runtime = new RealtimeEcsRuntime({
    url: options.url,
    roomToken: options.roomToken,
    renderAdapter: adapter,
  });

  runtime.start();

  const inputInterval = window.setInterval(() => {
    runtime.sendInput(options.sampleInput());
  }, options.inputIntervalMs ?? 50);

  let rafId = 0;
  const frame = (timeMs: number) => {
    runtime.step(timeMs);
    adapter.tick(timeMs);
    options.renderer.render(options.scene, options.camera);
    rafId = window.requestAnimationFrame(frame);
  };

  rafId = window.requestAnimationFrame(frame);

  return () => {
    window.cancelAnimationFrame(rafId);
    window.clearInterval(inputInterval);
    runtime.stop();
  };
}
