// Pixi v8 dissolve / alpha-erosion shader (schemaVersion 4, M3). A per-layer
// custom ParticleContainer shader: a TRUE dual-source fork of Pixi's own
// particle shader (`node_modules/pixi.js/.../shader/particles.{vert,frag,wgsl}`),
// verbatim EXCEPT the final color/alpha computation, which implements the
// dissolve fragment math (FORMAT_SPEC "Dissolve / alpha erosion" 0.3c).
//
// Why a raw fork (not composable high-shader bits like trailMesh.ts): Pixi's
// `ParticleShader` is @internal raw GLSL/WGSL, not exposed as shader bits, so we
// own the source and must track its attribute layout (aVertex/aPosition/aUV/
// aColor/aRotation) and uniform-group names (uTranslationMatrix/uColor/uRound/
// uResolution, the uTexture/uSampler binding) EXACTLY. This is guarded by the
// pinned pixi.js version + the shader canary test (§0.5). The dissolve golden
// preset on SwiftShader is the live-GL parity proof; the WGSL path ships
// unverified until a WebGPU golden lane exists (L4 attested on WebGL only).
//
// Texture-binding contract (the flagged integration risk, resolved): the v8
// particle pipe REBINDS the layer texture from `container.texture` every frame —
// GL: `shader.resources.uTexture = container.texture._source`
// (GlParticleContainerAdaptor); GPU: `shader.groups[1] =
// getTextureBindGroup(container.texture)` (GpuParticleContainerAdaptor). So a
// custom `shader` inherits the container's texture automatically: renderer.ts
// `applyTexture` only sets `pc.texture` and the swap follows for free — we do
// NOT (and must not) hand-update the shader's uTexture resource. Our dissolve
// noise + uniforms live in a SEPARATE resource group (WGSL @group(2)) the
// adaptor never touches, so they are authoritative from construction.
import {
  BufferImageSource,
  GlProgram,
  GpuProgram,
  Matrix,
  Shader,
  Texture,
} from "pixi.js";
import type { DissolveConfig } from "../format/types.js";
import { generateDissolveNoise } from "./textures.js";

// --- Forked shader sources (exported for the canary test) ------------------

// Vertex: VERBATIM copy of Pixi's particles.vert (unchanged — vUV/vColor pass
// through). Kept as our own string so a pixi upgrade that changes the attribute
// layout trips the canary instead of silently drifting.
export const dissolveVertexGl = `attribute vec2 aVertex;
attribute vec2 aUV;
attribute vec4 aColor;

attribute vec2 aPosition;
attribute float aRotation;

uniform mat3 uTranslationMatrix;
uniform float uRound;
uniform vec2 uResolution;
uniform vec4 uColor;

varying vec2 vUV;
varying vec4 vColor;

vec2 roundPixels(vec2 position, vec2 targetSize)
{
    return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

void main(void){
    float cosRotation = cos(aRotation);
    float sinRotation = sin(aRotation);
    float x = aVertex.x * cosRotation - aVertex.y * sinRotation;
    float y = aVertex.x * sinRotation + aVertex.y * cosRotation;

    vec2 v = vec2(x, y);
    v = v + aPosition;

    gl_Position = vec4((uTranslationMatrix * vec3(v, 1.0)).xy, 0.0, 1.0);

    if(uRound == 1.0)
    {
        gl_Position.xy = roundPixels(gl_Position.xy, uResolution);
    }

    vUV = aUV;
    vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor;
}
`;

// Fragment: Pixi's particles.frag with the single line
//   `vec4 color = texture2D(uTexture, vUV) * vColor; gl_FragColor = color;`
// replaced by the dissolve erosion (0.3c). Premultiplication is derived to match
// stock EXACTLY: stock outputs `texel(premult) * vColor(premult)` = straight
// (texRGB·tintRGB) premultiplied by (texA·a). Dissolve replaces the alpha `a`
// with the progress `d`, so we un-premultiply both inputs, compute the straight
// result, then re-premultiply by the new straight alpha (texA·d). A fully-visible
// particle (d=1) is therefore byte-identical to the stock shader.
export const dissolveFragmentGl = `varying vec2 vUV;
varying vec4 vColor;

uniform sampler2D uTexture;
uniform sampler2D uDissolveNoise;
uniform float uTime;
uniform float uFrequency;
uniform vec2 uScroll;
uniform float uEdgeWidth;
uniform vec4 uEdgeColor;

void main(void){
    // Un-premultiply the stock inputs to straight alpha (0.3c operates on
    // straight alpha conceptually). texel is premultiply-alpha-on-upload; vColor
    // is premultiplied in the vertex shader (vColor.rgb = tintRGB * a).
    vec4 texel = texture2D(uTexture, vUV);
    float texA = texel.a;
    vec3 texRGB = texA > 0.0 ? texel.rgb / texA : vec3(0.0);
    float a = vColor.a;
    vec3 tintRGB = a > 0.0 ? vColor.rgb / a : vec3(0.0);

    // n: dissolve noise, repeat-addressed, scrolled over the effect clock.
    float n = texture2D(uDissolveNoise, vUV * uFrequency + uTime * uScroll).r;

    // Endpoint-exact threshold: a=1 -> t=-uEdgeWidth -> d=1 for all n>=0;
    // a=0 -> t=1 -> d=0 for all n<=1. The smoothstep width is clamped to a tiny
    // epsilon so uEdgeWidth==0 is a near-hard step (smoothstep(t,t,.) is
    // undefined in GLSL); for uEdgeWidth>0 the upper edge is exactly t+uEdgeWidth.
    float ew = max(uEdgeWidth, 1e-4);
    float t = (1.0 - a) * (1.0 + uEdgeWidth) - uEdgeWidth;
    float d = smoothstep(t, t + ew, n);

    // Straight-alpha result: base color unchanged from stock; a parabolic hot
    // edge band peaks at d=0.5 (edgeColor null -> vec4(0) -> branchless no-op).
    vec3 rgb = texRGB * tintRGB + uEdgeColor.rgb * uEdgeColor.a * (d * (1.0 - d) * 4.0);
    float alpha = texA * d;

    // Re-premultiply to the stock output convention (blend state is premultiplied).
    gl_FragColor = vec4(rgb * alpha, alpha);
}
`;

// WGSL: Pixi's particles.wgsl verbatim EXCEPT (a) the added @group(2) dissolve
// bindings and (b) the mainFragment body (same erosion as the GLSL frag).
// @group(0) uniforms and @group(1) uTexture/uSampler are re-bound per-frame by
// the GPU adaptor; @group(2) is ours and untouched.
export const dissolveWgsl = `
struct ParticleUniforms {
  uTranslationMatrix:mat3x3<f32>,
  uColor:vec4<f32>,
  uRound:f32,
  uResolution:vec2<f32>,
};

struct DissolveUniforms {
  uTime: f32,
  uFrequency: f32,
  uScroll: vec2<f32>,
  uEdgeWidth: f32,
  uEdgeColor: vec4<f32>,
};

fn roundPixels(position: vec2<f32>, targetSize: vec2<f32>) -> vec2<f32>
{
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

@group(0) @binding(0) var<uniform> uniforms: ParticleUniforms;

@group(1) @binding(0) var uTexture: texture_2d<f32>;
@group(1) @binding(1) var uSampler : sampler;

@group(2) @binding(0) var<uniform> dissolveUniforms: DissolveUniforms;
@group(2) @binding(1) var uDissolveNoise: texture_2d<f32>;
@group(2) @binding(2) var uDissolveSampler : sampler;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv : vec2<f32>,
    @location(1) color : vec4<f32>,
  };
@vertex
fn mainVertex(
  @location(0) aVertex: vec2<f32>,
  @location(1) aPosition: vec2<f32>,
  @location(2) aUV: vec2<f32>,
  @location(3) aColor: vec4<f32>,
  @location(4) aRotation: f32,
) -> VSOutput {

   let v = vec2(
       aVertex.x * cos(aRotation) - aVertex.y * sin(aRotation),
       aVertex.x * sin(aRotation) + aVertex.y * cos(aRotation)
   ) + aPosition;

   var position = vec4((uniforms.uTranslationMatrix * vec3(v, 1.0)).xy, 0.0, 1.0);

   if(uniforms.uRound == 1.0) {
       position = vec4(roundPixels(position.xy, uniforms.uResolution), position.zw);
   }

    let vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uniforms.uColor;

  return VSOutput(
   position,
   aUV,
   vColor,
  );
}

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @builtin(position) position: vec4<f32>,
) -> @location(0) vec4<f32> {

    // Un-premultiply, run the erosion, re-premultiply (see the GLSL frag).
    let texel = textureSample(uTexture, uSampler, uv);
    let texA = texel.a;
    let texRGB = select(vec3<f32>(0.0), texel.rgb / texA, texA > 0.0);
    let a = color.a;
    let tintRGB = select(vec3<f32>(0.0), color.rgb / a, a > 0.0);

    let n = textureSample(uDissolveNoise, uDissolveSampler, uv * dissolveUniforms.uFrequency + dissolveUniforms.uTime * dissolveUniforms.uScroll).r;

    let ew = max(dissolveUniforms.uEdgeWidth, 1e-4);
    let t = (1.0 - a) * (1.0 + dissolveUniforms.uEdgeWidth) - dissolveUniforms.uEdgeWidth;
    let d = smoothstep(t, t + ew, n);

    let rgb = texRGB * tintRGB + dissolveUniforms.uEdgeColor.rgb * dissolveUniforms.uEdgeColor.a * (d * (1.0 - d) * 4.0);
    let alpha = texA * d;
    return vec4<f32>(rgb * alpha, alpha);
}`;

// --- Cached noise texture (never-destroy + destroyed-guard self-heal) ------
// Same policy as renderer.ts builtinTexture: the dissolve noise tile is pure
// procedural and shared across every renderer instance, so it is cached at
// module scope and NEVER destroyed by any adapter (a custom particle shader
// holds it as a bound resource; destroying its source would null the bind
// group). The `destroyed` guard self-heals if a host teardown destroys it —
// regenerating from pure pixel math is cheap.
let noiseTexture: Texture | null = null;

function dissolveNoiseTexture(): Texture {
  if (!noiseTexture || noiseTexture.destroyed) {
    const d = generateDissolveNoise();
    const source = new BufferImageSource({
      resource: d.pixels,
      width: d.width,
      height: d.height,
      // alpha is 255 everywhere, so premultiply-on-upload is the identity and RGB
      // (the sampled channel) is preserved exactly, matching the built-ins' upload.
      alphaMode: "premultiply-alpha-on-upload",
      scaleMode: "linear",
      // REPEAT addressing (0.3c) so uFrequency tiles the seamless noise.
      addressMode: "repeat",
    });
    noiseTexture = new Texture({ source });
  }
  return noiseTexture;
}

/**
 * Build the dissolve shader bound to `texture` (the layer texture) configured by
 * `cfg`. Returns null in a headless (no-DOM) unit-test environment where Pixi
 * eagerly probes a GL context — the caller falls back to the default particle
 * shader (trailMesh.ts precedent). The fallback is SILENT: the dissolve golden
 * preset on SwiftShader is the live-GL proof, and warning here would spam every
 * unit test. A dissolve layer OWNS its shader (per-layer, not shared), which
 * also sidesteps the shared-default-shader texture-lifetime footgun.
 */
export function makeDissolveShader(texture: Texture, cfg: DissolveConfig): Shader | null {
  try {
    const glProgram = new GlProgram({
      vertex: dissolveVertexGl,
      fragment: dissolveFragmentGl,
      name: "particlr-dissolve",
    });
    const gpuProgram = new GpuProgram({
      vertex: { source: dissolveWgsl, entryPoint: "mainVertex" },
      fragment: { source: dissolveWgsl, entryPoint: "mainFragment" },
      name: "particlr-dissolve",
    });
    const noise = dissolveNoiseTexture();
    const edge = cfg.edgeColor;
    return new Shader({
      glProgram,
      gpuProgram,
      resources: {
        // Layer texture + sampler: the particle pipe overwrites uTexture (GL) /
        // group 1 (GPU) from container.texture every frame, so these are just the
        // construction-time seed — applyTexture keeps them current for free.
        uTexture: texture.source,
        uSampler: texture.source.style,
        // Projection/tint group (group 0): also overwritten per-frame by the pipe
        // (localUniforms). Mirrors the stock ParticleShader default so the shader
        // is self-consistent if ever bound outside the pipe.
        uniforms: {
          uTranslationMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
          uColor: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
          uRound: { value: 1, type: "f32" },
          uResolution: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
        },
        // Dissolve group (group 2): OURS, never touched by the pipe.
        dissolveUniforms: {
          uTime: { value: 0, type: "f32" },
          uFrequency: { value: cfg.frequency, type: "f32" },
          uScroll: { value: new Float32Array([cfg.scroll.x, cfg.scroll.y]), type: "vec2<f32>" },
          uEdgeWidth: { value: cfg.edgeWidth, type: "f32" },
          uEdgeColor: {
            value: new Float32Array(edge ? [edge.r, edge.g, edge.b, edge.a] : [0, 0, 0, 0]),
            type: "vec4<f32>",
          },
        },
        uDissolveNoise: noise.source,
        uDissolveSampler: noise.source.style,
      },
    });
  } catch {
    return null;
  }
}
