// Procedural built-in textures (plan §2.11), generated as pure-math RGBA pixel
// buffers — NO canvas2d. This matters for the parity invariant: raw pixel math
// is bit-identical across browsers and GPUs, so the golden-frame test can run at
// pixel tolerance 0. RGB is white; only alpha varies, so tint colors freely.
import type { BuiltinTextureId } from "../format/types.js";

export interface TextureData {
  width: number;
  height: number;
  /** RGBA, straight (non-premultiplied) alpha, row-major. */
  pixels: Uint8Array;
}

function build(width: number, height: number, alphaAt: (x: number, y: number) => number): TextureData {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = Math.max(0, Math.min(1, alphaAt(x + 0.5, y + 0.5)));
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return { width, height, pixels };
}

const sq = (v: number) => v * v;

function circleSoft(): TextureData {
  const cx = 32;
  const cy = 32;
  return build(64, 64, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r >= 32 ? 0 : sq(1 - r / 32);
  });
}

function circleHard(): TextureData {
  const cx = 32;
  const cy = 32;
  return build(64, 64, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    if (r <= 28) return 1;
    if (r >= 30) return 0;
    return (30 - r) / 2;
  });
}

function square(): TextureData {
  // 48x48 centred in 64x64 (margin 8).
  return build(64, 64, (x, y) => (x >= 8 && x < 56 && y >= 8 && y < 56 ? 1 : 0));
}

function spark(): TextureData {
  // 64x16 streak, quadratic falloff from centre on both axes.
  const cx = 32;
  const cy = 8;
  return build(64, 16, (x, y) => {
    const ax = Math.max(0, 1 - Math.abs(x - cx) / 32);
    const ay = Math.max(0, 1 - Math.abs(y - cy) / 8);
    return sq(ax) * sq(ay);
  });
}

function smoke(): TextureData {
  // Sum of 5 fixed radial blobs (no PRNG — identical across runs).
  const blobs: [number, number, number, number][] = [
    // cx, cy, radius, weight
    [32, 32, 22, 0.55],
    [24, 26, 14, 0.4],
    [42, 30, 15, 0.4],
    [30, 42, 13, 0.35],
    [40, 40, 12, 0.3],
  ];
  return build(64, 64, (x, y) => {
    let a = 0;
    for (const [bx, by, br, bw] of blobs) {
      const r = Math.hypot(x - bx, y - by);
      if (r < br) a += bw * sq(1 - r / br);
    }
    return a;
  });
}

const GENERATORS: Record<BuiltinTextureId, () => TextureData> = {
  "circle-soft": circleSoft,
  "circle-hard": circleHard,
  square,
  spark,
  smoke,
};

export function generateBuiltinTexture(id: BuiltinTextureId): TextureData {
  return GENERATORS[id]();
}

// --- Dissolve noise tile (schemaVersion 4, M3) -----------------------------
// A 128×128 periodic value-noise tile the dissolve shader samples with REPEAT
// addressing (FORMAT_SPEC "Dissolve / alpha erosion" 0.3c). Pure pixel math,
// bit-identical across browsers/GPUs (same discipline as the built-ins) — the
// tile is NOT in BUILTIN_TEXTURE_IDS: it is an internal renderer asset, never
// document-referenceable. It is periodic in BOTH axes (period = 1 tile) so it
// tiles seamlessly under GL repeat sampling: sampling at u and u+1 is
// bit-identical, so there is no seam at the wrap.
const DISSOLVE_NOISE_SIZE = 128;
const DISSOLVE_NOISE_SEED = 0x9e3779b9; // fixed internal seed constant

// Periodic hash of a lattice cell (ix, iy) wrapped to period `p`, mixed with a
// seed → [0,1). Adapted from core/noise.ts hash2 but kept LOCAL here with
// lattice-coordinate wrapping (`ix % p`), which is what makes the tile seamless
// — a cell at ix and ix+p hash identically. Coords are pre-wrapped to
// [0, p) by the caller's modulo, but the extra mod keeps it robust to +1 reads.
function dissolveHash(ix: number, iy: number, p: number, seed: number): number {
  const x = ((ix % p) + p) % p;
  const y = ((iy % p) + p) % p;
  let h = (Math.imul(x, 0x9e3779b9) ^ Math.imul(y, 0x85ebca6b) ^ (seed | 0)) >>> 0;
  h = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(h ^ (h >>> 15), 1 | h);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const dissolveFade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

// One octave of periodic value noise: bilinear interpolation of dissolveHash at
// the four surrounding cells (period `p`), quintic smoothstep per axis. `cx`/`cy`
// are cell coordinates in [0, p]; a full period is `p` cells.
function dissolveOctave(cx: number, cy: number, p: number, seed: number): number {
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const n00 = dissolveHash(x0, y0, p, seed);
  const n10 = dissolveHash(x0 + 1, y0, p, seed);
  const n01 = dissolveHash(x0, y0 + 1, p, seed);
  const n11 = dissolveHash(x0 + 1, y0 + 1, p, seed);
  const u = dissolveFade(fx);
  const v = dissolveFade(fy);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

/**
 * Value at tile coordinate (u, v) ∈ [0,1) tile units, periodic with period 1 in
 * both axes: `dissolveNoiseValue(u, v) === dissolveNoiseValue(u + 1, v)` exactly
 * (the two octaves' lattice periods, 8 and 16 cells, both divide the tile). Two
 * octaves (period 8 then 16 cells, amplitude 1 then 1/2), normalized to [0,1).
 * Exported for the tileability test; not part of the public runtime surface.
 */
export function dissolveNoiseValue(u: number, v: number): number {
  const o0 = dissolveOctave(u * 8, v * 8, 8, DISSOLVE_NOISE_SEED);
  const o1 = dissolveOctave(u * 16, v * 16, 16, DISSOLVE_NOISE_SEED ^ 0x1234567);
  return (o0 + o1 * 0.5) / 1.5;
}

/**
 * The 128×128 dissolve noise tile: value in RGB (grayscale), alpha 255. Sampled
 * as `.r` by the dissolve shader. Deterministic and seamless-tiling.
 */
export function generateDissolveNoise(): TextureData {
  const size = DISSOLVE_NOISE_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample at the pixel's left/top edge (x/size, not (x+0.5)/size) so column
      // 0 sits exactly on the tile boundary — column "size" would wrap to it.
      const n = dissolveNoiseValue(x / size, y / size);
      const g = Math.max(0, Math.min(255, Math.round(n * 255)));
      const i = (y * size + x) * 4;
      pixels[i] = g;
      pixels[i + 1] = g;
      pixels[i + 2] = g;
      pixels[i + 3] = 255;
    }
  }
  return { width: size, height: size, pixels };
}
