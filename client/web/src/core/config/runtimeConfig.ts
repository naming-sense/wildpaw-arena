export interface RuntimeConfig {
  simulation: {
    fixedDtMs: number;
    worldBounds: { min: number; max: number };
    playerSpeed: number;
    hardSnapThreshold: number;
    smoothCorrectionAlpha: number;
  };
  net: {
    sendHz: number;
    interpolationDelayMs: number;
    maxExtrapolationMs: number;
    reconnectMinMs: number;
    reconnectMaxMs: number;
  };
  render: {
    cameraHeight: number;
    cameraTiltDeg: number;
    shadowMapSize: number;
  };
}

export function createRuntimeConfig(): RuntimeConfig {
  return {
    simulation: {
      fixedDtMs: 33.333,
      worldBounds: { min: -24, max: 24 },
      playerSpeed: 5.0,
      hardSnapThreshold: 1.35,
      smoothCorrectionAlpha: 0.35,
    },
    net: {
      sendHz: 30,
      interpolationDelayMs: 40,
      maxExtrapolationMs: 220,
      reconnectMinMs: 500,
      reconnectMaxMs: 4000,
    },
    render: {
      cameraHeight: 13,
      cameraTiltDeg: 42,
      shadowMapSize: 1024,
    },
  };
}
