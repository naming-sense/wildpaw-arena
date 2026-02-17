import * as THREE from "three";

export interface SceneRoot {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createSceneRoot(): SceneRoot {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1119);
  scene.fog = new THREE.Fog(0x0d1119, 18, 72);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 250);
  camera.position.set(0, 12, 10);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x1f2a2e, roughness: 0.95, metalness: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(120, 60, 0x4d6688, 0x263346);
  grid.position.y = 0.01;
  scene.add(grid);

  return { scene, camera };
}
