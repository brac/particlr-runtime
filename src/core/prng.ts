// The runtime's ONLY source of randomness (CLAUDE.md L10). mulberry32 is a fast,
// well-distributed 32-bit seeded PRNG. Math.random / Date.now are forbidden in
// this package: same seed + same dt sequence must produce identical frames.

export type Rng = () => number;

/** Standard mulberry32. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-layer seed derivation (plan §2.7). Each layer of an effect instance owns
 * an independent stream so adding/removing a layer doesn't perturb the others.
 */
export function deriveLayerSeed(effectSeed: number, layerIndex: number): number {
  return (effectSeed + layerIndex * 0x9e3779b9) >>> 0;
}
