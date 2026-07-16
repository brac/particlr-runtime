// Pixi v7 adapter. A faithful port of the v8 adapter (src/pixi/renderer.ts) to
// Pixi v7.4.3 — same public class shape, same sim consumption, same warnings /
// ready / sync / destroy semantics (ruling R4). Consumes core simulation state
// and renders it through one ParticleContainer per layer. All per-particle
// render values (size, color, flipbook frame) come from core.computeRenderState,
// so this adapter is dumb — it only maps numbers onto Pixi Sprites.
//
// v7 divergences from v8 (all researched in PIXI7_PLAN — do NOT re-derive):
//   - ParticleContainer children are real `Sprite`s (v8's Particle/addParticle/
//     particleChildren do not exist); the ctor is positional
//     `new ParticleContainer(maxSize, properties, ...)`.
//   - The scale-carrying dynamic flag is `vertices` (aliased `scale`), NOT v8's
//     `vertex`; alpha rides the `tint` attribute (per-particle alpha ⇒
//     `tint: true`). `uvs` is dynamic ONLY for flipbook layers.
//   - There is NO live-prefix draw count and NO `setSize(n)`: v7 draws
//     `children.length` unconditionally, and `child.visible=false` is IGNORED
//     inside ParticleContainer. The only clean mapping to our swap-compacted
//     pool is to keep `pc.children.length === liveCount` (trim/grow against a
//     preallocated Sprite pool — R6).
//   - Blend strings map to the numeric BLEND_MODES enum.
//   - Every runtime-created texture passes explicit
//     `{ alphaMode: ALPHA_MODES.UNPACK, scaleMode: SCALE_MODES.LINEAR }` (R5),
//     since v7's fromBuffer defaults to NPM + NEAREST.
import {
  ALPHA_MODES,
  BLEND_MODES,
  Container,
  ParticleContainer,
  Rectangle,
  SCALE_MODES,
  Sprite,
  Texture,
} from "pixi.js";
import type { BlendMode, BuiltinTextureId, Flipbook, ParticleDoc } from "../format/types.js";
import { BUILTIN_TEXTURE_IDS } from "../format/types.js";
import { decodeBase64, IMAGE_DATA_URL_RE } from "../format/base64.js";
import { computeRenderState, makeRenderBuffers, type LayerRenderBuffers } from "../core/render.js";
import { computeTrailGeometry, computeConnectGeometry, makeTrailGeometry } from "../core/trailGeometry.js";
import type { Effect } from "../core/effect.js";
// textures.ts has zero pixi imports and is SHARED as-is with the v8 adapter
// (never copied — Codebase facts, PIXI7_PLAN). We import the pure pixel-math
// generator here and wrap it in a v7 Texture below.
import { generateBuiltinTexture, type TextureData } from "../pixi/textures.js";
import { makeTrailView, syncTrailView, type TrailView } from "./trailMesh.js";

export { generateBuiltinTexture, type TextureData };

const DEG2RAD = Math.PI / 180;

// R5 alphaMode policy: premultiply-on-upload everywhere. The builtin/user pixel
// data is straight (non-premultiplied) alpha; UNPACK makes Pixi premultiply on
// upload so ADD/SCREEN resolve to the same GL blend funcs as v8's premultiplied
// world. LINEAR because v7's fromBuffer would otherwise default to NEAREST.
function textureFromData(d: TextureData): Texture {
  return Texture.fromBuffer(d.pixels, d.width, d.height, {
    alphaMode: ALPHA_MODES.UNPACK,
    scaleMode: SCALE_MODES.LINEAR,
  });
}

// Built-in textures are pure-procedural and identical across every renderer
// instance, so they are cached once at module scope and shared. They are never
// destroyed by this adapter: a ParticleContainer binds `children[0]._texture.
// baseTexture` for the whole batch, and destroying a still-referenced source
// would break particle rendering after the editor rebuilds the preview. The
// `destroyed` guard self-heals the cache if a *host* teardown
// (app.destroy(..., { texture: true })) destroys a still-referenced built-in:
// regenerating from pure pixel math is cheap. (P0.2)
const BUILTIN_TEXTURES = new Map<BuiltinTextureId, Texture>();

function builtinTexture(id: BuiltinTextureId): Texture {
  let t = BUILTIN_TEXTURES.get(id);
  if (!t || t.destroyed) {
    t = textureFromData(generateBuiltinTexture(id));
    BUILTIN_TEXTURES.set(id, t);
  }
  return t;
}

// Decoded user textures (embedded data URLs), cached by data URL so a rebuild
// or a second layer reuses the decode instead of re-decoding. Same
// never-destroy + destroyed-guard policy as the built-ins. Page-lifetime cache
// with no eviction — see runtime README; per-texture refcounting is v1.5.
const USER_TEXTURES = new Map<string, Texture>();

/**
 * Parse an embedded texture (`data:image/...;base64,` — the E44 shape) into a
 * typed Blob. Deliberately NOT `fetch(dataUrl)`: the runtime must carry zero
 * network capability (any `fetch` identifier gets the package flagged by
 * supply-chain scanners), and a non-`data:` string in a hand-crafted doc must
 * be unloadable rather than silently fetched. Throws on anything that is not a
 * well-formed base64 image data URL — callers treat that as a failed decode
 * (E10 soft-circle fallback). Exported for tests.
 *
 * Replicated here (not imported from ../pixi/renderer.ts, which imports pixi.js
 * v8) from the pixi-free primitives in ../format/base64.js, so the v7 adapter
 * never pulls a v8-major import into its module graph.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const m = IMAGE_DATA_URL_RE.exec(dataUrl);
  const bytes = m ? decodeBase64(dataUrl.slice(m[0].length)) : null;
  if (!m || !bytes) throw new Error("texture is not a base64 image data URL");
  // decodeBase64 allocates a fresh Uint8Array, so its .buffer is a plain
  // ArrayBuffer — the cast just recovers what TS's ArrayBufferLike default loses.
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: m[1]!.toLowerCase() });
}

/** Default browser decode path for an embedded data-URL texture. `Texture.from`
 * with an ImageBitmap auto-selects an ImageBitmapResource; the explicit R5
 * options keep it premultiply-on-upload + LINEAR to match the built-ins. */
async function decodeDataUrlTexture(dataUrl: string): Promise<Texture> {
  const cached = USER_TEXTURES.get(dataUrl);
  if (cached && !cached.destroyed) return cached;
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  const tex = Texture.from(bitmap, { alphaMode: ALPHA_MODES.UNPACK, scaleMode: SCALE_MODES.LINEAR });
  USER_TEXTURES.set(dataUrl, tex);
  return tex;
}

// Our BlendMode strings map onto the numeric v7 BLEND_MODES enum. `erase` →
// BLEND_MODES.ERASE (=26, == DST_OUT; GL func [ZERO, ONE_MINUS_SRC_ALPHA] —
// verified against 7.4.3 mapWebGLBlendModesToPixi). v8's identity passthrough
// (its enum values ARE the strings) becomes an explicit lookup here.
const BLEND_MAP: Record<BlendMode, BLEND_MODES> = {
  normal: BLEND_MODES.NORMAL,
  add: BLEND_MODES.ADD,
  multiply: BLEND_MODES.MULTIPLY,
  screen: BLEND_MODES.SCREEN,
  erase: BLEND_MODES.ERASE,
};

function blendOf(b: BlendMode): BLEND_MODES {
  return BLEND_MAP[b];
}

// Slice a flipbook sheet into cols×rows frame Textures sharing the sheet's
// baseTexture, row-major with a top-left origin (frame index i → col i%cols, row
// i/cols) to match core's linear frame index (core/render.ts flipbookFrame).
// `new Texture(base, frame)` runs the frame setter, which calls updateUvs() when
// the baseTexture is valid — no separate updateUvs() call is needed (verified
// against 7.4.3 Texture ctor). Each frame's `orig`/`uvs` come from its
// Rectangle, so a particle wearing frame i sizes and samples exactly that cell.
// (P4.1)
function sliceFlipbook(sheet: Texture, fb: Flipbook): Texture[] {
  const fw = sheet.width / fb.cols;
  const fh = sheet.height / fb.rows;
  const frames: Texture[] = [];
  for (let row = 0; row < fb.rows; row++) {
    for (let col = 0; col < fb.cols; col++) {
      frames.push(new Texture(sheet.baseTexture, new Rectangle(col * fw, row * fh, fw, fh)));
    }
  }
  return frames;
}

/** Frame slices + inverse *frame* width for a resolved sheet. A single-cell (or
 * absent) flipbook yields no slices and the whole-texture inverse width. (P4.1) */
function framesFor(tex: Texture, fb: Flipbook | null): { frames: Texture[] | null; invFrameWidth: number } {
  if (fb && fb.cols * fb.rows > 1) {
    return { frames: sliceFlipbook(tex, fb), invFrameWidth: fb.cols / tex.width };
  }
  return { frames: null, invFrameWidth: 1 / tex.width };
}

interface LayerView {
  pc: ParticleContainer;
  /** The layer's pool of preallocated Sprites (one per maxParticles). Owns every
   * Sprite; sync() keeps `pc.children` equal to the live prefix by trim/grow
   * against this pool (R6). */
  particles: Sprite[];
  buffers: LayerRenderBuffers;
  /** The currently-resolved layer texture (placeholder or decoded sheet). v7's
   * ParticleContainer has NO `.texture` property (unlike v8) — it binds
   * `children[0]._texture.baseTexture` lazily — so the view tracks the layer
   * texture itself for async swaps and inspection. */
  texture: Texture;
  /** Inverse of the rendered cell width: 1/frameWidth for a flipbook layer,
   * 1/texWidth otherwise. `scale = size * invFrameWidth` makes a particle
   * `size` px on screen regardless of sheet layout. (P4.1) */
  invFrameWidth: number;
  /** The layer's flipbook config, kept so an async texture swap can re-slice
   * the decoded sheet. Null when the layer is single-frame. (P4.1) */
  flipbook: Flipbook | null;
  /** Sliced frame textures (row-major), or null for a single-frame layer.
   * `sync()` assigns `particles[j].texture = frames[frameIndex]`. (P4.1) */
  frames: Texture[] | null;
  /** Per-particle or connect trail ribbon (schemaVersion 3/9); null unless the
   * layer has a trail module. Its Mesh is added to the container BEFORE this
   * layer's ParticleContainer, so the ribbon renders under the sprites. (M2) */
  trail: TrailView | null;
}

export interface PixiParticleRendererOptions {
  /** Reserved for future use (e.g. building GPU RenderTextures). */
  renderer?: unknown;
  /**
   * Override async user-texture loading. Defaults to a browser decode
   * (base64 decode → createImageBitmap → Texture.from; no fetch — the runtime
   * carries no network capability). Tests inject a deterministic loader since
   * node has no `createImageBitmap`.
   */
  loadTexture?: (dataUrl: string) => Promise<Texture>;
}

export class PixiParticleRenderer {
  readonly container: Container;
  /** Non-fatal issues surfaced for the editor (e.g. E10 texture fallback). */
  readonly warnings: string[] = [];
  /**
   * Resolves once every embedded user texture has decoded and been swapped in
   * (or failed and fallen back). Built-in-only docs resolve immediately. Tests
   * await this to observe the post-load state.
   */
  readonly ready: Promise<void>;

  private readonly effect: Effect;
  private readonly views: LayerView[] = [];
  private readonly loadTexture: (dataUrl: string) => Promise<Texture>;
  private destroyed = false;

  constructor(effect: Effect, opts?: PixiParticleRendererOptions) {
    this.effect = effect;
    this.container = new Container();
    this.loadTexture = opts?.loadTexture ?? decodeDataUrlTexture;

    const pending: Promise<void>[] = [];

    for (const ls of effect.layers) {
      const layer = ls.layer;
      const fb = layer.texture.frames;
      const resolved = this.resolveTexture(layer.texture.ref, effect.doc);
      const tex = resolved.tex;
      const isPending = resolved.pendingDataUrl !== undefined;
      const max = layer.emission.maxParticles;

      // Slice the flipbook now only if the real sheet is already resolved. While
      // a user texture is still decoding, `tex` is the single-frame placeholder;
      // slicing that would be wrong, so frames stay null until applyTexture
      // re-slices the decoded sheet. (P4.1)
      const sliced = isPending ? { frames: null, invFrameWidth: 1 / tex.width } : framesFor(tex, fb);
      const particleTex = sliced.frames ? sliced.frames[0]! : tex;

      // v7 ParticleContainer: positional ctor + a dynamic-flags object. The flags
      // are the v7 analog of v8's "giant particle" regression guard:
      //   - `vertices` (NOT v8's `vertex`; `scale` is an accepted alias) carries
      //     the per-particle quad scale. Left static it uploads once, freezing
      //     every not-yet-live pool slot at scale 1 → when the live count grows
      //     past the first-render count, that slot renders as a full-texture
      //     "giant particle" and size-over-lifetime never animates. Must be
      //     dynamic.
      //   - `position`, `rotation`: per-particle every frame.
      //   - `tint`: v7 packs alpha INTO the tint attribute (uploadTint writes
      //     tintRGB premultiplied by sprite.alpha), so per-particle alpha ⇒
      //     `tint: true`.
      //   - `uvs`: dynamic ONLY for flipbook layers (sync() rewrites each live
      //     particle's texture to the current frame; the uvs buffer must
      //     re-upload to follow). Non-flipbook layers keep uvs static so their
      //     upload cost — and every committed golden — is unchanged. (P4.1)
      // An unknown key is silently accepted and ignored (setProperties only
      // reads vertices/scale/position/rotation/uvs/tint/alpha), the same trap as
      // the v8 vertex/scale bug.
      const pc = new ParticleContainer(max, {
        vertices: true,
        position: true,
        rotation: true,
        tint: true,
        uvs: fb !== null,
      });
      pc.blendMode = blendOf(layer.blend);

      // Dissolve (schemaVersion 4): a dissolve layer will OWN a forked particle
      // shader/renderer. M3 wiring point — this milestone renders dissolve
      // layers through the stock v7 ParticleRenderer (no fork yet). The dissolve
      // golden preset is the eventual live-GL proof.

      // Preallocate the full pool of Sprite objects (one-time; no per-frame
      // allocation churn) but do NOT add them to the container. sync() keeps
      // pc.children equal to exactly the live prefix particles[0..count), so the
      // per-frame vertex upload and draw scale with the LIVE count, not
      // maxParticles capacity — a 40k-cap layer showing 100 particles uploads
      // 100, not 40 000 (P4.2). The pool array below owns every Sprite.
      const particles: Sprite[] = [];
      for (let k = 0; k < max; k++) {
        const p = new Sprite(particleTex);
        p.anchor.set(0.5, 0.5);
        particles.push(p);
      }

      // Trail ribbon (M2): build the mesh BEFORE adding the ParticleContainer so
      // it sits behind (renders under) this layer's sprites. Its geometry buffers
      // wrap the core TrailGeometry arrays; sync() fills them via
      // computeTrailGeometry/computeConnectGeometry. Blend mode is shared with the
      // layer. Only trail layers add an extra child, so a trail-null document's
      // child order — and every committed golden — is unchanged.
      let trail: TrailView | null = null;
      if (layer.trail !== null) {
        // Connect mode (v9): ONE ribbon of up to `max` points (verts = max·2,
        // segs = max−1) — makeTrailGeometry(1, max). Per-particle: `max` ribbons of
        // `maxPoints`. Same mesh/GL path either way (R5); sync() picks the builder.
        const geom =
          layer.trail.mode === "connect" ? makeTrailGeometry(1, max) : makeTrailGeometry(max, layer.trail.maxPoints);
        trail = makeTrailView(geom, tex, blendOf(layer.blend));
        this.container.addChild(trail.mesh);
      }

      this.container.addChild(pc);
      const view: LayerView = {
        pc,
        particles,
        buffers: makeRenderBuffers(max),
        texture: tex,
        invFrameWidth: sliced.invFrameWidth,
        flipbook: fb,
        frames: sliced.frames,
        trail,
      };
      this.views.push(view);

      // A user texture starts as a synchronous built-in placeholder; kick off
      // the async decode and swap it in when ready (also fixes invFrameWidth
      // and slices the flipbook, which the placeholder would otherwise leave
      // wrong/null). (P0.1/P4.1)
      if (resolved.pendingDataUrl !== undefined) {
        pending.push(this.loadUserTextureInto(view, resolved.pendingDataUrl, layer.texture.ref));
      }
    }

    this.ready = Promise.all(pending).then(() => undefined);
  }

  /** Copy the current simulation frame onto the Pixi sprites. Call after step(). */
  sync(): void {
    const layers = this.effect.layers;
    const ex = this.effect.emitterX;
    const ey = this.effect.emitterY;
    for (let i = 0; i < this.views.length; i++) {
      const ls = layers[i]!;
      const view = this.views[i]!;
      const enabled = ls.layer.enabled;
      const count = enabled ? ls.count : 0;

      // Dissolve (M3 wiring point): a dissolve layer will advance its erosion
      // clock (uTime = effect.time) here every frame. Stock pipeline this
      // milestone — nothing to advance yet.

      // Per-layer container placement (schemaVersion 2). A local layer rides the
      // emitter (its particles carry effect-local coords); a world layer stays at
      // the container origin because its particles already carry parent-frame
      // coords, so a moving emitter leaves them behind — the trail. With a
      // never-moved emitter both resolve to (0,0), keeping v1 output identical.
      if (ls.layer.space === "world") view.pc.position.set(0, 0);
      else view.pc.position.set(ex, ey);
      // The trail mesh's vertices carry the same sim-frame coordinates as the
      // sprites, so it rides the emitter exactly like the ParticleContainer (M2).
      if (view.trail !== null) {
        if (ls.layer.space === "world") view.trail.mesh.position.set(0, 0);
        else view.trail.mesh.position.set(ex, ey);
      }

      if (enabled && count > 0) {
        computeRenderState(ls, view.buffers);
        const p = ls.pool;
        const b = view.buffers;
        const inv = view.invFrameWidth;
        const frames = view.frames;
        // Two loop bodies (TIER1_PLAN §0.5). The EXISTING body is kept verbatim
        // when no render-buffer-consuming module is active, so every committed
        // golden stays byte-identical. The extended body (velocity alignment +
        // speed stretch + random flip) reads the stretch/velAngle/flip buffers
        // that computeRenderState fills when render OR randomFlip is non-null.
        if (ls.layer.render === null && ls.layer.randomFlip === null) {
          for (let j = 0; j < count; j++) {
            const part = view.particles[j]!;
            part.x = p.x[j]!;
            part.y = p.y[j]!;
            part.rotation = p.rotation[j]! * DEG2RAD;
            const s = b.size[j]! * inv;
            part.scale.x = s;
            part.scale.y = s;
            const r = Math.max(0, Math.min(255, Math.round(b.r[j]! * 255)));
            const g = Math.max(0, Math.min(255, Math.round(b.g[j]! * 255)));
            const bl = Math.max(0, Math.min(255, Math.round(b.b[j]! * 255)));
            part.tint = (r << 16) | (g << 8) | bl;
            part.alpha = Math.max(0, Math.min(1, b.a[j]!));
            // Flipbook: wear the current frame slice. Index is core-clamped to
            // [0, cols*rows) (render.ts) and cols*rows ≤ 4096 < Uint16 max, so no
            // bounds check is needed here. (P4.1)
            if (frames) part.texture = frames[b.frame[j]!]!;
          }
        } else {
          for (let j = 0; j < count; j++) {
            const part = view.particles[j]!;
            part.x = p.x[j]!;
            part.y = p.y[j]!;
            // Sprite rotation follows the render buffer (velocity angle for
            // align:"velocity", else the particle's own rotation), in radians.
            part.rotation = b.velAngle[j]! * DEG2RAD;
            const s = b.size[j]! * inv;
            // Stretch scales along the (rotated) x/motion axis only.
            let scaleX = s * b.stretch[j]!;
            let scaleY = s;
            // Random flip (schemaVersion 3, §M5): negative scale per axis, applied
            // AFTER the stretch multiply — a genuine mirror, not a UV flip. v7's
            // uploadVertices multiplies quad corners by raw scale.x/.y, so signed
            // scale mirrors correctly (with `vertices` dynamic).
            const flip = b.flip[j]!;
            if (flip & 1) scaleX = -scaleX;
            if (flip & 2) scaleY = -scaleY;
            part.scale.x = scaleX;
            part.scale.y = scaleY;
            const r = Math.max(0, Math.min(255, Math.round(b.r[j]! * 255)));
            const g = Math.max(0, Math.min(255, Math.round(b.g[j]! * 255)));
            const bl = Math.max(0, Math.min(255, Math.round(b.b[j]! * 255)));
            part.tint = (r << 16) | (g << 8) | bl;
            part.alpha = Math.max(0, Math.min(1, b.a[j]!));
            if (frames) part.texture = frames[b.frame[j]!]!;
          }
        }
      }
      // Trail ribbon geometry (M2): rebuild from the layer's ring buffers (or the
      // connect view) and update the mesh buffers + draw range. computeRenderState
      // above filled view.buffers (the trail's null-color path reads each
      // particle's current render RGBA from it); when the layer is disabled or
      // empty there is no render state, so clear the ribbon to zero draws.
      if (view.trail !== null) {
        if (enabled && count > 0) {
          // Connect mode (v9) builds ONE ribbon through the live particles' current
          // positions; per-particle mode rebuilds each particle's own ring ribbon.
          if (ls.layer.trail!.mode === "connect") computeConnectGeometry(ls, view.buffers, view.trail.geom);
          else computeTrailGeometry(ls, view.buffers, view.trail.geom);
        } else {
          view.trail.geom.vertexCount = 0;
          view.trail.geom.indexCount = 0;
        }
        syncTrailView(view.trail);
      }
      this.syncRenderList(view, count);
    }
  }

  /**
   * Keep `pc.children` equal to exactly the live prefix `particles[0..count)`.
   * The core pool is swap-compacted, so those are the live particles in stable
   * render order; dead slots are never in the container and thus never uploaded,
   * drawn, or rasterized (P4.2). v7 draws `children.length` unconditionally (no
   * live-prefix draw count, and `visible=false` is ignored inside
   * ParticleContainer), so this trim/grow IS the mapping.
   *
   * Trim idiom (R6): `pc.children.length = count` is NOT valid on a v7 Container
   * — a raw length assignment leaves the dropped Sprites with a stale
   * `parent`/`transform._parentID` back-reference and, critically, never calls
   * `onChildrenChange`, which is what bumps `_bufferUpdateIDs` to flag the
   * ParticleBuffer's STATIC (uvs) re-upload. So we go through the public
   * `removeChildren(count)` (trim the tail) / `addChild` (grow) path, whose
   * `onChildrenChange` fires the static re-upload automatically — replacing v8's
   * manual `pc.update()` + renderHighWater bookkeeping (v7 has no such method).
   * Verified against 7.4.3 Container/ParticleContainer/ParticleRenderer source.
   */
  private syncRenderList(view: LayerView, count: number): void {
    const pc = view.pc;
    const len = pc.children.length;
    if (len === count) return;
    if (count < len) {
      pc.removeChildren(count); // shrink: drop the just-died tail (flags static re-upload)
    } else {
      for (let j = len; j < count; j++) pc.addChild(view.particles[j]!); // grow back
    }
  }

  destroy(): void {
    // Destroy the display objects only — NOT the textures. Built-ins are shared
    // at module scope and user textures are cached by data URL; a
    // ParticleContainer binds `children[0]._texture.baseTexture` for the batch,
    // so destroying any source here would break all later particle rendering.
    // The `destroyed` flag stops an in-flight user-texture load from touching a
    // torn-down view. (P0.1/P0.2)
    this.destroyed = true;
    this.container.destroy({ children: true });
  }

  // --- textures ------------------------------------------------------------

  /**
   * Resolve a texture ref to a Texture available *now*. Built-ins and
   * already-decoded user textures resolve synchronously; a not-yet-decoded user
   * texture returns a built-in placeholder plus the data URL to load.
   */
  private resolveTexture(ref: string, doc: ParticleDoc): { tex: Texture; pendingDataUrl?: string } {
    if ((BUILTIN_TEXTURE_IDS as readonly string[]).includes(ref)) {
      return { tex: builtinTexture(ref as BuiltinTextureId) };
    }
    if (ref.startsWith("user:")) {
      const name = ref.slice(5);
      const dataUrl = doc.textures?.[name];
      if (dataUrl) {
        const cached = USER_TEXTURES.get(dataUrl);
        if (cached && !cached.destroyed) return { tex: cached };
        return { tex: builtinTexture("circle-soft"), pendingDataUrl: dataUrl };
      }
      // E10: missing embedded texture -> substitute the soft circle + warn.
      this.warnings.push(`Texture "${ref}" is missing; using the built-in soft circle.`);
    } else {
      this.warnings.push(`Unknown texture "${ref}"; using the built-in soft circle.`);
    }
    return { tex: builtinTexture("circle-soft") };
  }

  private async loadUserTextureInto(view: LayerView, dataUrl: string, ref: string): Promise<void> {
    let tex: Texture;
    try {
      tex = await this.loadTexture(dataUrl);
    } catch {
      // Decode failed: leave the soft-circle placeholder in place and warn.
      this.warnings.push(`Texture "${ref}" could not be decoded; using the built-in soft circle.`);
      return;
    }
    USER_TEXTURES.set(dataUrl, tex);
    if (this.destroyed || tex.destroyed) return;
    this.applyTexture(view, tex);
  }

  private applyTexture(view: LayerView, tex: Texture): void {
    // Re-slice the flipbook from the freshly-decoded sheet (frames stayed null
    // while the placeholder was showing) and repoint every particle. All frame
    // slices share tex.baseTexture, so the container binds one source either
    // way. (P4.1)
    const sliced = framesFor(tex, view.flipbook);
    view.frames = sliced.frames;
    view.invFrameWidth = sliced.invFrameWidth;
    view.texture = tex;
    const particleTex = sliced.frames ? sliced.frames[0]! : tex;
    for (const p of view.particles) p.texture = particleTex;
    // No explicit static-upload flush is needed: the next sync() adds/removes
    // through addChild/removeChild, whose onChildrenChange flags the uvs
    // re-upload. (v7 has no v8-style pc.update().)
  }
}
