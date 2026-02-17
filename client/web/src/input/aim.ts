import * as THREE from "three";

export interface AimTarget {
  x: number;
  y: number;
}

const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
const ndc = new THREE.Vector2();

export function resolveAimOnGround(camera: THREE.Camera, ndcX: number, ndcY: number): AimTarget {
  ndc.set(ndcX, ndcY);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(plane, hit)) {
    return { x: 0, y: 0 };
  }

  return { x: hit.x, y: hit.z };
}
