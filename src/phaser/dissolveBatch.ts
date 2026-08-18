// Dissolve / alpha-erosion for the Phaser 4 adapter (schemaVersion 4, 0.3c).
// This is the ONE file in the adapter that reaches into Phaser's WebGL
// internals (D5): a `BatchHandlerQuad` subclass that appends a shader addition
// carrying the erosion fragment math, samples the shared texgen noise from a
// second sampler, and refreshes the erosion clock once per flush.
//
// ===========================================================================
// STEP-1 FINDINGS — Phaser 4.2.1 internals this file depends on
// ===========================================================================
//
// A. `renderNodes/BatchHandler.js` — construction and config merge
//    - ctor is `(manager, defaultConfig, config)`. `_copyAndCompleteConfig`
//      merges field by field: `config.X || defaultConfig.X`. So a subclass can
//      pass a PARTIAL config as `BatchHandlerQuad`'s second argument and
//      inherit vertexSource/fragmentSource/vertexBufferLayout/verticesPer-
//      Instance/indicesPerInstance from the quad defaults. That is what we do
//      — no `defaultConfig` override, no prototype-getter dance (a class FIELD
//      would be too late: `BatchHandlerQuad.initialize` reads
//      `this.defaultConfig` DURING super(), before subclass fields exist).
//    - `shaderAdditions` is shallow-copied per node (`additions.map(a =>
//      Object.assign({}, a))`), so the `additions` GLSL object is SHARED
//      between handler instances. We never mutate it.
//    - `config.maxTexturesPerBatch` is copied into the merged config and then
//      IGNORED — `this.maxTexturesPerBatch = 1` followed by
//      `this.updateTextureCount(manager.maxParallelTextureUnits)` is the only
//      thing that sets it. Reserving a texture unit therefore requires
//      overriding `updateTextureCount`, not passing config (see D).
//    - `instancesPerBatch = min(config.instancesPerBatch || renderer.config
//      .batchSize || 65536/verticesPerInstance, 65536/verticesPerInstance)`.
//      Each handler owns a vertex buffer of that size — see "Concerns".
//
// B. `renderNodes/BatchHandlerQuad.js` — shape of the quad batcher
//    - `defaultConfig.shaderAdditions` (in order):
//        GetTexCoordOut, GetTexRes(off), SmoothPixelArt(off), DefineTexCount(1),
//        GetTexture, ApplyTint, DefineLights(off), RotationDatum(off),
//        OutInverseRotation(off), GetNormalFromMap(off), ApplyLighting(off),
//        ApplyAlphaDiscard(off).
//      We splice OUR addition in immediately BEFORE the `ALPHA_DISCARD`-tagged
//      entry: after the tint (we need the tinted colour) and after lighting
//      (dissolve erodes the lit result), but before a discard strategy that
//      would otherwise test the PRE-erosion alpha.
//    - `setupUniforms(drawingContext)` is called once per sub-batch inside
//      `run()`, immediately before `programManager.applyUniforms(program)` and
//      `renderer.drawElements(...)`. That is the per-flush hook for `uTime`.
//    - `run()` -> `renderer.drawElements(dc, entry.texture, program, vao, ...)`;
//      `drawElements` does `glTextureUnits.bindUnits(entry.texture)` where the
//      ARRAY INDEX IS THE TEXTURE UNIT, and `bindUnits` only walks
//      `0 .. min(textures.length, maxTextures)-1`, skipping `undefined` holes.
//    - `finalizeTextureCount(entry.unit)` rewrites the TEXTURE/TexCount
//      additions per sub-batch, so the shader recompiles around the actual
//      texture count. Our addition is untouched by that (different tag).
//
// C. Addition shape — `shaders/additionMakers/MakeApplyTint.js` (the model)
//        { name, additions: { fragmentHeader, fragmentProcess }, tags, disable }
//      `additions` is an OBJECT keyed by template point (the Shader Guide's
//      `{key, value}[]` prose is out of date; the code and the d.ts both say
//      object). Template points are `#pragma phaserTemplate(key)` in the
//      shader source; several additions may target the same key and are
//      emitted in array order. `name` is part of the shader-program cache key
//      (`programManager.getCurrentProgramSuite` -> `factory.getKey(base,
//      additions, features)`), so the name must be STABLE — a changing name
//      forces a recompile, an unchanged name is assumed to be unchanged code.
//
// D. Second sampler — the strategy actually shipped
//      `shaders/src/Multi.frag`'s main() is just
//        `#pragma phaserTemplate(fragmentProcess)` then `gl_FragColor = fragColor;`
//      with `MakeGetTexture` contributing `vec4 fragColor = getTexture(texCoord);`
//      and `MakeApplyTint` contributing `fragColor = applyTint(fragColor);`.
//      There is no per-instance sampler slot to hijack, and the batch's own
//      texture array is rewritten every sub-batch, so the noise cannot ride
//      `entry.texture` (a hole in that array would also crash
//      `pushCurrentBatchEntry`, which walks it unguarded).
//      SHIPPED: brief option (1) — bind the noise on a RESERVED texture unit
//      from `setupUniforms`, using `renderer.glTextureUnits.bind(tex, unit,
//      false, false)` (the sanctioned wrapper; never a raw gl call). The unit
//      is reserved with brief option (2): `updateTextureCount` is overridden to
//      clamp `maxTexturesPerBatch` to `renderer.maxTextures - 1`, so
//      `entry.texture.length` can never reach the reserved index and
//      `bindUnits` never overwrites it. `uParticlrNoise` is set ONCE in the
//      constructor (uniforms live in `programManager.uniforms` and are
//      re-applied to every program variant each flush — the same trick
//      `BatchHandlerQuad` uses for `uMainSampler[0]`).
//      Procedural noise was never on the table: it would diverge visually from
//      the pixi/three adapters.
//
// E. Registration — `renderNodes/RenderNodeManager.js`
//      `addNode` THROWS on a duplicate name; `addNodeConstructor` throws too,
//      and `getNode` lazily constructs from the registered constructor and
//      calls `addNode` itself. `hasNode(name)` is true for either. We register
//      a CONSTRUCTOR (a closure over the layer ref + noise texture), because
//      `new ctor(manager)` returning an object is legal JS and it keeps
//      construction — which needs live GL — out of the registration call.
//      `GameObjects.Components.RenderNodes.setRenderNodeRole(role, name)`
//      resolves the name through `manager.getNode(name)` and stores the node
//      in `customRenderNodes[role]`, which is exactly what
//      `ParticlrLayer.renderWebGL` reads first.
//
// F. GLSL port — from `src/three/dissolveMaterial.ts` (same visual algorithm
//    per V2_DESIGN's dissolve ruling), GLSL ES 1.00. The one adaptation:
//    Phaser textures are PREMULTIPLIED on upload and `ApplyTint` returns
//    `vec4(straightColour * alpha, alpha)` with `alpha = texel.a * outTint.a`.
//    Three's fragment works on straight alpha, so we un-premultiply
//    `fragColor`, run the identical erosion, and re-premultiply — the same
//    derivation the pixi fork documents (`src/pixi/dissolveShader.ts:86-90`),
//    and `d == 1` is byte-identical to the un-eroded quad path.
//    The erosion is driven by `outTint.a`, the per-particle render alpha the
//    submit loop packs with `getTintAppendFloatAlpha` (0.3c: "the render alpha
//    chain drives the erosion"). Noise is sampled at `outTexCoord`, the
//    flipbook-WINDOWED uv — i.e. this adapter matches THREE's known divergence
//    from pixi (which samples at raw sheet uv) on flipbook+dissolve layers.
import Phaser from "phaser";
import type { DissolveConfig } from "../format/types.js";
import { ensureDissolveNoiseTexture, type PhaserTextureManagerLike } from "./textures.js";

/** What the handler reads at flush time. `owner` is the `Effect` — the erosion
 * clock is `effect.time`, read live, so `sync()` writes nothing. */
export interface DissolveLayerRef {
  dissolve: DissolveConfig;
  owner: { time: number };
}

/** Part of the shader-program cache key — must stay stable across frames. */
export const DISSOLVE_ADDITION_NAME = "ParticlrDissolve";

const FRAGMENT_HEADER = `uniform sampler2D uParticlrNoise;
uniform float uParticlrTime;
uniform float uParticlrFrequency;
uniform vec2 uParticlrScroll;
uniform float uParticlrEdgeWidth;
uniform vec4 uParticlrEdgeColor;
`;

// Runs inside main(), after MakeApplyTint. Locals are `prt`-prefixed: this
// scope is shared with every other addition's fragmentProcess.
const FRAGMENT_PROCESS = `
// particlr dissolve (0.3c). fragColor is PREMULTIPLIED here (ApplyTint returns
// vec4(colour * alpha, alpha), alpha = texel.a * outTint.a). Un-premultiply,
// erode on straight alpha exactly as src/three/dissolveMaterial.ts does, then
// re-premultiply: at prtD == 1 the output is the un-eroded quad path verbatim.
float prtA = outTint.a;
float prtTexA = prtA > 0.0 ? fragColor.a / prtA : 0.0;
vec3 prtStraight = fragColor.a > 0.0 ? fragColor.rgb / fragColor.a : vec3(0.0);
float prtN = texture2D(uParticlrNoise, outTexCoord * uParticlrFrequency + uParticlrTime * uParticlrScroll).r;
float prtEw = max(uParticlrEdgeWidth, 1e-4);
float prtT = (1.0 - prtA) * (1.0 + uParticlrEdgeWidth) - uParticlrEdgeWidth;
float prtD = smoothstep(prtT, prtT + prtEw, prtN);
vec3 prtRgb = prtStraight + uParticlrEdgeColor.rgb * uParticlrEdgeColor.a * (prtD * (1.0 - prtD) * 4.0);
float prtAlpha = prtTexA * prtD;
fragColor = vec4(prtRgb * prtAlpha, prtAlpha);
`;

/**
 * The dissolve shader addition, in Phaser's `{ name, additions, tags }` shape
 * (modelled on `MakeApplyTint`). A fresh object each call, like Phaser's own
 * addition makers — `BatchHandler` shallow-copies configs per node, so sharing
 * one object would share every field it does not copy.
 */
export function makeDissolveAddition(): Phaser.Types.Renderer.WebGL.ShaderAdditionConfig {
  return {
    name: DISSOLVE_ADDITION_NAME,
    additions: {
      fragmentHeader: FRAGMENT_HEADER,
      fragmentProcess: FRAGMENT_PROCESS,
    },
    tags: ["PARTICLR_DISSOLVE"],
  };
}

/**
 * The uniforms that never change for a layer: set once in the constructor and
 * re-applied to every shader variant by `programManager.applyUniforms`. Only
 * `uParticlrTime` is refreshed per flush. Exported so the mapping (notably the
 * `edgeColor: null` -> branchless `vec4(0)` no-op that pixi and three both use)
 * is unit-testable without a GL context.
 */
export function dissolveUniformValues(
  cfg: DissolveConfig,
  noiseUnit: number,
): Record<string, number | number[]> {
  const e = cfg.edgeColor;
  return {
    uParticlrNoise: noiseUnit,
    uParticlrFrequency: cfg.frequency,
    uParticlrScroll: [cfg.scroll.x, cfg.scroll.y],
    uParticlrEdgeWidth: cfg.edgeWidth,
    uParticlrEdgeColor: e ? [e.r, e.g, e.b, e.a] : [0, 0, 0, 0],
  };
}

const QuadBatch = Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad;

/** Quad additions + ours, spliced in ahead of the alpha-discard step. */
function dissolveShaderAdditions(): Phaser.Types.Renderer.WebGL.ShaderAdditionConfig[] {
  const additions = (QuadBatch.prototype.defaultConfig.shaderAdditions ?? []).slice();
  const discard = additions.findIndex((a) => a.tags !== undefined && a.tags.indexOf("ALPHA_DISCARD") !== -1);
  additions.splice(discard < 0 ? additions.length : discard, 0, makeDissolveAddition());
  return additions;
}

/**
 * Phaser's quad batcher with the dissolve addition compiled in. One instance
 * per dissolve layer: the erosion uniforms are per-layer and are applied at
 * flush time, so two layers cannot share a handler.
 */
export class ParticlrDissolveBatch extends QuadBatch {
  private readonly layerRef: DissolveLayerRef;
  private readonly noiseGlTexture: unknown;
  /** The texture unit reserved for `uParticlrNoise` (see finding D). */
  private readonly noiseUnit: number;

  constructor(
    manager: Phaser.Renderer.WebGL.RenderNodes.RenderNodeManager,
    layerRef: DissolveLayerRef,
    noiseGlTexture: unknown,
  ) {
    super(manager, {
      name: DISSOLVE_ADDITION_NAME,
      shaderAdditions: dissolveShaderAdditions(),
    });
    this.layerRef = layerRef;
    this.noiseGlTexture = noiseGlTexture;
    this.noiseUnit = ParticlrDissolveBatch.reservedUnit(manager);

    // One-time uniforms. `programManager.uniforms` is a persistent record
    // re-applied to whichever program variant is current, so the sampler unit
    // and the layer's dissolve parameters survive every shader rebuild.
    const values = dissolveUniformValues(layerRef.dissolve, this.noiseUnit);
    for (const name of Object.keys(values)) this.programManager.setUniform(name, values[name]!);
  }

  /** The top texture unit — never handed out to the batch (see below). */
  private static reservedUnit(manager: Phaser.Renderer.WebGL.RenderNodes.RenderNodeManager): number {
    return Math.max(1, manager.renderer.maxTextures - 1);
  }

  /**
   * Reserve the top texture unit for the noise sampler by clamping the batch's
   * own texture count. WebGL guarantees at least 8 fragment texture units, so
   * losing one costs nothing in practice — and a dissolve layer submits a
   * single texture anyway.
   *
   * Called from `BatchHandler`'s constructor (before this subclass's fields
   * exist) and again on every `SET_PARALLEL_TEXTURE_UNITS`, so it must read
   * only what the base class has already set up.
   */
  override updateTextureCount(count?: number): void {
    const max = this.manager.renderer.maxTextures;
    super.updateTextureCount(Math.min(count === undefined ? max : count, Math.max(1, max - 1)));
  }

  /**
   * Per-flush hook (`run()` calls this once per sub-batch, immediately before
   * the uniforms are applied and the draw is issued). Two jobs: advance the
   * erosion clock from the live effect, and make sure the noise is bound to
   * the reserved unit — `bindUnits` only walks the batch's own units, so
   * nothing downstream clobbers it, but another render node may have used the
   * unit since our last flush.
   */
  override setupUniforms(drawingContext: Phaser.Renderer.WebGL.DrawingContext): void {
    super.setupUniforms(drawingContext);
    this.programManager.setUniform("uParticlrTime", this.layerRef.owner.time);
    this.manager.renderer.glTextureUnits.bind(
      this.noiseGlTexture as Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper,
      this.noiseUnit,
      false,
      false,
    );
  }
}

/** Minimal shape of the render-node manager this module registers against. */
interface RenderNodeManagerLike {
  hasNode(name: string, constructed?: boolean): boolean;
  addNodeConstructor(name: string, ctor: unknown): void;
}

/** The dissolve noise texture as this module consumes it. `setFilter` is
 * absent on the test double, hence optional. */
interface NoiseTextureLike {
  get(name?: string | number): { source: { glTexture: unknown } };
  setFilter?(filterMode: number): void;
}

/** `Phaser.Textures.FilterMode.LINEAR`. `addUint8Array` uploads at NEAREST;
 * pixi and three both sample the noise LINEAR, so match them. */
const FILTER_LINEAR = 0;
/** Set-filter re-uploads the texture, so do it once per noise texture. */
const LINEARISED = new WeakSet<object>();

/**
 * Register a dissolve batch handler for one layer and return its node name, or
 * `null` if the scene has no render-node manager (Canvas renderer / headless).
 *
 * The name is `particlr-dissolve-<n>`, starting at the layer index and walking
 * forward past anything already registered — two renderers over the same scene
 * must not collide, and `addNodeConstructor` throws on a duplicate.
 */
export function registerDissolveHandler(
  scene: Phaser.Scene,
  layerIndex: number,
  layerRef: DissolveLayerRef,
): string | null {
  const renderer = scene.sys.renderer as unknown as { renderNodes?: RenderNodeManagerLike } | undefined;
  const manager = renderer?.renderNodes;
  if (!manager || typeof manager.addNodeConstructor !== "function") return null;

  const tm = scene.sys.textures as unknown as PhaserTextureManagerLike;
  const noise = ensureDissolveNoiseTexture(tm) as unknown as NoiseTextureLike;
  if (typeof noise.setFilter === "function" && !LINEARISED.has(noise)) {
    noise.setFilter(FILTER_LINEAR);
    LINEARISED.add(noise);
  }
  const noiseGlTexture = noise.get().source.glTexture;

  let n = layerIndex;
  let name = `particlr-dissolve-${n}`;
  while (manager.hasNode(name)) name = `particlr-dissolve-${++n}`;

  // A constructor, not an instance: `getNode` instantiates it on first use, so
  // registration itself never touches GL (and the test double can substitute a
  // stand-in without constructing a real BatchHandlerQuad).
  manager.addNodeConstructor(name, function (
    m: Phaser.Renderer.WebGL.RenderNodes.RenderNodeManager,
  ): ParticlrDissolveBatch {
    return new ParticlrDissolveBatch(m, layerRef, noiseGlTexture);
  });

  return name;
}
