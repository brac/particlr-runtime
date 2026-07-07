// Per-frame evaluation of render state (size, color, flipbook frame) into
// caller-provided buffers. Lives in core so every renderer is dumb and
// identical — preview/runtime parity by construction (L4).
import type { Flipbook } from "../format/types.js";
import type { LayerSim } from "./layerSim.js";
import { evalScalarTrack, evalGradient, type RGBA } from "./tracks.js";

const RAD2DEG = 180 / Math.PI;
/** Below this speed, velocity direction is undefined, so align:"velocity" keeps
 * the particle's own rotation (FORMAT_SPEC "Rendering: velocity alignment"). */
const MIN_ALIGN_SPEED = 1e-3;

export interface LayerRenderBuffers {
  /** Render size in px (length >= pool.capacity). */
  size: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  /** Flipbook frame index (length >= pool.capacity). */
  frame: Uint16Array;
  /** Along-motion stretch factor (schemaVersion 3). Written only when the
   * layer's `render` module is non-null; left untouched (default 1) otherwise. */
  stretch: Float32Array;
  /** Sprite rotation in DEGREES (schemaVersion 3). Written when the layer's
   * `render` OR `randomFlip` module is non-null (both route the renderer
   * through its extended loop body): for align:"velocity" it is
   * atan2(velY, velX); otherwise the particle's own rotation. Left untouched
   * when neither module is set (the renderer uses pool.rotation directly). */
  velAngle: Float32Array;
  /** Per-particle random-flip bitmask (schemaVersion 3, §M5): bit 1 = flip X,
   * bit 2 = flip Y (negative sprite scale). Filled from pool.flipBits when the
   * layer's `randomFlip` module is non-null; left at 0 otherwise. Valid whenever
   * the renderer's extended loop body runs (render OR randomFlip non-null). */
  flip: Uint8Array;
}

export function makeRenderBuffers(capacity: number): LayerRenderBuffers {
  return {
    size: new Float32Array(capacity),
    r: new Float32Array(capacity),
    g: new Float32Array(capacity),
    b: new Float32Array(capacity),
    a: new Float32Array(capacity),
    frame: new Uint16Array(capacity),
    // Stretch defaults to 1 (identity) so an unwritten slot never squashes a
    // sprite even if some future path reads it before render fills it.
    stretch: new Float32Array(capacity).fill(1),
    velAngle: new Float32Array(capacity),
    // Flip defaults to 0 (no mirroring); only a non-null randomFlip module ever
    // writes it, so a randomFlip-null layer that still runs the extended body
    // (render non-null) reads a valid all-zeros flip.
    flip: new Uint8Array(capacity),
  };
}

/** Flipbook frame index at a given particle age (plan §2.11). */
export function flipbookFrame(fb: Flipbook | null, age: number, frameRand: number): number {
  if (!fb) return 0;
  const total = fb.cols * fb.rows;
  if (total <= 1) return 0;
  if (fb.mode === "random") return Math.min(total - 1, Math.floor(frameRand * total));
  const idx = Math.floor(age * fb.fps);
  if (fb.mode === "once") return Math.min(idx, total - 1);
  return ((idx % total) + total) % total; // loop
}

export function computeRenderState(ls: LayerSim, buf: LayerRenderBuffers): void {
  const p = ls.pool;
  const ol = ls.layer.overLifetime;
  const sizeTrack = ol.size;
  const frames = ls.layer.texture.frames;
  const render = ls.layer.render;
  const rgba: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  // Start-color tint (schemaVersion 3, §M5): a per-particle constant multiplier
  // over the over-lifetime gradient RGBA (L7 amendment — overLifetime.color stays
  // THE gradient). The multiply lives inside a `startColor !== null` branch, so a
  // null-startColor layer's per-particle writes stay instruction-identical to v2.
  const startColor = ls.layer.startColor;
  const tintR = p.tintR;
  const tintG = p.tintG;
  const tintB = p.tintB;
  const tintA = p.tintA;

  for (let i = 0; i < p.count; i++) {
    const lifetime = p.lifetime[i]!;
    const age = p.age[i]!;
    const t = lifetime > 0 ? Math.min(1, age / lifetime) : 1;

    const sizeMul = sizeTrack ? evalScalarTrack(sizeTrack, t, p.rand0[i]!) : 1;
    buf.size[i] = p.sizeInit[i]! * sizeMul;

    evalGradient(ol.color, t, rgba);
    if (startColor !== null) {
      buf.r[i] = rgba.r * tintR![i]!;
      buf.g[i] = rgba.g * tintG![i]!;
      buf.b[i] = rgba.b * tintB![i]!;
      buf.a[i] = rgba.a * tintA![i]!;
    } else {
      buf.r[i] = rgba.r;
      buf.g[i] = rgba.g;
      buf.b[i] = rgba.b;
      buf.a[i] = rgba.a;
    }

    buf.frame[i] = flipbookFrame(frames, age, p.frameRand[i]!);
  }

  // Velocity-aligned rendering + speed stretch (schemaVersion 3). Written in a
  // separate pass, entered ONLY when a module that routes the Pixi adapter
  // through its extended (buffer-consuming) loop body is non-null, so a plain
  // layer's loop above stays instruction-identical to v2 (the stretch/velAngle
  // buffers are never touched and the renderer reads pool.rotation directly).
  // randomFlip selects the extended body too, so a randomFlip-only layer must
  // still see valid velAngle values (fillRenderModule's render-null fallback).
  const randomFlip = ls.layer.randomFlip;
  if (render !== null || randomFlip !== null) fillRenderModule(p, render, buf);
  // Copy the per-particle flip bitmask into the render buffer when the module is
  // active (§M5). When randomFlip is null the buffer keeps its all-zeros default,
  // which the extended body (entered for a render-only layer) reads as "no flip".
  if (randomFlip !== null) {
    const fb = p.flipBits!;
    for (let i = 0; i < p.count; i++) buf.flip[i] = fb[i]!;
  }
}

/** Speed = √(velX²+velY²) from STORED velocity → per-particle stretch + sprite
 * angle. Zero PRNG draws, zero pool writes (FORMAT_SPEC: render is a zero-draw
 * module). Invoked when `layer.render !== null` OR `layer.randomFlip !== null`
 * (the modules whose presence routes the renderer through its extended loop
 * body). With `render === null` (randomFlip-only), velAngle falls back to the
 * particle's own rotation and stretch is NOT written: it keeps the 1 that
 * makeRenderBuffers pre-filled — this function's render-non-null branch is the
 * ONLY writer of `stretch`, so the pre-fill is never overwritten — making the
 * extended renderer body reproduce the plain body's output exactly. */
function fillRenderModule(
  p: LayerSim["pool"],
  render: LayerSim["layer"]["render"],
  buf: LayerRenderBuffers,
): void {
  if (render === null) {
    for (let i = 0; i < p.count; i++) buf.velAngle[i] = p.rotation[i]!;
    return;
  }
  const { align, speedScale, minStretch, maxStretch } = render;
  const alignVel = align === "velocity";
  for (let i = 0; i < p.count; i++) {
    const vx = p.velX[i]!;
    const vy = p.velY[i]!;
    const speed = Math.sqrt(vx * vx + vy * vy);
    // clamp(1 + speedScale·speed, minStretch, maxStretch); validator guarantees
    // minStretch <= maxStretch so the min/max order is well-defined.
    buf.stretch[i] = Math.min(maxStretch, Math.max(minStretch, 1 + speedScale * speed));
    // align:"velocity" faces motion (degrees); below MIN_ALIGN_SPEED, or when
    // align is "none", fall back to the particle's own rotation.
    buf.velAngle[i] = alignVel && speed >= MIN_ALIGN_SPEED ? Math.atan2(vy, vx) * RAD2DEG : p.rotation[i]!;
  }
}
