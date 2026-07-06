// Pixi v8 adapter. Consumes core simulation state and renders it through one
// ParticleContainer per layer. All per-particle render values (size, color,
// flipbook frame) come from core.computeRenderState, so this adapter is dumb —
// it only maps numbers onto Pixi Particles. Same code path as the editor
// preview (L4).
import {
  BufferImageSource,
  Container,
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

function blendOf(b: BlendMode): BLEND_MODES {
  // Our enum values are exactly Pixi's blend-mode strings.
  return b;
}

interface LayerView {
  pc: ParticleContainer;
  particles: Particle[];
  buffers: LayerRenderBuffers;
  invTexWidth: number;
}

export interface PixiSparkRendererOptions {
  /** Reserved for future use (e.g. building GPU RenderTextures). */
  renderer?: unknown;
}

export class PixiSparkRenderer {
  readonly container: Container;
  /** Non-fatal issues surfaced for the editor (e.g. E10 texture fallback). */
  readonly warnings: string[] = [];

  private readonly effect: Effect;
  private readonly views: LayerView[] = [];
  private readonly ownedTextures: Texture[] = [];
  private readonly builtinCache = new Map<string, Texture>();

  constructor(effect: Effect, _opts?: PixiSparkRendererOptions) {
    this.effect = effect;
    this.container = new Container();

    for (const ls of effect.layers) {
      const layer = ls.layer;
      const tex = this.resolveTexture(layer.texture.ref, effect.doc);
      const max = layer.emission.maxParticles;

      const pc = new ParticleContainer({
        dynamicProperties: { position: true, rotation: true, scale: true, color: true },
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
      this.views.push({ pc, particles, buffers: makeRenderBuffers(max), invTexWidth: 1 / tex.width });
    }
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
      // Hide the rest of the preallocated particles.
      for (let j = count; j < view.particles.length; j++) {
        view.particles[j]!.alpha = 0;
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    for (const t of this.ownedTextures) t.destroy(true);
    this.ownedTextures.length = 0;
    this.builtinCache.clear();
  }

  // --- textures ------------------------------------------------------------

  private builtin(id: BuiltinTextureId): Texture {
    let t = this.builtinCache.get(id);
    if (!t) {
      t = textureFromData(generateBuiltinTexture(id));
      this.builtinCache.set(id, t);
      this.ownedTextures.push(t);
    }
    return t;
  }

  private resolveTexture(ref: string, doc: SparkDoc): Texture {
    if ((BUILTIN_TEXTURE_IDS as readonly string[]).includes(ref)) {
      return this.builtin(ref as BuiltinTextureId);
    }
    if (ref.startsWith("user:")) {
      const name = ref.slice(5);
      const dataUrl = doc.textures?.[name];
      if (dataUrl) {
        // Loads asynchronously; renders once decoded. (Golden presets use
        // built-ins only, so this path is not part of the parity test.)
        const t = Texture.from(dataUrl);
        this.ownedTextures.push(t);
        return t;
      }
      // E10: missing embedded texture -> substitute the soft circle + warn.
      this.warnings.push(`Texture "${ref}" is missing; using the built-in soft circle.`);
    } else {
      this.warnings.push(`Unknown texture "${ref}"; using the built-in soft circle.`);
    }
    return this.builtin("circle-soft");
  }
}
