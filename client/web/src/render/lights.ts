import * as THREE from "three";

interface MainLightsOptions {
  quality?: "performance" | "balanced" | "quality";
  shadowsEnabled?: boolean;
  shadowMapSize?: number;
}

export function createMainLights(scene: THREE.Scene, options: MainLightsOptions = {}): void {
  const quality = options.quality ?? "quality";
  const shadowsEnabled = options.shadowsEnabled ?? true;
  const shadowMapSize = Math.max(256, options.shadowMapSize ?? 1024);

  const hemi = new THREE.HemisphereLight(0xbdd3ff, 0x2f3846, quality === "performance" ? 0.92 : 0.85);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xf1f5ff, quality === "performance" ? 0.24 : 0.2);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xfff2dd, quality === "performance" ? 0.88 : 1.18);
  key.position.set(10, 20, 12);
  key.castShadow = shadowsEnabled;

  if (shadowsEnabled) {
    key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.02;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 80;
    const shadowCamera = key.shadow.camera as THREE.OrthographicCamera;
    shadowCamera.left = -30;
    shadowCamera.right = 30;
    shadowCamera.top = 30;
    shadowCamera.bottom = -30;
  }

  key.target.position.set(0, 0, 0);
  scene.add(key.target);
  scene.add(key);

  if (quality !== "performance") {
    const fill = new THREE.DirectionalLight(0xb8d2ff, quality === "balanced" ? 0.5 : 0.62);
    fill.position.set(-14, 12, -10);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0x95bcff, quality === "balanced" ? 0.2 : 0.28);
    rim.position.set(0, 10, -18);
    scene.add(rim);
  }
}
