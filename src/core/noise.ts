// 2D hash-lattice value noise + pseudo-curl field (schemaVersion 3, TIER1_PLAN
// §0.3). Stateless, zero allocation, identical in Node and browser: no
// permutation table, no Math.random, no wall clock. The layer noise module
// samples curl2() to perturb particle positions.

/** A mutable 2-vector used as a zero-allocation output for curl2. */
export interface Vec2 {
  x: number;
  y: number;
}

// EPS for the central-difference curl, in lattice units (§0.3).
const EPS = 0.35;
// Module-scope scratch so curl2 allocates nothing when no output is supplied.
const CURL_SCRATCH: Vec2 = { x: 0, y: 0 };

/**
 * mulberry32-style integer mix of a lattice cell (ix, iy) and a seed → [0,1).
 * Spatial (not sequential): the same cell always hashes to the same value, so
 * the field is reproducible without any stored state. `ix`/`iy` are coerced to
 * 32-bit integers; `seed` is used as-is (callers pass an unsigned 32-bit seed).
 */
export function hash2(ix: number, iy: number, seed: number): number {
  // Fold the two coordinates and the seed into one 32-bit word with distinct
  // odd multipliers (golden-ratio / mulberry constants) so nearby cells scatter.
  let h = (Math.imul(ix | 0, 0x9e3779b9) ^ Math.imul(iy | 0, 0x85ebca6b) ^ (seed | 0)) >>> 0;
  // mulberry32 finalizer on the mixed word.
  h = (h + 0x6d2b79f5) | 0;
  let t = Math.imul(h ^ (h >>> 15), 1 | h);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Quintic smoothstep (Perlin's improved fade): C2-continuous, so derivatives
 * of the interpolated field are smooth — the curl below is well-behaved. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 2D value noise: bilinear interpolation of hash2 at the four surrounding
 * lattice corners, with quintic smoothstep on each axis. Result is in [0,1)
 * (a convex combination of four [0,1) corner values).
 */
export function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  const u = fade(fx);
  const v = fade(fy);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

/**
 * Pseudo-curl of the scalar value-noise potential (§0.3), summed over `octaves`
 * (1..3; freq ×2, amp ×0.5 each). The curl of a scalar potential φ is
 * (∂φ/∂y, −∂φ/∂x), which is analytically divergence-free, so particles swirl
 * along the field instead of piling into sources/sinks. Central differences use
 * EPS = 0.35 lattice units:
 *   curlX = (φ(x, y+ε) − φ(x, y−ε)) / (2ε)
 *   curlY = −(φ(x+ε, y) − φ(x−ε, y)) / (2ε)
 * Writes into `out` (or a module-scope scratch) and returns it — zero allocation.
 */
export function curl2(x: number, y: number, seed: number, octaves: number, out: Vec2 = CURL_SCRATCH): Vec2 {
  let cx = 0;
  let cy = 0;
  let freq = 1;
  let amp = 1;
  const inv2eps = 1 / (2 * EPS);
  for (let o = 0; o < octaves; o++) {
    const sx = x * freq;
    const sy = y * freq;
    // ∂φ/∂y and ∂φ/∂x via central differences (lattice-unit epsilon).
    const dNdy = (valueNoise2(sx, sy + EPS, seed) - valueNoise2(sx, sy - EPS, seed)) * inv2eps;
    const dNdx = (valueNoise2(sx + EPS, sy, seed) - valueNoise2(sx - EPS, sy, seed)) * inv2eps;
    cx += amp * dNdy;
    cy += amp * -dNdx;
    freq *= 2;
    amp *= 0.5;
  }
  out.x = cx;
  out.y = cy;
  return out;
}
