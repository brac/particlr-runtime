// @particlr/runtime/pixi7 — Pixi v7 adapter entry. pixi.js is a peer dependency
// (peer range ">=7.2.0 <9"; this adapter is developed and golden-tested against
// 7.4.3 — see the runtime README subpath-per-major note).
//
// M0 STUB: only the pixi-free shared texture surface is re-exported so the
// packaging/typecheck plumbing lands first. `PixiParticleRenderer` (and its
// options) arrive in M1 (src/pixi7/renderer.ts). Per ruling R4, the v7 entry
// mirrors the v8 entry's public shape so migrating between majors is a one-line
// import change. `textures.ts` has zero pixi imports and is SHARED as-is with
// the v8 adapter (imported from ../pixi/textures.js — never copied).
export { generateBuiltinTexture, type TextureData } from "../pixi/textures.js";
