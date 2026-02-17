import * as THREE from "three";

export function createMainLights(scene: THREE.Scene): void {
  const hemi = new THREE.HemisphereLight(0xa7c4ff, 0x1f232f, 0.5);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff2dd, 1.0);
  key.position.set(8, 18, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xa4c3ff, 0.4);
  fill.position.set(-12, 10, -8);
  scene.add(fill);
}
