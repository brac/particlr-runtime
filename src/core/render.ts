// Per-frame evaluation of render state (size, color, flipbook frame) into
// caller-provided buffers. Lives in core so every renderer is dumb and
// identical — preview/runtime parity by construction (L4).
import type { Flipbook } from "../format/types.js";
import type { LayerSim } from "./layerSim.js";
import { evalScalarTrack, evalGradient, type RGBA } from "./tracks.js";

export interface LayerRenderBuffers {
  /** Render size in px (length >= pool.capacity). */
  size: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  /** Flipbook frame index (length >= pool.capacity). */
  frame: Uint16Array;
}

export function makeRenderBuffers(capacity: number): LayerRenderBuffers {
  return {
    size: new Float32Array(capacity),
    r: new Float32Array(capacity),
    g: new Float32Array(capacity),
    b: new Float32Array(capacity),
    a: new Float32Array(capacity),
    frame: new Uint16Array(capacity),
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
  const rgba: RGBA = { r: 0, g: 0, b: 0, a: 0 };

  for (let i = 0; i < p.count; i++) {
    const lifetime = p.lifetime[i]!;
    const age = p.age[i]!;
    const t = lifetime > 0 ? Math.min(1, age / lifetime) : 1;

    const sizeMul = sizeTrack ? evalScalarTrack(sizeTrack, t, p.rand0[i]!) : 1;
    buf.size[i] = p.sizeInit[i]! * sizeMul;

    evalGradient(ol.color, t, rgba);
    buf.r[i] = rgba.r;
    buf.g[i] = rgba.g;
    buf.b[i] = rgba.b;
    buf.a[i] = rgba.a;

    buf.frame[i] = flipbookFrame(frames, age, p.frameRand[i]!);
  }
}
