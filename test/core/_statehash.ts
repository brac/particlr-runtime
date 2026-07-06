import type { Effect } from "../../src/index.js";

// FNV-1a over the raw bytes of every live particle's state across all layers,
// plus the effect clock and per-layer counts. Bit-exact: any change in the
// simulation changes the digest. Used for determinism + snapshot regression.
function fnv1a(bytes: Uint8Array, h: number): number {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

const POOL_FIELDS = [
  "x", "y", "velX", "velY", "age", "lifetime", "sizeInit", "rotation", "angVel",
  "rand0", "rand1", "rand2", "rand3", "frameRand",
] as const;

export function stateHash(fx: Effect): string {
  let h = 0x811c9dc5;
  // fold the clock (as float64 bytes)
  h = fnv1a(new Uint8Array(new Float64Array([fx.time]).buffer), h);
  for (const ls of fx.layers) {
    const count = ls.count;
    h = fnv1a(new Uint8Array(new Int32Array([count]).buffer), h);
    for (const f of POOL_FIELDS) {
      const arr = ls.pool[f];
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, count * 4);
      h = fnv1a(bytes, h);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Pseudo-random dt sequence in [1/240, 1/30], from a fixed seed (all < MAX_DT). */
export function dtSequence(seed: number, n: number): number[] {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const lo = 1 / 240;
  const hi = 1 / 30;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + next() * (hi - lo));
  return out;
}
