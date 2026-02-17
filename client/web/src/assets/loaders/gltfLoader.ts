import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export function createGltfLoader(dracoDecoderPath = "/draco/"): GLTFLoader {
  const draco = new DRACOLoader();
  draco.setDecoderPath(dracoDecoderPath);

  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return loader;
}
