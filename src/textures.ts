// Pixi-free builtin-texture entry (@particlr/runtime/textures). The
// generators are pure-math RGBA buffers shared by every adapter; ./pixi
// re-exports the same functions for existing consumers.
export { generateBuiltinTexture, type TextureData } from "./pixi/textures.js";
