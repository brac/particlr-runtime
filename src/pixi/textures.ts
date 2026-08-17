// Pixel math moved to src/texgen (V2_DESIGN Part 1: adapter-shared texgen so
// the Pixi and Three adapters consume ONE implementation). This module stays
// as the public re-export site: `@particlr/runtime/pixi` exported these names
// before the move and must keep doing so.
export {
  generateBuiltinTexture,
  generateDissolveNoise,
  dissolveNoiseValue,
  type TextureData,
} from "../texgen/index.js";
