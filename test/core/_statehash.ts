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
    // Optional schemaVersion-3 columns are folded in ONLY when present, so a
    // preset with all modules null keeps its exact v2 digest (§0.2).
    // Fixed documented order: noisePhase (draw 14), the four velocity-over-
    // lifetime range uniforms velRandX/Y/Orbital/Radial (draws 15–18), then the
    // start-color tint columns tintR/G/B/A (draw 19), then the flip bitmask
    // (draws 20–21). Each is folded only when its column exists, so a preset with
    // all these modules null keeps its exact v2 digest (§0.2).
    for (const col of [
      ls.pool.noisePhase,
      ls.pool.velRandX,
      ls.pool.velRandY,
      ls.pool.velRandOrbital,
      ls.pool.velRandRadial,
      ls.pool.tintR,
      ls.pool.tintG,
      ls.pool.tintB,
      ls.pool.tintA,
    ]) {
      if (col !== null) {
        const bytes = new Uint8Array(col.buffer, col.byteOffset, count * 4);
        h = fnv1a(bytes, h);
      }
    }
    // flipBits is a Uint8Array (one byte per particle), folded after the Float32s.
    if (ls.pool.flipBits !== null) {
      const fb = ls.pool.flipBits;
      h = fnv1a(new Uint8Array(fb.buffer, fb.byteOffset, count), h);
    }
    // ordinal is a Uint32Array (M8 sub-emitter parents), folded LAST and only when
    // present (count*4 bytes), so a preset with no sub-emitters keeps its exact
    // pre-M8 digest.
    if (ls.pool.ordinal !== null) {
      const od = ls.pool.ordinal;
      h = fnv1a(new Uint8Array(od.buffer, od.byteOffset, count * 4), h);
    }
    // Trail ring buffer (M9): derived state (a history of rendered positions), but
    // folding it strengthens the determinism pin. head/len are Uint16 (2 bytes ea.)
    // and pts is Float32 (maxPoints·2 floats per particle). Folded only when the
    // trail column exists, so every trail-null preset keeps its exact prior digest.
    if (ls.pool.trail !== null) {
      const tr = ls.pool.trail;
      h = fnv1a(new Uint8Array(tr.head.buffer, tr.head.byteOffset, count * 2), h);
      h = fnv1a(new Uint8Array(tr.len.buffer, tr.len.byteOffset, count * 2), h);
      h = fnv1a(new Uint8Array(tr.pts.buffer, tr.pts.byteOffset, count * tr.maxPoints * 2 * 4), h);
    }
    // Mutable emission bookkeeping (C7/R6): folded LAST so a run that diverges ONLY
    // in emission state — the fractional spawn accumulators, the burst-gate roll
    // outcomes, or the sub-emitter ordinal counter — is caught even when every live
    // particle column matches. Each is folded only when non-trivial (matching the
    // optional-column pattern above), so a doc that never touches the feature keeps
    // its exact prior digest: a burst-only layer that has finished emitting has
    // acc/accDist === 0, a non-parent layer has spawnCounter === 0, and a
    // probability-1 doc keeps burstGates null.
    const priv = ls as unknown as { burstGates: Uint8Array[] | null; spawnCounter: number };
    // acc + accDist (§2.8 + schemaVersion 2): fractional → Float64 bytes, folded as
    // a fixed pair when EITHER is non-zero so a non-zero accDist can never alias a
    // non-zero acc (both channels, fixed order, one fold).
    if (ls.acc !== 0 || ls.accDist !== 0) {
      h = fnv1a(new Uint8Array(new Float64Array([ls.acc, ls.accDist]).buffer), h);
    }
    // spawnCounter (M8): a monotone integer → Int32, folded only when a spawn has
    // advanced it (i.e. an ordinal-carrying sub-emitter parent).
    if (priv.spawnCounter !== 0) {
      h = fnv1a(new Uint8Array(new Int32Array([priv.spawnCounter]).buffer), h);
    }
    // burstGates (M4): an array indexed by burstIndex of per-cycle outcome rows
    // (each a Uint8Array of {0,1,2}). Folded in burstIndex order (deterministic),
    // length-prefixed at every level; a not-yet-allocated row (a hole from an
    // out-of-order first roll) folds a -1 sentinel so it can never alias a present
    // empty row. Null (probability-1 doc) folds nothing.
    const bg = priv.burstGates;
    if (bg !== null) {
      h = fnv1a(new Uint8Array(new Int32Array([bg.length]).buffer), h);
      for (let i = 0; i < bg.length; i++) {
        const row = bg[i];
        if (row === undefined) {
          h = fnv1a(new Uint8Array(new Int32Array([-1]).buffer), h);
        } else {
          h = fnv1a(new Uint8Array(new Int32Array([row.length]).buffer), h);
          h = fnv1a(new Uint8Array(row.buffer, row.byteOffset, row.length), h);
        }
      }
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
