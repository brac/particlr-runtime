// Dissolve / alpha-erosion material for the Three adapter (schemaVersion 4,
// 0.3c). Reuses spriteVertexGl unchanged (vUV/vColor pass through identically
// to the plain sprite path) and swaps in an erosion fragment ported from the
// Pixi shader (src/pixi/dissolveShader.ts:91-131). Simpler here: Three's
// straight-alpha upload/tint convention (materials.ts) means there is no
// un-premultiply step — the erosion math runs directly on texel.a / vColor.a
// and the final write is straight RGB re-premultiplied by the eroded alpha,
// same as the plain sprite fragment when d=1 (byte-identical, same guarantee
// Pixi documents at dissolveShader.ts:88-90).
import { RawShaderMaterial, DoubleSide, type Texture } from "three";
import type { BlendMode, DissolveConfig } from "../format/types.js";
import { spriteVertexGl, applyBlend } from "./materials.js";
import { dissolveNoiseTexture } from "./textures.js";

export const dissolveFragmentGl = `precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uDissolveNoise;
uniform float uTime;
uniform float uFrequency;
uniform vec2 uScroll;
uniform float uEdgeWidth;
uniform vec4 uEdgeColor;
varying vec2 vUV;
varying vec4 vColor;

void main() {
  vec4 texel = texture2D(uTexture, vUV);      // straight alpha
  float a = vColor.a;                          // the render alpha chain drives the erosion (0.3c)
  float n = texture2D(uDissolveNoise, vUV * uFrequency + uTime * uScroll).r;
  float ew = max(uEdgeWidth, 1e-4);
  float t = (1.0 - a) * (1.0 + uEdgeWidth) - uEdgeWidth;
  float d = smoothstep(t, t + ew, n);
  vec3 rgb = texel.rgb * vColor.rgb + uEdgeColor.rgb * uEdgeColor.a * (d * (1.0 - d) * 4.0);
  float alpha = texel.a * d;
  gl_FragColor = vec4(rgb * alpha, alpha);
}
`;

/**
 * Build the dissolve RawShaderMaterial for a layer whose `dissolve` config is
 * non-null. Uniform set = the sprite group (uTexture/uCols/uRows/uAspect/
 * uBillboard, filled by the renderer exactly like makeSpriteMaterial) plus the
 * dissolve group. `edgeColor: null` becomes the branchless [0,0,0,0] no-op
 * (Pixi convention, dissolveShader.ts:301-304). The noise texture is the
 * shared, never-destroyed module-scope tile (textures.ts dissolveNoiseTexture).
 *
 * Known divergence from Pixi (documented, not fixed — README Task 12): when a
 * layer combines a flipbook with dissolve, this samples the noise at the
 * per-frame WINDOWED uv (vUV already includes the flipbook cell offset/scale
 * from spriteVertexGl), whereas Pixi's dissolve shader samples at raw SHEET
 * uv. The erosion pattern therefore shifts per flipbook frame here but not in
 * Pixi. Raster goldens are per-adapter and never cross-compared, so this does
 * not fail any test — it is a visual difference between adapters.
 */
export function makeDissolveMaterial(texture: Texture, blend: BlendMode, cfg: DissolveConfig): RawShaderMaterial {
  const edge = cfg.edgeColor;
  const mat = new RawShaderMaterial({
    vertexShader: spriteVertexGl,
    fragmentShader: dissolveFragmentGl,
    uniforms: {
      uTexture: { value: texture },
      uCols: { value: 1 },
      uRows: { value: 1 },
      uAspect: { value: 1 },
      uBillboard: { value: 0 },
      uDissolveNoise: { value: dissolveNoiseTexture() },
      uTime: { value: 0 },
      uFrequency: { value: cfg.frequency },
      // Plain arrays (not Float32Array): a Float32Array round-trips 0.1 as
      // 0.10000000149011612, which would silently corrupt authored scroll/
      // edge-color values. Three's WebGLUniforms accepts either for vec2/vec4.
      uScroll: { value: [cfg.scroll.x, cfg.scroll.y] },
      uEdgeWidth: { value: cfg.edgeWidth },
      uEdgeColor: { value: edge ? [edge.r, edge.g, edge.b, edge.a] : [0, 0, 0, 0] },
    },
    side: DoubleSide, // never FrontSide — see materials.ts, above makeSpriteMaterial
  });
  applyBlend(mat, blend);
  return mat;
}
