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
import { computeTrailGeometry, computeConnectGeometry, makeTrailGeometry } from "../core/trailGeometry.js";
import type { Effect } from "../core/effect.js";
import { makeSpriteMaterial } from "./materials.js";
import { makeDissolveMaterial } from "./dissolveMaterial.js";
import { makeTrailView, setTrailTexture, syncTrailView, type ThreeTrailView } from "./trailMesh.js";
import { builtinTexture, decodeDataUrlTexture, cachedUserTexture, cacheUserTexture } from "./textures.js";

const DEG2RAD = Math.PI / 180;

// Unit quad: two triangles, corners ±0.5, top-left-origin UV (v=0 at top —
// matches flipY=false upload). Shared by every geometry (attributes are
// read-only base data). Sharing means `destroy()`'s `geometry.dispose()`
// releases these attributes' underlying GL buffers too — but since the data
// is static and identical for every layer, three's renderer just re-uploads
// it lazily on the next frame that touches a live geometry using them, so
// disposing one layer's geometry never corrupts another's draw.
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
  /** The same seven attributes as a list, built once at construction so
   * uploadAttrs (called every sync()) doesn't allocate a fresh array literal
   * every frame. */
  list: InstancedBufferAttribute[];
}

interface LayerView {
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  material: ReturnType<typeof makeSpriteMaterial>;
  buffers: LayerRenderBuffers;
  attrs: LayerAttrs;
  /** This layer's flipbook config (or null), carried for the async user-texture swap. */
  frames: Flipbook | null;
  /** Per-particle or connect-mode trail ribbon (Task 8); null unless the layer
   * has a trail module. Its Mesh is added to `root` BEFORE this layer's sprite
   * mesh, so the ribbon renders under the sprites (Pixi renderer.ts:258 parity). */
  trail: ThreeTrailView | null;
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
        list: [],
      };
      attrs.list = [attrs.instPos, attrs.size, attrs.color, attrs.frame, attrs.stretch, attrs.angle, attrs.flip];
      geometry.setAttribute("aInstPos", attrs.instPos);
      geometry.setAttribute("aSize", attrs.size);
      geometry.setAttribute("aColor", attrs.color);
      geometry.setAttribute("aFrame", attrs.frame);
      geometry.setAttribute("aStretch", attrs.stretch);
      geometry.setAttribute("aAngle", attrs.angle);
      geometry.setAttribute("aFlip", attrs.flip);
      geometry.instanceCount = 0;

      // Dissolve (Task 9): a layer with a non-null dissolve module gets the
      // erosion material instead of the plain sprite material. Every other
      // wiring path (flipbook uniforms, blend, billboard, texture swap) is
      // identical — sync() below additionally drives uTime for these layers.
      const material =
        layer.dissolve !== null ? makeDissolveMaterial(tex, layer.blend, layer.dissolve) : makeSpriteMaterial(tex, layer.blend);
      // Flipbook cols/rows/aspect: while a user sheet is still the built-in
      // placeholder (pendingDataUrl set), slicing it would be wrong — stay at
      // 1x1 whole-texture aspect until loadUserTextureInto swaps in the real
      // sheet and grid (Pixi parity, renderer.ts:199 leaves `frames` null the
      // same way).
      const fb = resolved.pendingDataUrl === undefined ? layer.texture.frames : null;
      this.applyFlipbookUniforms(material, tex, fb);
      material.uniforms.uBillboard!.value = this._billboard ? 1 : 0;

      const layerIndex = this.views.length;

      // Trail ribbon (Task 8): construct the mesh BEFORE the sprite mesh. Both
      // are transparent (applyBlend sets material.transparent = true), so
      // three's WebGLRenderer paints them via its transparent-object sort
      // (renderOrder, then camera depth, then Object3D.id as the tiebreak for
      // coplanar quads at equal depth) — NOT scene-graph child order. Building
      // the trail mesh first gives it the lower Object3D.id, so it paints
      // under this layer's sprites at equal depth; a future refactor must not
      // assume `root.add` order alone controls paint order. Its geometry
      // buffers ARE the core TrailGeometry arrays; sync() fills them via
      // computeTrailGeometry/computeConnectGeometry. Blend mode is shared with
      // the layer. Only trail layers add an extra child, so a trail-null
      // document's child order is unchanged (Pixi renderer.ts:258-273 parity).
      let trail: ThreeTrailView | null = null;
      if (layer.trail !== null) {
        // Connect mode: ONE ribbon of up to `max` points — makeTrailGeometry(1, max).
        // Per-particle: `max` ribbons of `maxPoints`.
        const trailGeom =
          layer.trail.mode === "connect" ? makeTrailGeometry(1, max) : makeTrailGeometry(max, layer.trail.maxPoints);
        trail = makeTrailView(trailGeom, tex, layer.blend);
        trail.mesh.userData.particlrLayer = layerIndex;
        this.root.add(trail.mesh);
      }

      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.userData.particlrLayer = layerIndex;
      this.root.add(mesh);

      const view: LayerView = { mesh, geometry, material, buffers: makeRenderBuffers(max), attrs, frames: layer.texture.frames, trail };
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

      // Dissolve (Task 9): advance the erosion clock. uTime = effect.time, so
      // the scroll is a pure function of the deterministic clock (exact under
      // scrub and golden replay) — Pixi parity, renderer.ts:316. Done every
      // frame regardless of count: the field scrolls even while the layer is
      // momentarily empty.
      if (ls.layer.dissolve !== null) {
        view.material.uniforms.uTime!.value = this.effect.time;
      }

      // Per-layer mesh placement (schemaVersion 2). A local layer rides the
      // emitter (its particles carry effect-local coords, negated y); a world
      // layer stays at the group origin because its particles already carry
      // parent-frame coords.
      if (ls.layer.space === "world") view.mesh.position.set(0, 0, 0);
      else view.mesh.position.set(ex, -ey, 0);
      // The trail mesh's vertices carry the same sim-frame coordinates as the
      // particles, so it rides the emitter exactly like the sprite mesh.
      if (view.trail !== null) {
        if (ls.layer.space === "world") view.trail.mesh.position.set(0, 0, 0);
        else view.trail.mesh.position.set(ex, -ey, 0);
      }

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
      // Trail ribbon geometry (Task 8): rebuild from the layer's ring buffers
      // and update the mesh buffers + draw range. computeRenderState above
      // filled view.buffers (the trail's null-color path reads each particle's
      // current render RGBA from it); when the layer is disabled or empty
      // there is no render state, so clear the ribbon to zero draws.
      if (view.trail !== null) {
        if (enabled && count > 0) {
          // Connect mode builds ONE ribbon through the live particles' current
          // positions; per-particle mode rebuilds each particle's own ring ribbon.
          if (ls.layer.trail!.mode === "connect") computeConnectGeometry(ls, view.buffers, view.trail.geom);
          else computeTrailGeometry(ls, view.buffers, view.trail.geom);
        } else {
          view.trail.geom.vertexCount = 0;
          view.trail.geom.indexCount = 0;
        }
        syncTrailView(view.trail);
      }
      view.geometry.instanceCount = enabled ? count : 0;
    }
  }

  private uploadAttrs(attrs: LayerAttrs, count: number): void {
    for (const attr of attrs.list) {
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
      if (view.trail !== null) {
        view.trail.mesh.geometry.dispose();
        view.trail.mesh.material.dispose();
        this.root.remove(view.trail.mesh);
      }
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
    // The trail mesh bound the placeholder's texture at construction; rebind
    // it to the decoded texture so the ribbon samples the real sheet, not the
    // soft circle. No-op-safe: layers without a trail skip this (Pixi
    // renderer.ts applyTexture parity).
    if (view.trail !== null) setTrailTexture(view.trail, tex);
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
