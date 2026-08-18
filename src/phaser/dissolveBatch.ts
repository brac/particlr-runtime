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
//      a CONSTRUCTOR, because `new ctor(manager)` returning an object is legal
//      JS and it keeps construction — which needs live GL — out of the
//      registration call.
//      **There is no `removeNode`, and `_nodeConstructors[name]` is never
//      deleted** (nor is there a manager teardown), so BOTH the node and the
//      closure that built it are retained for the Game's whole life. Hence the
//      two mechanisms in this file that keep that from being a leak: released
//      node names are recycled (`RegistryState`), and the closure captures a
//      one-shot BOX rather than the layer ref itself (`RegistryState.pending`).
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
// re-premultiply. At prtD == 1 this reproduces the un-eroded quad path: exactly
// when outTint.a == 1, and to within the un-premultiply round trip's float error
// otherwise (prtStraight * prtTexA vs the tint's colour * texel.a * outTint.a).
// That is the same tolerance three and pixi ship — intended parity, not a claim
// of bit-identity at every alpha.
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

/**
 * Phaser's stock quad additions with ours spliced in immediately before the
 * `ALPHA_DISCARD`-tagged entry (appended if that entry ever disappears).
 * Exported so the splice position is unit-testable against the REAL
 * `BatchHandlerQuad.prototype.defaultConfig` without a GL context.
 */
export function dissolveShaderAdditions(): Phaser.Types.Renderer.WebGL.ShaderAdditionConfig[] {
  const additions = (QuadBatch.prototype.defaultConfig.shaderAdditions ?? []).slice();
  const discard = additions.findIndex((a) => a.tags !== undefined && a.tags.indexOf("ALPHA_DISCARD") !== -1);
  additions.splice(discard < 0 ? additions.length : discard, 0, makeDissolveAddition());
  return additions;
}

/**
 * The texture unit reserved for `uParticlrNoise`: the top one the renderer
 * reports. Exported for unit testing — the arithmetic is one line but it is
 * the hinge the whole second-sampler strategy turns on.
 *
 * The `max(1, …)` floor only bites at `maxTextures === 1`, where unit 0 is both
 * the reserved unit and the batch's only unit, so the noise and the layer sheet
 * would fight. WebGL1 guarantees `MAX_TEXTURE_IMAGE_UNITS >= 8` and Phaser
 * reads that hardware limit (not the tunable `maxParallelTextureUnits`, which
 * `autoMobileTextures` may drop to 1), so the degenerate case is unreachable on
 * conforming hardware; the floor exists so the arithmetic can never produce a
 * negative unit index.
 */
export function reservedNoiseUnit(maxTextures: number): number {
  return Math.max(1, maxTextures - 1);
}

/**
 * Phaser's quad batcher with the dissolve addition compiled in. One instance
 * per LIVE dissolve layer: the erosion uniforms are per-layer and are applied
 * at flush time, so two concurrent layers cannot share a handler.
 *
 * `RenderNodeManager` has no `removeNode`, so a node registered with it lives
 * as long as the renderer does. `setLayerRef` is what makes that survivable:
 * when a `PhaserParticleRenderer` is destroyed its handler is re-pointed at an
 * inert ref (dropping the strong reference to the Effect and its sim pools) and
 * its name is returned to a free list, so the next dissolve layer on the same
 * scene re-points this same handler instead of leaking a new one.
 */
export class ParticlrDissolveBatch extends QuadBatch {
  private layerRef: DissolveLayerRef;
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
    this.noiseUnit = reservedNoiseUnit(manager.renderer.maxTextures);
    this.applyStaticUniforms();
  }

  /**
   * Re-point this handler at a different layer (free-list reuse) or at the
   * inert ref (release). The static uniforms are re-applied because they are
   * derived from `ref.dissolve`, which differs per layer.
   */
  setLayerRef(ref: DissolveLayerRef): void {
    this.layerRef = ref;
    this.applyStaticUniforms();
  }

  /**
   * The uniforms that do not change while a layer owns this handler.
   * `programManager.uniforms` is a persistent record re-applied to whichever
   * program variant is current, so the sampler unit and the layer's dissolve
   * parameters survive every shader rebuild — the same mechanism
   * `BatchHandlerQuad` uses for `uMainSampler[0]`.
   */
  private applyStaticUniforms(): void {
    const values = dissolveUniformValues(this.layerRef.dissolve, this.noiseUnit);
    for (const name of Object.keys(values)) this.programManager.setUniform(name, values[name]!);
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
    super.updateTextureCount(Math.min(count === undefined ? max : count, reservedNoiseUnit(max)));
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
  getNode(name: string): unknown;
}

/** The node instance, as the register/release path pokes at it. The test
 * double stands in for a real handler, so `setLayerRef` is optional. */
interface DissolveNodeLike {
  setLayerRef?(ref: DissolveLayerRef): void;
}

/**
 * Per-manager registration bookkeeping.
 *
 * `RenderNodeManager` exposes `addNode`/`addNodeConstructor`/`getNode` and
 * NOTHING that removes a node — a registered node is permanent for the
 * renderer's life, holding its vertex buffer (~1.8 MB at Phaser's default
 * `batchSize`), its index buffer, its ProgramManager and a
 * `SET_PARALLEL_TEXTURE_UNITS` listener. Without reuse, a host that builds and
 * destroys effects in a loop (VFX pooling, an editor rebuilding a preview on
 * every keystroke) would accumulate one such node per dissolve layer forever.
 *
 * So: names released by `destroy()` go on a free list and are handed back out
 * on the next registration, re-pointing the existing handler at the new layer.
 * `next` makes minting a fresh name O(1) rather than rescanning the manager.
 * Keyed weakly by the manager so a discarded Phaser Game takes its bookkeeping
 * with it.
 */
interface RegistryState {
  free: string[];
  next: number;
  /**
   * The one-shot boxes handed to `addNodeConstructor`, by node name.
   *
   * `RenderNodeManager.getNode` constructs from `_nodeConstructors[name]`,
   * stores the instance in `_nodes`, and **never deletes the constructor
   * entry** — there is no manager teardown either, so the closure passed to
   * `addNodeConstructor` is retained for the Game's whole life. A closure that
   * captured the layer ref by value would therefore pin the Effect and its sim
   * pools forever, one per high-water-mark slot, and `setLayerRef` could not
   * undo it (it only reassigns the instance field; the capture is untouched).
   *
   * So the closure captures a BOX, and empties it as its first act. After the
   * one construction — or after `releaseDissolveHandler`, whichever comes
   * first — the retained closure holds nothing but a null box. The map keeps
   * at most one emptied box per slot, which is what makes the invariant
   * probe-able (`pendingDissolveLayerRef`).
   */
  pending: Map<string, LayerRefBox>;
}

/** Mutable carrier: see `RegistryState.pending`. */
interface LayerRefBox {
  current: DissolveLayerRef | null;
}

const REGISTRIES = new WeakMap<object, RegistryState>();

function registryFor(manager: RenderNodeManagerLike): RegistryState {
  let state = REGISTRIES.get(manager as object);
  if (state === undefined) {
    state = { free: [], next: 0, pending: new Map() };
    REGISTRIES.set(manager as object, state);
  }
  return state;
}

function managerOf(scene: Phaser.Scene): RenderNodeManagerLike | null {
  const renderer = scene.sys.renderer as unknown as { renderNodes?: RenderNodeManagerLike } | undefined;
  const manager = renderer?.renderNodes;
  return manager && typeof manager.addNodeConstructor === "function" ? manager : null;
}

/**
 * The ref a released handler is re-pointed at. Its only job is to be inert and
 * to hold no reference to a destroyed Effect or its particle pools — a
 * released node stays registered with Phaser forever, so anything it still
 * points at is retained forever too.
 */
const IDLE_LAYER_REF: DissolveLayerRef = {
  dissolve: { frequency: 1, scroll: { x: 0, y: 0 }, edgeWidth: 0, edgeColor: null },
  owner: { time: 0 },
};

/** The dissolve noise texture as this module consumes it. `setFilter` is
 * absent on the test double, hence optional. */
interface NoiseTextureLike {
  get(name?: string | number): { source: { glTexture: unknown } };
  setFilter?(filterMode: number): void;
}

/** `Phaser.Textures.FilterMode.LINEAR`. `addUint8Array` uploads at NEAREST;
 * pixi and three both sample the noise LINEAR, so match them. */
const FILTER_LINEAR = 0;
/**
 * `TextureSource.setFilter` routes to `renderer.setTextureFilter`, which binds
 * the texture to unit 0, calls `WebGLTextureWrapper.update(...)` to re-apply
 * every `texParameteri` (wrap, filter) and restores the previous unit-0
 * binding. No pixel re-upload — `update` reuses the wrapper's own `pixels` —
 * but it does churn GL state and stomp unit 0, so do it once per texture.
 */
const LINEARISED = new WeakSet<object>();

/**
 * Register a dissolve batch handler for one layer and return its node name, or
 * `null` if the scene has no render-node manager (Canvas renderer / headless).
 *
 * A name released by a destroyed renderer is reused first (see `RegistryState`
 * — the manager cannot remove nodes, so reuse is the only bound on growth);
 * otherwise a fresh `particlr-dissolve-<n>` is minted. The `hasNode` loop is a
 * guard against a name registered by someone else, not the primary mechanism.
 */
export function registerDissolveHandler(
  scene: Phaser.Scene,
  layerIndex: number,
  layerRef: DissolveLayerRef,
): string | null {
  const manager = managerOf(scene);
  if (manager === null) return null;
  const state = registryFor(manager);

  // Reuse before minting: re-point a released handler at this layer.
  const recycled = state.free.pop();
  if (recycled !== undefined) {
    const node = manager.getNode(recycled) as DissolveNodeLike | null;
    if (node !== null && typeof node.setLayerRef === "function") node.setLayerRef(layerRef);
    return recycled;
  }

  const tm = scene.sys.textures as unknown as PhaserTextureManagerLike;
  const noise = ensureDissolveNoiseTexture(tm) as unknown as NoiseTextureLike;
  if (typeof noise.setFilter === "function" && !LINEARISED.has(noise)) {
    noise.setFilter(FILTER_LINEAR);
    LINEARISED.add(noise);
  }
  const noiseGlTexture = noise.get().source.glTexture;

  // Start at the layer index so the first dissolve layer of the first renderer
  // reads `particlr-dissolve-0`, but never go backwards — `next` keeps minting
  // O(1) instead of rescanning the manager on every registration.
  let n = Math.max(layerIndex, state.next);
  while (manager.hasNode(`particlr-dissolve-${n}`)) n++;
  const name = `particlr-dissolve-${n}`;
  state.next = n + 1;

  // A constructor, not an instance: `getNode` instantiates it on first use, so
  // registration itself never touches GL (and the test double can substitute a
  // stand-in without constructing a real BatchHandlerQuad).
  //
  // The closure captures a one-shot BOX, never the layer ref itself: Phaser
  // keeps `_nodeConstructors[name]` forever (see `RegistryState.pending`), so a
  // by-value capture would pin this Effect and its sim pools for the Game's
  // life no matter what `destroy()` did. Emptying the box is the FIRST thing
  // the constructor does, so the severance holds even if construction throws.
  // (`noiseGlTexture` stays captured by value — it is the shared, procedurally
  // generated, never-destroyed noise tile, page-lifetime by design.)
  const box: LayerRefBox = { current: layerRef };
  state.pending.set(name, box);
  manager.addNodeConstructor(name, function (
    m: Phaser.Renderer.WebGL.RenderNodes.RenderNodeManager,
  ): ParticlrDissolveBatch {
    const ref = box.current;
    box.current = null;
    // `ref` is null only if the renderer was destroyed before Phaser ever
    // constructed the node; the inert ref keeps that path from resurrecting it.
    return new ParticlrDissolveBatch(m, ref ?? IDLE_LAYER_REF, noiseGlTexture);
  });

  return name;
}

/**
 * The layer ref a registered-but-not-yet-constructed node constructor is still
 * holding, or `null` once it has been consumed (or released, or never
 * registered).
 *
 * Exported as an invariant probe rather than as API: Phaser never deletes a
 * node constructor, so this returning non-null for a destroyed renderer's node
 * would mean a permanently retained Effect — exactly the leak the box exists
 * to prevent.
 */
export function pendingDissolveLayerRef(scene: Phaser.Scene, name: string): DissolveLayerRef | null {
  const manager = managerOf(scene);
  if (manager === null) return null;
  return REGISTRIES.get(manager as object)?.pending.get(name)?.current ?? null;
}

/**
 * Hand a dissolve node name back for reuse and cut its handler loose from the
 * effect it was serving. Called from `PhaserParticleRenderer.destroy()`.
 *
 * The node itself cannot be unregistered (no `removeNode` exists), so this is
 * the whole of the cleanup story: the name becomes available again, and
 * re-pointing the handler at `IDLE_LAYER_REF` releases the strong reference to
 * the destroyed Effect — without which every sim pool it owns would be pinned
 * for the renderer's lifetime.
 */
export function releaseDissolveHandler(scene: Phaser.Scene, name: string): void {
  const manager = managerOf(scene);
  if (manager === null) return;
  const state = registryFor(manager);
  if (state.free.indexOf(name) !== -1) return;
  state.free.push(name);
  // Two places can still be holding the Effect, and both must let go: the
  // constructed handler's field, and — if Phaser never got round to
  // constructing it — the box its retained constructor closure reads from.
  const box = state.pending.get(name);
  if (box !== undefined) box.current = null;
  const node = manager.getNode(name) as DissolveNodeLike | null;
  if (node !== null && typeof node.setLayerRef === "function") node.setLayerRef(IDLE_LAYER_REF);
}
