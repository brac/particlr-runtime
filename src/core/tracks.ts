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

/** Sample a per-particle initial value at spawn (one draw only for range mode). */
export function sampleScalarInit(init: ScalarInit, rng: Rng): number {
  if (init.mode === "range") return init.min + (init.max - init.min) * rng();
  return init.value;
}

/**
 * Spawn-time draw for an initial value that ALWAYS consumes exactly one uniform,
 * even in constant mode (which discards it). This keeps the PRNG draw count per
 * spawn fixed and mode-independent, which the determinism contract requires
 * (§2.7). Use this in the spawn routine; use sampleScalarInit elsewhere.
 */
export function drawScalarInit(init: ScalarInit, rng: Rng): number {
  const u = rng();
  return init.mode === "range" ? init.min + (init.max - init.min) * u : init.value;
}

/**
 * Evaluate a curve at normalized time t, honoring per-segment easing, [0,1]
 * clamping, single-key constants (E3), and duplicate-t "last wins" (E12).
 */
export function evalCurve(keys: readonly CurveKey[], t: number): number {
  const n = keys.length;
  // validateParticle guarantees >= 1 key; guard for hand-built inputs so the
  // failure is a clear message rather than an opaque undefined dereference.
  if (n === 0) throw new Error("evalCurve: curve must have at least one key");
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
    case "randomBetweenCurves": {
      // §0.3b. Blend two curves by the track's OWN reserved per-particle uniform
      // — the same `particleRand` slot `range` consumes, so this adds ZERO new
      // PRNG draws. The evaluator lands here in M0 (schema milestone) both to keep
      // the switch exhaustive and because it is the correct final impl (like TIER2
      // M0's texture-shape stub); M2 adds only editor authoring + preset + tests.
      const a = evalCurve(track.a, t);
      const b = evalCurve(track.b, t);
      return a + (b - a) * particleRand;
    }
  }
}

/**
 * Rotate an RGB color's hue by `degrees` (A6 hueJitter, §0.3c / E29). Pure:
 * RGB→HSV, `h += degrees` (wrapped to [0,360)), HSV→RGB. Writes r/g/b into `out`
 * and leaves `out.a` untouched (the caller owns alpha), matching evalGradient's
 * write-into-scratch, zero-allocation pattern. Inputs are clamped to [0,1].
 *
 * Runs at RENDER time only — the pool holds just the per-particle offset (in the
 * tint column), so this math never touches the sim state or the statehash.
 * `degrees === 0` (the u=0.5 spawn) is a bitwise no-op, so the hueJitter render
 * path collapses to the exact no-startColor path when a particle draws no jitter.
 * A saturation-0 (gray) input has an undefined hue, so any rotation returns it
 * unchanged (bitwise).
 */
export function hueRotateRGB(r: number, g: number, b: number, degrees: number, out: RGBA): RGBA {
  r = r < 0 ? 0 : r > 1 ? 1 : r;
  g = g < 0 ? 0 : g > 1 ? 1 : g;
  b = b < 0 ? 0 : b > 1 ? 1 : b;
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const d = max - min;
  // Achromatic (d === 0) or an exact zero rotation ⇒ hue is unchanged; copy the
  // (already-clamped) input straight through so an in-range color round-trips
  // bitwise.
  if (d === 0 || degrees === 0) {
    out.r = r;
    out.g = g;
    out.b = b;
    return out;
  }
  let h: number;
  if (max === r) h = (g - b) / d;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = h * 60 + degrees;
  h = ((h % 360) + 360) % 360; // wrap into [0,360)
  const s = max === 0 ? 0 : d / max;
  const v = max;
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  let r1: number;
  let g1: number;
  let b1: number;
  if (hp < 1) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else if (hp < 3) {
    r1 = 0;
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    r1 = 0;
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    g1 = 0;
    b1 = c;
  } else {
    r1 = c;
    g1 = 0;
    b1 = x;
  }
  out.r = r1 + m;
  out.g = g1 + m;
  out.b = b1 + m;
  return out;
}

/** Evaluate a gradient at normalized time t into `out` (linear interpolation, L7). */
export function evalGradient(track: GradientTrack, t: number, out: RGBA): RGBA {
  const keys = track.keys;
  const n = keys.length;
  if (n === 0) throw new Error("evalGradient: gradient must have at least one key");
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
