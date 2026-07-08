// Pixi v8 adapter. Consumes core simulation state and renders it through one
// ParticleContainer per layer. All per-particle render values (size, color,
// flipbook frame) come from core.computeRenderState, so this adapter is dumb —
// it only maps numbers onto Pixi Particles. Same code path as the editor
// preview (L4).
import {
  BufferImageSource,
  Container,
  ImageSource,
  Particle,
  ParticleContainer,
  Rectangle,
  Texture,
  type BLEND_MODES,
} from "pixi.js";
import type { BlendMode, BuiltinTextureId, Flipbook, ParticleDoc } from "../format/types.js";
import { BUILTIN_TEXTURE_IDS } from "../format/types.js";
import { computeRenderState, makeRenderBuffers, type LayerRenderBuffers } from "../core/render.js";
import { computeTrailGeometry, makeTrailGeometry } from "../core/trailGeometry.js";
import type { Effect } from "../core/effect.js";
import { generateBuiltinTexture, type TextureData } from "./textures.js";
import { makeTrailView, syncTrailView, type TrailView } from "./trailMesh.js";

const DEG2RAD = Math.PI / 180;

function textureFromData(d: TextureData): Texture {
  const source = new BufferImageSource({
    resource: d.pixels,
    width: d.width,
    height: d.height,
    alphaMode: "premultiply-alpha-on-upload",
    scaleMode: "linear",
  });
  return new Texture({ source });
}

// Built-in textures are pure-procedural and identical across every renderer
// instance, so they are cached once at module scope and shared. They are never
// destroyed by this adapter: Pixi's ParticleContainer default shader keeps a
// "change" listener on whichever texture *source* was last bound, and
// destroying that source nulls the shared shader's bind group — which
// permanently breaks particle rendering after the editor rebuilds the preview.
// The `destroyed` guard self-heals the cache if a *host* teardown
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
// or a second layer reuses the decode instead of re-fetching. Same
// never-destroy + destroyed-guard policy as the built-ins. Page-lifetime cache
// with no eviction — see runtime README; per-texture refcounting is v1.5.
const USER_TEXTURES = new Map<string, Texture>();

/** Default browser decode path for an embedded data-URL texture. */
async function decodeDataUrlTexture(dataUrl: string): Promise<Texture> {
  const cached = USER_TEXTURES.get(dataUrl);
  if (cached && !cached.destroyed) return cached;
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const source = new ImageSource({ resource: bitmap });
  const tex = new Texture({ source });
  USER_TEXTURES.set(dataUrl, tex);
  return tex;
}

function blendOf(b: BlendMode): BLEND_MODES {
  // Our enum values are exactly Pixi's blend-mode strings.
  return b;
}

// Slice a flipbook sheet into cols×rows frame Textures sharing the sheet's
// source, row-major with a top-left origin (frame index i → col i%cols, row
// i/cols) to match core's linear frame index (core/render.ts flipbookFrame).
// Each frame's `orig`/`uvs` come from its Rectangle, so a particle wearing
// frame i sizes and samples exactly that cell. (P4.1)
function sliceFlipbook(sheet: Texture, fb: Flipbook): Texture[] {
  const fw = sheet.width / fb.cols;
  const fh = sheet.height / fb.rows;
  const frames: Texture[] = [];
  for (let row = 0; row < fb.rows; row++) {
    for (let col = 0; col < fb.cols; col++) {
      frames.push(new Texture({ source: sheet.source, frame: new Rectangle(col * fw, row * fh, fw, fh) }));
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
  particles: Particle[];
  buffers: LayerRenderBuffers;
  /** Inverse of the rendered cell width: 1/frameWidth for a flipbook layer,
   * 1/texWidth otherwise. `scaleX = size * invFrameWidth` makes a particle
   * `size` px on screen regardless of sheet layout. (P4.1) */
  invFrameWidth: number;
  /** The layer's flipbook config, kept so an async texture swap can re-slice
   * the decoded sheet. Null when the layer is single-frame. (P4.1) */
  flipbook: Flipbook | null;
  /** Sliced frame textures (row-major), or null for a single-frame layer.
   * `sync()` assigns `particles[j].texture = frames[frameIndex]`. (P4.1) */
  frames: Texture[] | null;
  /** Highest render-list length whose static attributes have been uploaded.
   * A particle's static data (UVs) is constant once written, so the container is
   * only marked dirty when the live count reaches a *new* peak — a near-capacity
   * layer whose count jitters at its top never re-uploads the static buffer. (P4.2) */
  renderHighWater: number;
  /** Per-particle trail ribbon (schemaVersion 3, M9); null unless the layer has a
   * trail module. Its Mesh is added to the container BEHIND this layer's
   * ParticleContainer, so the ribbon renders under the sprites. (M9) */
  trail: TrailView | null;
}

export interface PixiParticleRendererOptions {
  /** Reserved for future use (e.g. building GPU RenderTextures). */
  renderer?: unknown;
  /**
   * Override async user-texture loading. Defaults to a browser decode
   * (fetch → createImageBitmap → ImageSource). Tests inject a deterministic
   * loader since node has no `createImageBitmap`.
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

      const pc = new ParticleContainer({
        // Pixi's key for the scale-carrying attribute is `vertex` (quad corners
        // = texture size x scale x anchor), NOT `scale` — an unknown key is
        // silently accepted and ignored (typed as Record<string, boolean>).
        // With vertex left static it uploads once, freezing every not-yet-live
        // slot at the default scale 1: when the live count later grows past the
        // first-render count, that slot renders as a full-texture-size "giant
        // particle" at the newborn's position (and size-over-lifetime never
        // animates on the GPU). It must be dynamic like the others.
        //
        // `uvs` is dynamic ONLY for flipbook layers: sync() rewrites each live
        // particle's texture to the current frame, and the uvs buffer must
        // re-upload to follow. Note the key is `uvs` (plural) — `uv` would
        // type-check (Record<string, boolean>) and silently do nothing, the
        // same trap as the vertex/scale bug above. Non-flipbook layers keep uvs
        // static so their upload cost — and every committed golden — is
        // unchanged. (P4.1)
        dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: fb !== null },
        texture: tex,
      });
      pc.blendMode = blendOf(layer.blend);

      // Preallocate the full pool of Particle objects (one-time; no per-frame
      // allocation churn) but do NOT add them to the container. sync() keeps
      // pc.particleChildren equal to exactly the live prefix particles[0..count),
      // so the per-frame vertex upload and draw scale with the LIVE count, not
      // maxParticles capacity — a 40k-cap layer showing 100 particles uploads
      // 100, not 40 000 (P4.2). The pool array below owns every Particle.
      const particles: Particle[] = [];
      for (let k = 0; k < max; k++) {
        const p = new Particle({ texture: particleTex });
        p.anchorX = 0.5;
        p.anchorY = 0.5;
        particles.push(p);
      }

      // Trail ribbon (M9): build the mesh BEFORE adding the ParticleContainer so
      // it sits behind (renders under) this layer's sprites. Its geometry buffers
      // are the core TrailGeometry arrays; sync() fills them via
      // computeTrailGeometry. Blend mode is shared with the layer. Only trail
      // layers add an extra child, so a trail-null document's child order — and
      // every committed golden — is unchanged.
      let trail: TrailView | null = null;
      if (layer.trail !== null) {
        const geom = makeTrailGeometry(max, layer.trail.maxPoints);
        trail = makeTrailView(geom, tex, blendOf(layer.blend));
        this.container.addChild(trail.mesh);
      }

      this.container.addChild(pc);
      const view: LayerView = {
        pc,
        particles,
        buffers: makeRenderBuffers(max),
        invFrameWidth: sliced.invFrameWidth,
        flipbook: fb,
        frames: sliced.frames,
        renderHighWater: 0,
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

  /** Copy the current simulation frame onto the Pixi particles. Call after step(). */
  sync(): void {
    const layers = this.effect.layers;
    const ex = this.effect.emitterX;
    const ey = this.effect.emitterY;
    for (let i = 0; i < this.views.length; i++) {
      const ls = layers[i]!;
      const view = this.views[i]!;
      const enabled = ls.layer.enabled;
      const count = enabled ? ls.count : 0;

      // Per-layer container placement (schemaVersion 2). A local layer rides the
      // emitter (its particles carry effect-local coords); a world layer stays at
      // the container origin because its particles already carry parent-frame
      // coords, so a moving emitter leaves them behind — the trail. With a
      // never-moved emitter both resolve to (0,0), keeping v1 output identical.
      if (ls.layer.space === "world") view.pc.position.set(0, 0);
      else view.pc.position.set(ex, ey);
      // The trail mesh's vertices carry the same sim-frame coordinates as the
      // particles, so it rides the emitter exactly like the ParticleContainer (M9).
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
            part.scaleX = s;
            part.scaleY = s;
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
            // AFTER the stretch multiply — a genuine mirror, not a UV flip.
            const flip = b.flip[j]!;
            if (flip & 1) scaleX = -scaleX;
            if (flip & 2) scaleY = -scaleY;
            part.scaleX = scaleX;
            part.scaleY = scaleY;
            const r = Math.max(0, Math.min(255, Math.round(b.r[j]! * 255)));
            const g = Math.max(0, Math.min(255, Math.round(b.g[j]! * 255)));
            const bl = Math.max(0, Math.min(255, Math.round(b.b[j]! * 255)));
            part.tint = (r << 16) | (g << 8) | bl;
            part.alpha = Math.max(0, Math.min(1, b.a[j]!));
            if (frames) part.texture = frames[b.frame[j]!]!;
          }
        }
      }
      // Trail ribbon geometry (M9): rebuild from the layer's ring buffers and
      // update the mesh buffers + draw range. computeRenderState above filled
      // view.buffers (the trail's null-color path reads each particle's current
      // render RGBA from it); when the layer is disabled or empty there is no
      // render state, so clear the ribbon to zero draws.
      if (view.trail !== null) {
        if (enabled && count > 0) {
          computeTrailGeometry(ls, view.buffers, view.trail.geom);
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
   * Keep `pc.particleChildren` equal to exactly the live prefix
   * `particles[0..count)`. The core pool is swap-compacted, so those are the
   * live particles in stable render order; dead slots are never in the container
   * and thus never uploaded, drawn, or rasterized (P4.2).
   *
   * The draw count (`length*6` indices) and the per-frame dynamic upload both
   * read `particleChildren.length` directly, so shrinking needs no bookkeeping.
   * Only the *static* attribute buffer needs an explicit `update()` — and only
   * when the list reaches a length never populated before, since a particle's
   * static data (UVs) is constant once written. This keeps a layer whose live
   * count jitters at its capacity peak from re-uploading the whole static buffer
   * every frame.
   */
  private syncRenderList(view: LayerView, count: number): void {
    const children = view.pc.particleChildren;
    if (children.length !== count) {
      if (count < children.length) {
        children.length = count; // shrink: drop the just-died tail (no realloc, no static re-upload)
      } else {
        for (let j = children.length; j < count; j++) children.push(view.particles[j]!); // grow back
      }
    }
    if (count > view.renderHighWater) {
      view.pc.update(); // first time these slots render — upload their static attributes
      view.renderHighWater = count;
    }
  }

  destroy(): void {
    // Destroy the display objects only — NOT the textures. Built-ins are shared
    // at module scope and user textures are cached by data URL; the
    // ParticleContainer default shader holds a listener on the last-bound
    // texture source, so destroying any source here nulls that shared bind
    // group and breaks all later particle rendering. The `destroyed` flag stops
    // an in-flight user-texture load from touching a torn-down view. (P0.1/P0.2)
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
    // slices share tex.source, so the container binds one source either way. (P4.1)
    const sliced = framesFor(tex, view.flipbook);
    view.frames = sliced.frames;
    view.invFrameWidth = sliced.invFrameWidth;
    view.pc.texture = tex;
    const particleTex = sliced.frames ? sliced.frames[0]! : tex;
    for (const p of view.particles) p.texture = particleTex;
    view.pc.update();
  }
}
