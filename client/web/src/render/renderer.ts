import * as THREE from "three";

export const WEBGL_UNSUPPORTED_ERROR = "WEBGL_UNSUPPORTED";

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    shadowMapSize: number,
  ) {
    const context =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);

    if (!context) {
      throw new Error(WEBGL_UNSUPPORTED_ERROR);
    }

    this.renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;

    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.autoUpdate = true;

    const target = this.renderer.getRenderTarget();
    if (target) {
      target.setSize(shadowMapSize, shadowMapSize);
    }

    window.addEventListener("resize", this.onResize);
    this.onResize();
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  private onResize = (): void => {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
  };
}
