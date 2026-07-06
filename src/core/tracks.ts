// Evaluation of the value primitives (plan §2.2, §2.3). Pure functions with no
// randomness of their own: range-mode tracks consume a pre-drawn per-particle
// uniform (§2.3) so a track's value is fixed for a particle's whole lifetime.
import type { CurveKey, GradientTrack, ScalarInit, ScalarTrack } from "../format/types.js";
import { ease } from "./easing.js";
import type { Rng } from "./prng.js";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Sample a per-particle initial value at spawn (one draw for range mode). */
export function sampleScalarInit(init: ScalarInit, rng: Rng): number {
  if (init.mode === "range") return init.min + (init.max - init.min) * rng();
  return init.value;
}

/**
 * Evaluate a curve at normalized time t, honoring per-segment easing, [0,1]
 * clamping, single-key constants (E3), and duplicate-t "last wins" (E12).
 */
export function evalCurve(keys: readonly CurveKey[], t: number): number {
  const n = keys.length;
  const first = keys[0]!;
  if (n === 1) return first.v;
  const last = keys[n - 1]!;
  if (t >= last.t) return last.v; // upper clamp (and last-wins at a top duplicate)
  if (t <= first.t) return first.v; // lower clamp

  // Last segment start i with keys[i].t <= t (keys are sorted ascending).
  let i = 0;
  for (let j = 0; j < n - 1; j++) {
    if (keys[j]!.t <= t) i = j;
    else break;
  }
  const k0 = keys[i]!;
  const k1 = keys[i + 1]!;
  const span = k1.t - k0.t;
  if (span <= 0) return k1.v; // zero-width duplicate segment: later key wins
  const u = (t - k0.t) / span;
  return k0.v + (k1.v - k0.v) * ease(k0.ease, u);
}

/**
 * Evaluate a ScalarTrack at normalized time t. `particleRand` is the pre-drawn
 * uniform used only by range mode (§2.3); constant/curve ignore it.
 */
export function evalScalarTrack(track: ScalarTrack, t: number, particleRand: number): number {
  switch (track.mode) {
    case "constant":
      return track.value;
    case "range":
      return track.min + (track.max - track.min) * particleRand;
    case "curve":
      return evalCurve(track.keys, t);
  }
}

/** Evaluate a gradient at normalized time t into `out` (linear interpolation, L7). */
export function evalGradient(track: GradientTrack, t: number, out: RGBA): RGBA {
  const keys = track.keys;
  const n = keys.length;
  const first = keys[0]!;
  const write = (k: { r: number; g: number; b: number; a: number }): RGBA => {
    out.r = k.r;
    out.g = k.g;
    out.b = k.b;
    out.a = k.a;
    return out;
  };
  if (n === 1) return write(first);
  const last = keys[n - 1]!;
  if (t >= last.t) return write(last);
  if (t <= first.t) return write(first);

  let i = 0;
  for (let j = 0; j < n - 1; j++) {
    if (keys[j]!.t <= t) i = j;
    else break;
  }
  const k0 = keys[i]!;
  const k1 = keys[i + 1]!;
  const span = k1.t - k0.t;
  if (span <= 0) return write(k1);
  const u = (t - k0.t) / span;
  out.r = k0.r + (k1.r - k0.r) * u;
  out.g = k0.g + (k1.g - k0.g) * u;
  out.b = k0.b + (k1.b - k0.b) * u;
  out.a = k0.a + (k1.a - k0.a) * u;
  return out;
}
