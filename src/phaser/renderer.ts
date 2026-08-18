// PhaserParticleRenderer — the R4 surface over a Phaser Container of per-layer
// custom GameObjects. Each `ParticlrLayer` submits its particles as quads
// through Phaser's standard `BatchHandlerQuad` (one batch per layer: the
// per-layer blend-mode change breaks the batch at each boundary, which is
// exactly the one-draw-per-layer invariant the other adapters hold).
//
// WebGL only. Phaser 4's Canvas renderer cannot express the blend table or the
// quad batcher, so `renderCanvas` is a deliberate no-op and construction warns.
import Phaser from "phaser";
import { computeRenderState, makeRenderBuffers, type LayerRenderBuffers } from "../core/render.js";
import type { Effect } from "../core/effect.js";
import type { LayerSim } from "../core/layerSim.js";
import type { Flipbook, ParticleDoc } from "../format/types.js";
import { BUILTIN_TEXTURE_IDS, type BuiltinTextureId } from "../format/types.js";
import { phaserBlendIndex, type PhaserBlendRegistry } from "./blendModes.js";
import {
  builtinKey,
  ensureBuiltinTexture,
  decodeUserTexture,
  userTextureKey,
  type PhaserTextureManagerLike,
} from "./textures.js";
import { submitLayerQuads, type FrameInfo, type QuadBatchLike } from "./submit.js";
import type { Mat2D } from "./quadMath.js";

/**
 * Structural extension of Task 4's texture types: the batch needs the frame's
 * GL wrapper (`texture.get().source.glTexture`) and the P4.1 aspect needs the
 * frame's pixel size. Declared here rather than in `textures.ts` so that module
 * keeps its minimal registration-only surface (structural typing — no conflict).
 */
interface FrameLike {
  width: number;
  height: number;
  source: { glTexture: unknown };
}
/** A Phaser `Texture` as this module uses it. */
export interface LayerTextureLike {
  key: string;
  get(name?: string | number): FrameLike;
}
interface TextureManagerLike extends PhaserTextureManagerLike {
  get(key: string): LayerTextureLike;
}

export interface PhaserParticleRendererOptions {
  scene: Phaser.Scene;
  /**
   * Default true: hook the scene UPDATE event, step with Phaser's delta and
   * sync before render. `false` = the host drives `step`/`sync` itself (every
   * golden run is host-driven).
   */
  autoStep?: boolean;
  /** Override async user-texture loading (tests inject a deterministic one). */
  loadTexture?: (dataUrl: string) => Promise<LayerTextureLike>;
}

interface LayerView {
  go: ParticlrLayer;
  /** The layer's simulation — a stable reference for this Effect's lifetime. */
  sim: LayerSim;
  buffers: LayerRenderBuffers;
  /** Recomputed when an async user texture swaps in. */
  frame: FrameInfo;
  texture: LayerTextureLike;
}

/**
 * The render-node role map. Phaser's `initRenderNodes` only iterates it with
 * `.each(role, node)`, so one shared `Phaser.Structs.Map` serves every layer GO.
 * `Structs.Map`'s constructor is typed `(elements: V[])` in phaser's d.ts while
 * the runtime takes `[key, value]` pairs — hence the cast.
 */
const NODE_MAP = new Phaser.Structs.Map<string, string>([["BatchHandler", "BatchHandlerQuad"]] as unknown as string[]);

/** Component mixins this GO needs. `Texture` is deliberately absent: the layer
 * owns its texture, so `renderFlags` stays at the all-set default. */
export interface ParticlrLayer
  extends Phaser.GameObjects.Components.Alpha,
    Phaser.GameObjects.Components.BlendMode,
    Phaser.GameObjects.Components.Depth,
    Phaser.GameObjects.Components.RenderNodes,
    Phaser.GameObjects.Components.ScrollFactor,
    Phaser.GameObjects.Components.Transform,
    Phaser.GameObjects.Components.Visible {}

/**
 * One custom GameObject per effect layer. It carries no texture of its own and
 * draws nothing on the Canvas renderer.
 *
 * `renderWebGL` is registered as a render STEP by the base GameObject
 * constructor (`addRenderStep(this.renderWebGL)`) and Phaser invokes it
 * UNBOUND — `this` is undefined inside. Every access therefore goes through the
 * `src` parameter, which is the same object.
 */
export class ParticlrLayer extends Phaser.GameObjects.GameObject {
  /** Assigned by the renderer immediately after construction. */
  view!: LayerView;
  /**
   * ONE persistent options object per layer GO. `BatchHandlerQuad.batch`
   * diffs these fields and flushes the batch whenever they change, so a fresh
   * literal per submit would break the batch on every particle.
   */
  private readonly _renderOptions = { multiTexturing: true, lighting: null, smoothPixelArt: null };

  constructor(scene: Phaser.Scene) {
    super(scene, "ParticlrLayer");
    this.initRenderNodes(NODE_MAP as unknown as Map<string, string>);
  }

  renderWebGL(
    _renderer: Phaser.Renderer.WebGL.WebGLRenderer,
    src: ParticlrLayer,
    drawingContext: Phaser.Renderer.WebGL.DrawingContext,
    parentMatrix: Phaser.GameObjects.Components.TransformMatrix | null,
  ): void {
    const camera = drawingContext.camera;
    if (camera === null) return;
    camera.addToRenderList(src);

    const view = src.view;
    const ls = view.sim;
    if (ls.count === 0 || !ls.layer.enabled) return;

    const handler = ((src.customRenderNodes as { BatchHandler?: QuadBatchLike }).BatchHandler ??
      (src.defaultRenderNodes as { BatchHandler?: QuadBatchLike }).BatchHandler) as QuadBatchLike | undefined;
    if (handler === undefined) return;

    // The composed camera+container+GO transform. TransformMatrix exposes it as
    // a,b,c,d,e,f; e/f are the translation components (Mat2D's tx/ty).
    const calc = Phaser.GameObjects.GetCalcMatrix(src, camera, parentMatrix ?? undefined).calc;
    M.a = calc.a;
    M.b = calc.b;
    M.c = calc.c;
    M.d = calc.d;
    M.tx = calc.e;
    M.ty = calc.f;

    submitLayerQuads(
      handler,
      drawingContext,
      view.texture.get().source.glTexture,
      ls,
      view.buffers,
      M,
      view.frame,
      src._renderOptions,
      Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha,
    );
  }

  renderCanvas(): void {
    /* Canvas renderer is unsupported (spec: WebGL only). */
  }
}

// Compose the component mixins onto the prototype, exactly the way Phaser
// composes its own Game Objects: `Phaser.GameObjects.Image` lists these in its
// `Mixins` array and `Phaser.Class` funnels them through `Class.mixin`.
//
// This MUST NOT be a plain `Object.assign`. Phaser's components declare
// `alpha`, `scaleX`, `blendMode`, `visible` … as `{ get, set }` OBJECT LITERALS
// which `Class.mixin` installs with `Object.defineProperty`; a value copy would
// leave the descriptor object itself as the property value, so `go.alpha` would
// be an object and Container's `child.setAlpha(child.alpha * alpha)` would
// yield NaN.
//
// `Phaser.Class` is a real runtime export (src/phaser.js) that phaser's
// bundled d.ts omits, hence the cast. `Filters` and `RenderSteps` already come
// from the GameObject base; `Texture` is deliberately absent.
const COMPONENTS = Phaser.GameObjects.Components as unknown as Record<string, object>;
(Phaser as unknown as { Class: { mixin(ctor: unknown, mixins: object[]): void } }).Class.mixin(ParticlrLayer, [
  COMPONENTS.Alpha!,
  COMPONENTS.BlendMode!,
  COMPONENTS.Depth!,
  COMPONENTS.RenderNodes!,
  COMPONENTS.ScrollFactor!,
  COMPONENTS.Transform!,
  COMPONENTS.Visible!,
]);

/** Scratch transform, reused every submit (single-threaded render pass). */
const M: Mat2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export class PhaserParticleRenderer {
  /** The display object the host adds to its Scene. */
  readonly gameObject: Phaser.GameObjects.Container;
  /** Non-fatal issues surfaced for the editor (E10 fallbacks, Canvas renderer). */
  readonly warnings: string[] = [];
  /** Resolves once every embedded user texture has decoded (or failed over). */
  readonly ready: Promise<void>;

  private readonly effect: Effect;
  private readonly scene: Phaser.Scene;
  private readonly tm: TextureManagerLike;
  private readonly views: LayerView[] = [];
  private readonly loadTexture: (dataUrl: string) => Promise<LayerTextureLike>;
  private onUpdate: ((time: number, deltaMs: number) => void) | null = null;
  private destroyed = false;

  constructor(effect: Effect, opts: PhaserParticleRendererOptions) {
    this.effect = effect;
    this.scene = opts.scene;
    const tm = opts.scene.sys.textures as unknown as TextureManagerLike;
    this.tm = tm;
    this.loadTexture = opts.loadTexture ?? ((url: string) => decodeUserTexture(tm, url) as Promise<LayerTextureLike>);
    this.gameObject = new Phaser.GameObjects.Container(opts.scene);

    // Canvas renderer: no blend table, no quad batcher. Warn once and let the
    // layer GOs stay inert (renderCanvas is a no-op).
    const renderer = opts.scene.sys.renderer as unknown as PhaserBlendRegistry | undefined;
    const webgl = !!renderer && Array.isArray(renderer.blendModes) && typeof renderer.addBlendMode === "function";
    if (!webgl) {
      this.warnings.push("Phaser is not using the WebGL renderer; particlr renders nothing (Canvas is unsupported).");
    }

    const pending: Promise<void>[] = [];

    for (const ls of effect.layers) {
      const layer = ls.layer;
      const resolved = this.resolveTexture(layer.texture.ref, effect.doc);
      const go = new ParticlrLayer(opts.scene);
      if (webgl) go.setBlendMode(phaserBlendIndex(renderer, layer.blend));
      this.gameObject.add(go);

      // While a user sheet is still the built-in placeholder, slicing it would
      // be wrong — stay at the 1x1 whole-texture aspect until the real sheet
      // swaps in (pixi/three parity).
      const frames = resolved.pendingDataUrl === undefined ? layer.texture.frames : null;
      const view: LayerView = {
        go,
        sim: ls,
        buffers: makeRenderBuffers(layer.emission.maxParticles),
        frame: frameInfoFor(resolved.texture, frames),
        texture: resolved.texture,
      };
      go.view = view;
      this.views.push(view);

      if (resolved.pendingDataUrl !== undefined) {
        pending.push(this.loadUserTextureInto(view, resolved.pendingDataUrl, layer.texture.ref, layer.texture.frames));
      }
    }

    this.ready = Promise.all(pending).then(() => undefined);

    if (opts.autoStep !== false) {
      // Phaser's UPDATE delta is MILLISECONDS; the sim steps in seconds and
      // clamps to maxDt internally, so a hidden-tab catch-up cannot explode.
      this.onUpdate = (_time: number, deltaMs: number) => {
        this.effect.step(deltaMs / 1000);
        this.sync();
      };
      opts.scene.events.on(Phaser.Scenes.Events.UPDATE, this.onUpdate);
    }
  }

  /** Copy the current simulation frame into the per-layer render buffers and
   * place each layer GO. Call after `step()` when driving manually. */
  sync(): void {
    const ex = this.effect.emitterX;
    const ey = this.effect.emitterY;
    for (const view of this.views) {
      const ls = view.sim;
      // A world layer's particles already carry parent-frame coordinates, so
      // its GO sits at the container origin; a local layer rides the emitter.
      if (ls.layer.space === "world") view.go.setPosition(0, 0);
      else view.go.setPosition(ex, ey);
      if (ls.layer.enabled && ls.count > 0) computeRenderState(ls, view.buffers);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.onUpdate !== null) {
      this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.onUpdate);
      this.onUpdate = null;
    }
    // Destroys the layer children with it. Textures are NEVER destroyed:
    // built-ins and decoded user sheets are shared page-lifetime cache entries
    // in the TextureManager (same stance as every other adapter).
    this.gameObject.destroy();
  }

  // --- textures ------------------------------------------------------------

  /**
   * Resolve a texture ref to a Phaser texture available *now*. Built-ins
   * register on first use; a not-yet-decoded user texture returns the soft
   * circle placeholder plus the data URL to load asynchronously.
   */
  private resolveTexture(ref: string, doc: ParticleDoc): { texture: LayerTextureLike; pendingDataUrl?: string } {
    if ((BUILTIN_TEXTURE_IDS as readonly string[]).includes(ref)) {
      return { texture: this.builtin(ref as BuiltinTextureId) };
    }
    if (ref.startsWith("user:")) {
      const dataUrl = doc.textures?.[ref.slice(5)];
      if (dataUrl) {
        // Another instance may already have decoded this exact data URL
        // (same doc reused, or a rebuilt preview) — resolve synchronously
        // from the TextureManager instead of always flashing the placeholder
        // (pixi/three parity, mirrors `cachedUserTexture` in textures.ts but
        // through `this.tm`'s richer `LayerTextureLike`-returning `get`).
        const key = userTextureKey(dataUrl);
        if (this.tm.exists(key)) return { texture: this.tm.get(key) };
        return { texture: this.builtin("circle-soft"), pendingDataUrl: dataUrl };
      }
      // E10: missing embedded texture -> substitute the soft circle + warn.
      this.warnings.push(`Texture "${ref}" is missing; using the built-in soft circle.`);
    } else {
      this.warnings.push(`Unknown texture "${ref}"; using the built-in soft circle.`);
    }
    return { texture: this.builtin("circle-soft") };
  }

  private builtin(id: BuiltinTextureId): LayerTextureLike {
    ensureBuiltinTexture(this.tm, id);
    return this.tm.get(builtinKey(id));
  }

  private async loadUserTextureInto(
    view: LayerView,
    dataUrl: string,
    ref: string,
    frames: Flipbook | null,
  ): Promise<void> {
    let texture: LayerTextureLike;
    try {
      texture = await this.loadTexture(dataUrl);
    } catch {
      // Decode failed: leave the soft-circle placeholder in place and warn.
      this.warnings.push(`Texture "${ref}" could not be decoded; using the built-in soft circle.`);
      return;
    }
    if (this.destroyed) return;
    view.texture = texture;
    view.frame = frameInfoFor(texture, frames);
    // Task 7: rebind trail texture here
  }
}

/**
 * P4.1 sizing: `aspect = frameH / frameW` where a frame is the sheet divided by
 * the flipbook grid, so a particle renders `size` px wide and `size * aspect`
 * px tall. A null flipbook means a 1x1 grid — the whole texture is the frame.
 */
function frameInfoFor(texture: LayerTextureLike, fb: Flipbook | null): FrameInfo {
  const cols = fb ? fb.cols : 1;
  const rows = fb ? fb.rows : 1;
  const frame = texture.get();
  return { aspect: frame.height / rows / (frame.width / cols), cols, rows };
}
