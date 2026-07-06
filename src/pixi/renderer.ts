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
  Texture,
  type BLEND_MODES,
} from "pixi.js";
import type { BlendMode, BuiltinTextureId, SparkDoc } from "../format/types.js";
import { BUILTIN_TEXTURE_IDS } from "../format/types.js";
import { computeRenderState, makeRenderBuffers, type LayerRenderBuffers } from "../core/render.js";
import type { Effect } from "../core/effect.js";
import { generateBuiltinTexture, type TextureData } from "./textures.js";

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

interface LayerView {
  pc: ParticleContainer;
  particles: Particle[];
  buffers: LayerRenderBuffers;
  invTexWidth: number;
  /** Live particle count at the previous sync — so we only re-zero the range
   * that just died instead of the whole capacity every frame (P4.2). */
  prevCount: number;
}

export interface PixiSparkRendererOptions {
  /** Reserved for future use (e.g. building GPU RenderTextures). */
  renderer?: unknown;
  /**
   * Override async user-texture loading. Defaults to a browser decode
   * (fetch → createImageBitmap → ImageSource). Tests inject a deterministic
   * loader since node has no `createImageBitmap`.
   */
  loadTexture?: (dataUrl: string) => Promise<Texture>;
}

export class PixiSparkRenderer {
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

  constructor(effect: Effect, opts?: PixiSparkRendererOptions) {
    this.effect = effect;
    this.container = new Container();
    this.loadTexture = opts?.loadTexture ?? decodeDataUrlTexture;

    const pending: Promise<void>[] = [];

    for (const ls of effect.layers) {
      const layer = ls.layer;
      const resolved = this.resolveTexture(layer.texture.ref, effect.doc);
      const tex = resolved.tex;
      const max = layer.emission.maxParticles;

      const pc = new ParticleContainer({
        // Pixi's key for the scale-carrying attribute is `vertex` (quad corners
        // = texture size x scale x anchor), NOT `scale` — an unknown key is
        // silently accepted and ignored (typed as Record<string, boolean>).
        // With vertex left static it uploads once, freezing every not-yet-live
        // slot at the default scale 1: when the live count later grows past the
        // first-render count, that slot renders as a full-texture-size "giant
        // particle" at the newborn's position (and size-over-lifetime never
        // animates on the GPU). It must be dynamic like the others.
        dynamicProperties: { position: true, rotation: true, vertex: true, color: true },
        texture: tex,
      });
      pc.blendMode = blendOf(layer.blend);

      const particles: Particle[] = [];
      for (let k = 0; k < max; k++) {
        const p = new Particle({ texture: tex });
        p.anchorX = 0.5;
        p.anchorY = 0.5;
        p.alpha = 0;
        particles.push(p);
        pc.addParticle(p);
      }
      pc.update();

      this.container.addChild(pc);
      const view: LayerView = { pc, particles, buffers: makeRenderBuffers(max), invTexWidth: 1 / tex.width, prevCount: 0 };
      this.views.push(view);

      // A user texture starts as a synchronous built-in placeholder; kick off
      // the async decode and swap it in when ready (also fixes invTexWidth,
      // which the placeholder width would otherwise leave wrong). (P0.1)
      if (resolved.pendingDataUrl !== undefined) {
        pending.push(this.loadUserTextureInto(view, resolved.pendingDataUrl, layer.texture.ref));
      }
    }

    this.ready = Promise.all(pending).then(() => undefined);
  }

  /** Copy the current simulation frame onto the Pixi particles. Call after step(). */
  sync(): void {
    const layers = this.effect.layers;
    for (let i = 0; i < this.views.length; i++) {
      const ls = layers[i]!;
      const view = this.views[i]!;
      const enabled = ls.layer.enabled;
      const count = enabled ? ls.count : 0;

      if (enabled && count > 0) {
        computeRenderState(ls, view.buffers);
        const p = ls.pool;
        const b = view.buffers;
        const inv = view.invTexWidth;
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
        }
      }
      // Only re-hide the particles that were live last frame but are dead now.
      // Everything at index >= max(count, prevCount) was already alpha 0 from an
      // earlier frame, so this is identical output at a fraction of the writes
      // (P4.2). Constructor pre-zeros all particles, seeding the invariant.
      for (let j = count; j < view.prevCount; j++) {
        view.particles[j]!.alpha = 0;
      }
      view.prevCount = count;
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
  private resolveTexture(ref: string, doc: SparkDoc): { tex: Texture; pendingDataUrl?: string } {
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
    view.pc.texture = tex;
    for (const p of view.particles) p.texture = tex;
    view.pc.update();
    view.invTexWidth = 1 / tex.width;
  }
}
