import * as THREE from "three";
import type { PrefabPlacement } from "../data/levelSchema";
import { mapCoordToWorld } from "../data/levelSchema";
import { createAabbCollider, type LevelStaticCollider } from "../runtime/levelCollision";
import type { PrefabCatalogItem } from "./prefabTypes";

export interface PrefabBuildResult {
  root: THREE.Group;
  colliders: LevelStaticCollider[];
  debugAnchor: THREE.Vector3;
}

function createBushMesh(item: PrefabCatalogItem): THREE.Object3D {
  const radius = Math.max(0.2, item.size.x * 0.5);
  const canopy = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.72, radius, item.size.y, 14),
    new THREE.MeshStandardMaterial({
      color: item.color,
      roughness: 0.95,
      metalness: 0.02,
      transparent: true,
      opacity: item.opacity ?? 0.58,
    }),
  );

  canopy.position.y = item.size.y * 0.5;
  canopy.castShadow = false;
  canopy.receiveShadow = true;
  return canopy;
}

function createRampMesh(item: PrefabCatalogItem): THREE.Object3D {
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(item.size.x, item.size.y, item.size.z),
    new THREE.MeshStandardMaterial({ color: item.color, roughness: 0.9, metalness: 0.04 }),
  );
  ramp.position.y = item.size.y * 0.5;
  ramp.castShadow = Boolean(item.castsShadow);
  ramp.receiveShadow = Boolean(item.receivesShadow);
  return ramp;
}

function createJumpPadMesh(item: PrefabCatalogItem): THREE.Object3D {
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(item.size.x * 0.55, item.size.x * 0.65, item.size.y, 18),
    new THREE.MeshStandardMaterial({
      color: item.color,
      emissive: 0x0f4d66,
      emissiveIntensity: 0.45,
      roughness: 0.3,
      metalness: 0.15,
      transparent: true,
      opacity: 0.88,
    }),
  );
  pad.position.y = item.size.y * 0.5;
  return pad;
}

function createDefaultBlockMesh(item: PrefabCatalogItem): THREE.Object3D {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(item.size.x, item.size.y, item.size.z),
    new THREE.MeshStandardMaterial({
      color: item.color,
      roughness: 0.85,
      metalness: 0.04,
      transparent: typeof item.opacity === "number",
      opacity: item.opacity ?? 1,
    }),
  );

  mesh.position.y = item.size.y * 0.5;
  mesh.castShadow = Boolean(item.castsShadow ?? true);
  mesh.receiveShadow = Boolean(item.receivesShadow ?? true);
  return mesh;
}

function createPrefabMesh(item: PrefabCatalogItem): THREE.Object3D {
  if (item.code.startsWith("BUSH_")) {
    return createBushMesh(item);
  }
  if (item.code === "RAMP_10") {
    return createRampMesh(item);
  }
  if (item.code === "PAD_JUMP") {
    return createJumpPadMesh(item);
  }
  return createDefaultBlockMesh(item);
}

export function buildPrefab(
  placement: PrefabPlacement,
  catalogItem: PrefabCatalogItem,
): PrefabBuildResult {
  const world = mapCoordToWorld({ x: placement.x, y: placement.y, z: placement.z });
  const rotDeg = Number.isFinite(placement.rotDeg) ? (placement.rotDeg as number) : 0;

  const root = new THREE.Group();
  root.name = `prefab:${placement.id}`;
  root.position.set(world.x, world.y, world.z);
  root.rotation.y = THREE.MathUtils.degToRad(rotDeg);

  const mesh = createPrefabMesh(catalogItem);
  root.add(mesh);

  const colliderKind = catalogItem.collider === "trigger" ? "trigger" : catalogItem.collider === "ramp" ? "ramp" : "box";
  const colliders: LevelStaticCollider[] = [
    createAabbCollider({
      id: placement.id,
      sourcePrefabCode: placement.prefabCode,
      kind: colliderKind,
      centerX: world.x,
      centerY: world.y + catalogItem.size.y * 0.5,
      centerZ: world.z,
      sizeX: catalogItem.size.x,
      sizeY: catalogItem.size.y,
      sizeZ: catalogItem.size.z,
      rotDeg,
      blocksMovement: catalogItem.blocksMovement,
      blocksProjectile: catalogItem.blocksProjectile,
      blocksLineOfSight: catalogItem.blocksLineOfSight,
    }),
  ];

  const debugAnchor = new THREE.Vector3(world.x, world.y + catalogItem.size.y + 0.25, world.z);

  return { root, colliders, debugAnchor };
}
