// Sprite material for the Three adapter (V2_DESIGN Part 1): one RawShaderMaterial
// per layer, instanced over a unit quad. RawShaderMaterial (not ShaderMaterial)
// so three injects NO attribute declarations, NO color-space transform and NO
// tone mapping — the output convention matches Pixi's un-color-managed pipeline
// exactly. Textures are uploaded straight-alpha; the fragment multiplies in
// straight alpha and writes PREMULTIPLIED output, so every tuple in the blend
// table below assumes a premultiplied source. Uniform names/semantics:
//   uTexture — layer texture (whole sheet for flipbooks; UV window per instance)
//   uCols/uRows — flipbook grid (1/1 when single-frame)
//   uAspect — frameHeight / frameWidth: a particle renders `size` px wide and
//             `size * uAspect` px tall, matching Pixi's `scale = size *
//             invFrameWidth` sizing rule (renderer.ts P4.1)
//   uBillboard — 0: quad lives in the group's local XY plane; 1: the corner
//                offset is applied in VIEW space after transforming the
//                instance center, so every particle faces the camera. This is
//                the "~15 lines of view-matrix handling" V2 priced in.
import { RawShaderMaterial, CustomBlending, AddEquation, OneFactor, ZeroFactor, OneMinusSrcAlphaFactor, OneMinusSrcColorFactor, DstColorFactor, type Material, type Texture, type BlendingSrcFactor, type BlendingDstFactor } from "three";
import type { BlendMode } from "../format/types.js";

export const spriteVertexGl = `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uCols;
uniform float uRows;
uniform float uAspect;
uniform float uBillboard;

attribute vec3 position;   // unit quad corner, x/y in [-0.5, 0.5], z = 0
attribute vec2 uv;         // top-left-origin quad UV (v = 0 at top)
attribute vec2 aInstPos;   // sim x, NEGATED sim y (adapter convention)
attribute float aSize;     // px
attribute vec4 aColor;     // straight-alpha tint (gradient x tint chain)
attribute float aFrame;    // flipbook frame index
attribute float aStretch;  // along-motion stretch multiplier
attribute float aAngle;    // radians, NEGATED sim angle (adapter convention)
attribute float aFlip;     // bitmask: 1 = flip X, 2 = flip Y

varying vec2 vUV;
varying vec4 vColor;

void main() {
  float col = mod(aFrame, uCols);
  float row = floor(aFrame / uCols);
  vUV = (vec2(col, row) + uv) / vec2(uCols, uRows);
  vColor = aColor;

  vec2 corner = position.xy * vec2(aSize * aStretch, aSize * uAspect);
  if (mod(aFlip, 2.0) >= 1.0) corner.x = -corner.x;
  if (aFlip >= 2.0) corner.y = -corner.y;
  float c = cos(aAngle);
  float s = sin(aAngle);
  vec2 p = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);

  if (uBillboard > 0.5) {
    vec4 center = modelViewMatrix * vec4(aInstPos, 0.0, 1.0);
    gl_Position = projectionMatrix * vec4(center.xy + p, center.z, center.w);
  } else {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aInstPos + p, 0.0, 1.0);
  }
}
`;

export const spriteFragmentGl = `precision highp float;
uniform sampler2D uTexture;
varying vec2 vUV;
varying vec4 vColor;

void main() {
  vec4 texel = texture2D(uTexture, vUV); // straight alpha
  vec3 rgb = texel.rgb * vColor.rgb;
  float a = texel.a * vColor.a;
  gl_FragColor = vec4(rgb * a, a);
}
`;

// The normative blend table (plan header). Premultiplied-source tuples.
const BLEND: Record<BlendMode, [src: BlendingSrcFactor, dst: BlendingDstFactor]> = {
  normal: [OneFactor, OneMinusSrcAlphaFactor],
  add: [OneFactor, OneFactor],
  multiply: [DstColorFactor, OneMinusSrcAlphaFactor],
  screen: [OneFactor, OneMinusSrcColorFactor],
  erase: [ZeroFactor, OneMinusSrcAlphaFactor],
};

export function applyBlend(mat: Material, blend: BlendMode): void {
  const [src, dst] = BLEND[blend];
  mat.blending = CustomBlending;
  mat.blendEquation = AddEquation;
  mat.blendSrc = src;
  mat.blendDst = dst;
  mat.transparent = true;
  mat.depthWrite = false;
}

export function makeSpriteMaterial(texture: Texture, blend: BlendMode): RawShaderMaterial {
  const mat = new RawShaderMaterial({
    vertexShader: spriteVertexGl,
    fragmentShader: spriteFragmentGl,
    uniforms: {
      uTexture: { value: texture },
      uCols: { value: 1 },
      uRows: { value: 1 },
      uAspect: { value: 1 },
      uBillboard: { value: 0 },
    },
  });
  applyBlend(mat, blend);
  return mat;
}
