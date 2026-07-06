// Public surface of the simulation core (framework-agnostic, Node-safe).
export { mulberry32, deriveLayerSeed, type Rng } from "./prng.js";
export { EASING, ease, type EaseFn } from "./easing.js";
export {
  sampleScalarInit,
  evalCurve,
  evalScalarTrack,
  evalGradient,
  type RGBA,
} from "./tracks.js";
