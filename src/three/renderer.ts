// Three.js adapter (V2_DESIGN Part 1). One instanced draw per layer: an
// InstancedBufferGeometry over a unit quad, per-instance attributes filled
// straight from core's LayerRenderBuffers each sync(). This adapter is dumb —
// identical role to src/pixi/renderer.ts, different rasterizer.
//
// Coordinate mapping (normative, plan header): sim is y-DOWN, CW-positive;
// three local space is y-UP. aInstPos.y = -sim.y and aAngle = -angle·DEG2RAD
// so authored effects read upright. Layer meshes are frustumCulled = false:
// instance counts change every frame and the quad's base bounding volume is
// meaningless.
import {
  Group,
  Mesh,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  BufferAttribute,
  DynamicDrawUsage,
  type Texture,
} from "three";
import type { Flipbook, ParticleDoc } from "../format/types.js";
import { BUILTIN_TEXTURE_IDS, type BuiltinTextureId } from "../format/types.js";
import { computeRenderState, makeRenderBuffers, type LayerRenderBuffers } from "../core/render.js";
import type { Effect } from "../core/effect.js";
import { makeSpriteMaterial } from "./materials.js";
import { builtinTexture, decodeDataUrlTexture, cachedUserTexture, cacheUserTexture } from "./textures.js";

const DEG2RAD = Math.PI / 180;

// Unit quad: two triangles, corners ±0.5, top-left-origin UV (v=0 at top —
// matches flipY=false upload). Shared by every geometry (attributes are
// read-only base data).
const QUAD_POS = new BufferAttribute(new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 0]), 3);
const QUAD_UV = new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2);
const QUAD_INDEX = new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);

interface LayerAttrs {
  instPos: InstancedBufferAttribute;
  size: InstancedBufferAttribute;
  color: InstancedBufferAttribute;
  frame: InstancedBufferAttribute;
  stretch: InstancedBufferAttribute;
  angle: InstancedBufferAttribute;
  flip: InstancedBufferAttribute;
}

interface LayerView {
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  material: ReturnType<typeof makeSpriteMaterial>;
  buffers: LayerRenderBuffers;
  attrs: LayerAttrs;
  /** This layer's flipbook config (or null), carried for the async user-texture swap. */
  frames: Flipbook | null;
}

export interface ThreeParticleRendererOptions {
  /** Default false: quads live in the group's local XY plane. */
  billboard?: boolean;
  /**
   * Override async user-texture loading. Defaults to a browser decode
   * (base64 decode → createImageBitmap → Texture). Tests inject a
   * deterministic loader since node has no `createImageBitmap`.
   */
  loadTexture?: (dataUrl: string) => Promise<Texture>;
}

function makeInstancedAttr(max: number, itemSize: number): InstancedBufferAttribute {
  return new InstancedBufferAttribute(new Float32Array(max * itemSize), itemSize).setUsage(DynamicDrawUsage);
}

export class ThreeParticleRenderer {
  /** The Object3D the host places in its scene. */
  readonly root: Group;
  /** Non-fatal issues surfaced for the editor (e.g. E10 texture fallback). */
  readonly warnings: string[] = [];
  /**
   * Resolves once every embedded user texture has decoded and been swapped in
   * (or failed and fallen back). Built-in-only docs resolve immediately.
   */
  readonly ready: Promise<void>;

  private readonly effect: Effect;
  private readonly views: LayerView[] = [];
  private readonly loadTexture: (dataUrl: string) => Promise<Texture>;
  private _billboard: boolean;
  private destroyed = false;

  constructor(effect: Effect, opts?: ThreeParticleRendererOptions) {
    this.effect = effect;
    this.root = new Group();
    this.loadTexture = opts?.loadTexture ?? decodeDataUrlTexture;
    this._billboard = opts?.billboard ?? false;

    const pending: Promise<void>[] = [];

    for (const ls of effect.layers) {
      const layer = ls.layer;
      const max = layer.emission.maxParticles;
      const resolved = this.resolveTexture(layer.texture.ref, effect.doc);
      const tex = resolved.tex;

      const geometry = new InstancedBufferGeometry();
      geometry.setAttribute("position", QUAD_POS);
      geometry.setAttribute("uv", QUAD_UV);
      geometry.setIndex(QUAD_INDEX);

      const attrs: LayerAttrs = {
        instPos: makeInstancedAttr(max, 2),
        size: makeInstancedAttr(max, 1),
        color: makeInstancedAttr(max, 4),
        frame: makeInstancedAttr(max, 1),
        stretch: makeInstancedAttr(max, 1),
        angle: makeInstancedAttr(max, 1),
        flip: makeInstancedAttr(max, 1),
      };
      geometry.setAttribute("aInstPos", attrs.instPos);
      geometry.setAttribute("aSize", attrs.size);
      geometry.setAttribute("aColor", attrs.color);
      geometry.setAttribute("aFrame", attrs.frame);
      geometry.setAttribute("aStretch", attrs.stretch);
      geometry.setAttribute("aAngle", attrs.angle);
      geometry.setAttribute("aFlip", attrs.flip);
      geometry.instanceCount = 0;

      const material = makeSpriteMaterial(tex, layer.blend);
      // Flipbook cols/rows/aspect: while a user sheet is still the built-in
      // placeholder (pendingDataUrl set), slicing it would be wrong — stay at
      // 1x1 whole-texture aspect until loadUserTextureInto swaps in the real
      // sheet and grid (Pixi parity, renderer.ts:199 leaves `frames` null the
      // same way).
      const fb = resolved.pendingDataUrl === undefined ? layer.texture.frames : null;
      this.applyFlipbookUniforms(material, tex, fb);
      material.uniforms.uBillboard!.value = this._billboard ? 1 : 0;

      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.userData.particlrLayer = this.views.length;
      this.root.add(mesh);

      const view: LayerView = { mesh, geometry, material, buffers: makeRenderBuffers(max), attrs, frames: layer.texture.frames };
      this.views.push(view);

      if (resolved.pendingDataUrl !== undefined) {
        pending.push(this.loadUserTextureInto(view, resolved.pendingDataUrl, layer.texture.ref));
      }
    }

    this.ready = Promise.all(pending).then(() => undefined);
  }

  get billboard(): boolean {
    return this._billboard;
  }
  set billboard(v: boolean) {
    this._billboard = v;
    for (const view of this.views) view.material.uniforms.uBillboard!.value = v ? 1 : 0;
  }

  /** Copy the current simulation frame onto the Three instance buffers. Call after step(). */
  sync(): void {
    const layers = this.effect.layers;
    const ex = this.effect.emitterX;
    const ey = this.effect.emitterY;
    for (let i = 0; i < this.views.length; i++) {
      const ls = layers[i]!;
      const view = this.views[i]!;
      const enabled = ls.layer.enabled;
      const count = enabled ? ls.count : 0;

      // Per-layer mesh placement (schemaVersion 2). A local layer rides the
      // emitter (its particles carry effect-local coords, negated y); a world
      // layer stays at the group origin because its particles already carry
      // parent-frame coords.
      if (ls.layer.space === "world") view.mesh.position.set(0, 0, 0);
      else view.mesh.position.set(ex, -ey, 0);

      if (enabled && count > 0) {
        computeRenderState(ls, view.buffers);
        const p = ls.pool;
        const b = view.buffers;
        const attrs = view.attrs;
        const instPos = attrs.instPos.array as Float32Array;
        const size = attrs.size.array as Float32Array;
        const color = attrs.color.array as Float32Array;
        const frame = attrs.frame.array as Float32Array;
        const stretch = attrs.stretch.array as Float32Array;
        const angle = attrs.angle.array as Float32Array;
        const flip = attrs.flip.array as Float32Array;

        // Two loop bodies like Pixi (renderer.ts:341): plain layers read
        // pool.rotation directly; layers with render/randomFlip modules read
        // velAngle/stretch/flip from the render buffers.
        const extended = ls.layer.render !== null || ls.layer.randomFlip !== null;
        for (let j = 0; j < count; j++) {
          instPos[j * 2] = p.x[j]!;
          instPos[j * 2 + 1] = -p.y[j]!;
          size[j] = b.size[j]!;
          color[j * 4] = b.r[j]!;
          color[j * 4 + 1] = b.g[j]!;
          color[j * 4 + 2] = b.b[j]!;
          color[j * 4 + 3] = b.a[j]!;
          frame[j] = b.frame[j]!;
          stretch[j] = extended ? b.stretch[j]! : 1;
          angle[j] = -(extended ? b.velAngle[j]! : p.rotation[j]!) * DEG2RAD;
          flip[j] = extended ? b.flip[j]! : 0;
        }

        this.uploadAttrs(attrs, count);
      }
      view.geometry.instanceCount = enabled ? count : 0;
    }
  }

  private uploadAttrs(attrs: LayerAttrs, count: number): void {
    for (const attr of [attrs.instPos, attrs.size, attrs.color, attrs.frame, attrs.stretch, attrs.angle, attrs.flip]) {
      const range = count * attr.itemSize;
      if (typeof attr.addUpdateRange === "function") attr.addUpdateRange(0, range);
      attr.needsUpdate = true;
    }
  }

  destroy(): void {
    // Destroy the display objects' geometries/materials only — NEVER
    // textures. Built-ins are shared at module scope and user textures are
    // cached by data URL (Task 5 cache policy). The `destroyed` flag stops an
    // in-flight user-texture load from touching a torn-down view (Pixi
    // renderer.ts P0.1 precedent).
    this.destroyed = true;
    for (const view of this.views) {
      view.geometry.dispose();
      view.material.dispose();
      this.root.remove(view.mesh);
    }
  }

  // --- textures ------------------------------------------------------------

  /**
   * Resolve a texture ref to a Texture available *now*. Built-ins and
   * already-decoded user textures resolve synchronously; a not-yet-decoded
   * user texture returns a built-in placeholder plus the data URL to load.
   */
  private resolveTexture(ref: string, doc: ParticleDoc): { tex: Texture; pendingDataUrl?: string } {
    if ((BUILTIN_TEXTURE_IDS as readonly string[]).includes(ref)) {
      return { tex: builtinTexture(ref as BuiltinTextureId) };
    }
    if (ref.startsWith("user:")) {
      const name = ref.slice(5);
      const dataUrl = doc.textures?.[name];
      if (dataUrl) {
        // Another instance may already have decoded this exact data URL
        // (same doc reused, or a rebuilt preview) — resolve synchronously
        // from cache instead of always flashing the placeholder (Pixi parity,
        // renderer.ts:476-478).
        const cached = cachedUserTexture(dataUrl);
        if (cached) return { tex: cached };
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
    // Cache under the adapter-level map even when `loadTexture` is an
    // injected/overridden loader, so a second renderer over the same data URL
    // resolves synchronously (default `decodeDataUrlTexture` already does
    // this internally; this covers every other loader too).
    cacheUserTexture(dataUrl, tex);
    if (this.destroyed) return;
    view.material.uniforms.uTexture!.value = tex;
    this.applyFlipbookUniforms(view.material, tex, view.frames);
  }

  /**
   * Sizing rule (Pixi P4.1 parity): uAspect = frameH / frameW where frame =
   * sheet dims / grid, so a particle renders `size` px wide and `size *
   * uAspect` px tall. `fb === null` (no flipbook, or a still-placeholder user
   * sheet) means a 1x1 grid — the whole texture is the frame.
   */
  private applyFlipbookUniforms(material: LayerView["material"], tex: Texture, fb: Flipbook | null): void {
    const cols = fb ? fb.cols : 1;
    const rows = fb ? fb.rows : 1;
    // `Texture.image` is typed `unknown` (three's generic default) even
    // though every image this adapter produces — DataTexture pixels, decoded
    // bitmaps — carries width/height.
    const image = tex.image as { width: number; height: number };
    const frameW = image.width / cols;
    const frameH = image.height / rows;
    material.uniforms.uCols!.value = cols;
    material.uniforms.uRows!.value = rows;
    material.uniforms.uAspect!.value = frameH / frameW;
  }
}
