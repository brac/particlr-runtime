// Public surface of the simulation core (framework-agnostic, Node-safe).
export { mulberry32, deriveLayerSeed, type Rng } from "./prng.js";
export { EASING, ease, type EaseFn } from "./easing.js";
export {
  sampleScalarInit,
  drawScalarInit,
  evalCurve,
  evalScalarTrack,
  evalGradient,
  hueRotateRGB,
  type RGBA,
} from "./tracks.js";
export { sampleShape, type SpawnSample } from "./shapes.js";
export { buildMaskSampler, MaskSampler } from "./maskSampler.js";
export { ParticlePool } from "./pool.js";
export { TrailStore } from "./trails.js";
export { LayerSim } from "./layerSim.js";
export {
  computeTrailGeometry,
  makeTrailGeometry,
  type TrailGeometry,
} from "./trailGeometry.js";
export { Effect, MAX_DT } from "./effect.js";
export {
  computeRenderState,
  makeRenderBuffers,
  flipbookFrame,
  type LayerRenderBuffers,
} from "./render.js";
