// Per-frame evaluation of render state (size, color, flipbook frame) into
// caller-provided buffers. Lives in core so every renderer is dumb and
// identical — preview/runtime parity by construction (L4).
import type { Flipbook } from "../format/types.js";
import type { LayerSim } from "./layerSim.js";
import { evalScalarTrack, evalGradient, hueRotateRGB, type RGBA } from "./tracks.js";

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

/** Flipbook frame index at a given particle age (plan §2.11; A7 upgrades
 * schemaVersion 5 §0.3d / E30). Deterministic and render-only: no PRNG draw
 * (`frameRand` is the already-drawn draw-13 uniform; `frameOverLife` reuses no
 * uniform) and no statehash contribution. Precedence (locked, E30):
 *   1. `frameOverLife !== null` — deterministic position over life, OVERRIDES
 *      the mode entirely (track value is a normalized 0..1 position across the
 *      sheet).
 *   2. `mode === "random"` — stable per-particle random frame; `randomStartFrame`
 *      is ignored (already per-particle random).
 *   3. `loop`/`once` + `randomStartFrame` — a per-particle start offset from
 *      `frameRand`. With `randomStartFrame === false` the base is exactly
 *      ⌊age·fps⌋ — bitwise-identical to the pre-A7 function (the whole plan's
 *      null-pin invariant). */
export function flipbookFrame(fb: Flipbook | null, age: number, ageNorm: number, frameRand: number): number {
  if (!fb) return 0;
  const total = fb.cols * fb.rows;
  if (total <= 1) return 0;
  // (1) frameOverLife: clamp(⌊v·total⌋, 0, total−1) where v is the track value
  // at ageNorm (evaluated with a literal 0 uniform — deterministic, zero draws).
  if (fb.frameOverLife !== null) {
    const frame = Math.floor(evalScalarTrack(fb.frameOverLife, ageNorm, 0) * total);
    return Math.min(total - 1, Math.max(0, frame));
  }
  // (2) random: unchanged stable frame from the draw-13 uniform.
  if (fb.mode === "random") return Math.min(total - 1, Math.floor(frameRand * total));
  // (3) loop/once. The `false` branch is the exact pre-A7 expression (no float
  // re-ordering); the `true` branch adds a per-particle ⌊frameRand·total⌋ offset.
  const base = fb.randomStartFrame ? Math.floor(age * fb.fps) + Math.floor(frameRand * total) : Math.floor(age * fb.fps);
  if (fb.mode === "once") return Math.min(base, total - 1);
  return ((base % total) + total) % total; // loop
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
  // Hue-jitter (schemaVersion 5, §0.3c / E29): a distinct startColor mode whose
  // per-particle uniform is a HUE OFFSET (degrees, stored in tintR) rather than a
  // tint multiplier. Hoisted out of the loop so the gradients/palette multiply
  // path below stays byte-identical to HEAD (branch on the mode once, not per
  // particle).
  const hueJitter = startColor !== null && startColor.mode === "hueJitter";

  // By-speed remaps (schemaVersion 3, §M6): when the layer has a bySpeed module,
  // the particle's instantaneous speed √(velX²+velY²) — the SAME definition the
  // render module uses — is normalized over [range.min, range.max] and used to
  // look up a size multiplier and/or a per-channel color multiplier. Zero PRNG
  // draws, zero pool writes (bySpeed is a zero-draw module, §0.2). All config is
  // hoisted; a bySpeed-null layer never enters the branch inside the loop, so its
  // per-particle writes stay byte-identical to pre-M6 (goldens untouched).
  const bySpeed = ls.layer.bySpeed;
  const bsSize = bySpeed !== null ? bySpeed.size : null;
  const bsColor = bySpeed !== null ? bySpeed.color : null;
  const bsMin = bySpeed !== null ? bySpeed.range.min : 0;
  const bsMax = bySpeed !== null ? bySpeed.range.max : 0;
  // Window width; when 0 (degenerate range.min === range.max, which the validator
  // allows) the remap is a hard step at the shared bound (tSpeed 1 at/above, 0
  // below) rather than a divide-by-zero (FORMAT_SPEC "By-speed remaps").
  const bsSpan = bsMax - bsMin;
  const velX = p.velX;
  const velY = p.velY;
  // Scratch for the by-speed color gradient (avoids a per-particle allocation).
  const bsRGBA: RGBA = { r: 0, g: 0, b: 0, a: 0 };

  for (let i = 0; i < p.count; i++) {
    const lifetime = p.lifetime[i]!;
    const age = p.age[i]!;
    const t = lifetime > 0 ? Math.min(1, age / lifetime) : 1;

    const sizeMul = sizeTrack ? evalScalarTrack(sizeTrack, t, p.rand0[i]!) : 1;
    buf.size[i] = p.sizeInit[i]! * sizeMul;

    evalGradient(ol.color, t, rgba);
    if (hueJitter) {
      // Rotate the evaluated gradient RGB by the per-particle offset (tintR);
      // alpha is unchanged (rgba.a stays THE gradient's alpha). An offset of 0
      // (the u=0.5 spawn) is a bitwise no-op, so a no-jitter particle renders
      // byte-identically to the no-startColor path.
      const off = tintR![i]!;
      if (off !== 0) hueRotateRGB(rgba.r, rgba.g, rgba.b, off, rgba);
      buf.r[i] = rgba.r;
      buf.g[i] = rgba.g;
      buf.b[i] = rgba.b;
      buf.a[i] = rgba.a;
    } else if (startColor !== null) {
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

    // By-speed remap (§M6): multiply the render size and/or RGBA by a lookup at
    // the speed-normalized t. The color multiply applies AFTER the over-lifetime
    // gradient and the startColor tint (order: gradient × startColorTint ×
    // bySpeedColor); the whole block is skipped when the layer has no bySpeed
    // module, keeping the null path instruction-identical to the M5 loop above.
    if (bySpeed !== null) {
      const vx = velX[i]!;
      const vy = velY[i]!;
      const speed = Math.sqrt(vx * vx + vy * vy);
      const tSpeed = bsSpan > 0 ? Math.min(1, Math.max(0, (speed - bsMin) / bsSpan)) : speed >= bsMax ? 1 : 0;
      if (bsSize !== null) buf.size[i] = buf.size[i]! * evalScalarTrack(bsSize, tSpeed, 0);
      if (bsColor !== null) {
        evalGradient(bsColor, tSpeed, bsRGBA);
        buf.r[i] = buf.r[i]! * bsRGBA.r;
        buf.g[i] = buf.g[i]! * bsRGBA.g;
        buf.b[i] = buf.b[i]! * bsRGBA.b;
        buf.a[i] = buf.a[i]! * bsRGBA.a;
      }
    }

    buf.frame[i] = flipbookFrame(frames, age, t, p.frameRand[i]!);
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
