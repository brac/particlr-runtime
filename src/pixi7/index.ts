// @particlr/runtime/pixi7 — Pixi v7 adapter entry. pixi.js is a peer dependency
// (peer range ">=7.2.0 <9"; this adapter is developed and golden-tested against
// 7.4.3 — see the runtime README subpath-per-major note).
//
// Per ruling R4 the v7 entry mirrors the v8 entry's PUBLIC shape so migrating
// between majors is a one-line import change: same `PixiParticleRenderer` /
// `PixiParticleRendererOptions` / `generateBuiltinTexture` / `TextureData`
// surface. Trail/dissolve internals are deliberately NOT re-exported here
// (tighter than the v8 entry, which exposes makeTrailView — R4: do not widen).
// `textures.ts` has zero pixi imports and is SHARED as-is with the v8 adapter
// (re-exported through ../pixi/textures.js via renderer.ts — never copied).
export {
  PixiParticleRenderer,
  generateBuiltinTexture,
  type PixiParticleRendererOptions,
  type TextureData,
} from "./renderer.js";
