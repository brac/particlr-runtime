// @particlr/runtime/three — Three.js adapter entry. `three` is an optional
// peer dependency. Renders the 2D sim on the host object's local XY plane
// (V2_DESIGN Part 1): NOT a 3D particle sim.
export { ThreeParticleRenderer, type ThreeParticleRendererOptions } from "./renderer.js";
export { builtinTexture, textureFromData } from "./textures.js";
export { makeTrailView, syncTrailView, type ThreeTrailView } from "./trailMesh.js";
