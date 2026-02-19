import * as THREE from "three";

export function createMainLights(scene: THREE.Scene): void {
  // Base ambient lift to avoid over-dark midtones on mobile displays.
  const hemi = new THREE.HemisphereLight(0xbdd3ff, 0x2f3846, 0.85);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xf1f5ff, 0.2);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xfff2dd, 1.18);
  key.position.set(10, 20, 12);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 80;
  const shadowCamera = key.shadow.camera as THREE.OrthographicCamera;
  shadowCamera.left = -30;
  shadowCamera.right = 30;
  shadowCamera.top = 30;
  shadowCamera.bottom = -30;
  key.target.position.set(0, 0, 0);
  scene.add(key.target);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xb8d2ff, 0.62);
  fill.position.set(-14, 12, -10);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x95bcff, 0.28);
  rim.position.set(0, 10, -18);
  scene.add(rim);
}
