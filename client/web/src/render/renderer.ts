import * as THREE from "three";

export const WEBGL_UNSUPPORTED_ERROR = "WEBGL_UNSUPPORTED";

export type RenderQualityMode = "performance" | "balanced" | "quality";

export interface GameRendererOptions {
  shadowMapSize: number;
  antialias?: boolean;
  pixelRatioScale?: number;
  maxPixelRatio?: number;
  shadowsEnabled?: boolean;
  toneMapping?: "none" | "aces";
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;

  private readonly pixelRatioScale: number;
  private readonly maxPixelRatio: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: GameRendererOptions,
  ) {
    const antialias = options.antialias ?? true;
    const contextAttributes: WebGLContextAttributes = {
      antialias,
      alpha: true,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
    };

    const context =
      (canvas.getContext("webgl2", contextAttributes) as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl", contextAttributes) as WebGLRenderingContext | null);

    if (!context) {
      throw new Error(WEBGL_UNSUPPORTED_ERROR);
    }

    this.pixelRatioScale = Math.max(0.35, Math.min(1, options.pixelRatioScale ?? 1));
    this.maxPixelRatio = Math.max(0.5, options.maxPixelRatio ?? 2);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      antialias,
    });

    this.renderer.setPixelRatio(this.resolvePixelRatio());
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    const shadowsEnabled = options.shadowsEnabled ?? true;
    this.renderer.shadowMap.enabled = shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = shadowsEnabled;
    this.renderer.shadowMap.needsUpdate = shadowsEnabled;

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping =
      options.toneMapping === "none" ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    if (shadowsEnabled) {
      const target = this.renderer.getRenderTarget();
      if (target) {
        target.setSize(options.shadowMapSize, options.shadowMapSize);
      }
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

  private resolvePixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(dpr * this.pixelRatioScale, this.maxPixelRatio);
  }

  private onResize = (): void => {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(this.resolvePixelRatio());
    this.renderer.setSize(width, height, false);
  };
}
