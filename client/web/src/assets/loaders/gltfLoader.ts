import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const dracoLoaderByGltfLoader = new WeakMap<GLTFLoader, DRACOLoader>();

export function createGltfLoader(dracoDecoderPath = "/draco/"): GLTFLoader {
  const draco = new DRACOLoader();
  draco.setDecoderPath(dracoDecoderPath);

  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  dracoLoaderByGltfLoader.set(loader, draco);
  return loader;
}

export function disposeGltfLoader(loader: GLTFLoader): void {
  const draco = dracoLoaderByGltfLoader.get(loader);
  if (!draco) {
    return;
  }

  draco.dispose();
  dracoLoaderByGltfLoader.delete(loader);
}
