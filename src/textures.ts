// Pixi-free builtin-texture entry (@particlr/runtime/textures). The
// generators are pure-math RGBA buffers shared by every adapter; imported
// directly from texgen (not routed through ./pixi/textures.js) so this
// subpath pulls in zero Pixi code even transitively. ./pixi re-exports the
// same functions for existing consumers.
export { generateBuiltinTexture, type TextureData } from "./texgen/index.js";
