// Polyline spawn-shape sampling (schemaVersion 10, B1 / TIERB §B1). Precomputes a
// per-segment cumulative arc-length CDF ONCE (built in the LayerSim constructor and
// reused across resets, exactly like maskSampler), so a spawn maps the ALREADY-DRAWN
// `uPos1` onto the total arc length (a long segment gets proportionally more
// particles) and `uDir` supplies the `random` direction — ZERO new PRNG draws (T7).
// The sampler is config-derived and carries no per-run state. It returns null on the
// E37 degenerate condition (zero total length), so the caller falls back to
// point-shape spawning via shapes.ts. Pixi-free and Node-safe.
import type { Shape, PolylineDirection } from "../format/types.js";
import type { SpawnSample } from "./shapes.js";

/** Polyline-shape variant, narrowed for the sampler's build + sample math. */
type PolylineShape = Extract<Shape, { kind: "polyline" }>;

const DEG = 180 / Math.PI;

export class PolylineSampler {
  /** Per-segment MIDPOINT `(A+B)/2`. Position is `mid + (localT − 0.5)·delta`
   * (midpoint-centered, not `A + localT·delta`): mathematically the same lerp, but
   * for a segment symmetric about the origin it reduces to `(localT − 0.5)·length`
   * BIT-EXACTLY — reproducing `edge`'s `(uPos1 − 0.5)·length`, the same trick
   * maskSampler uses to match `rect`. */
  private readonly mx: Float64Array;
  private readonly my: Float64Array;
  /** Per-segment delta (B − A); its magnitude is the segment length, its angle the
   * tangent. Kept un-normalized — `atan2` of the delta (and of the derived normal)
   * is scale-independent, so no per-sample normalize is needed. */
  private readonly dx: Float64Array;
  private readonly dy: Float64Array;
  /** Cumulative arc-length FRACTION after each segment (`cumLength/total`), row-major;
   * the last entry is exactly `1` (`total/total`). Storing fractions (not raw arc
   * length) is load-bearing for the edge-equivalence law: for a single segment the
   * span is `1 − 0 = 1`, so `localT = (uPos1 − 0) / 1 = uPos1` BIT-EXACTLY, and the
   * position collapses to `edge`'s `(uPos1 − 0.5)·L`. A zero-length segment leaves
   * the CDF flat, so the upper-bound search can never land on one. */
  private readonly cumFrac: Float64Array;
  /** Polygon centroid (mean of the POINTS, not the segments) for `outward`. */
  private readonly cx: number;
  private readonly cy: number;
  private readonly direction: PolylineDirection;

  constructor(
    mx: Float64Array,
    my: Float64Array,
    dx: Float64Array,
    dy: Float64Array,
    cumFrac: Float64Array,
    cx: number,
    cy: number,
    direction: PolylineDirection,
  ) {
    this.mx = mx;
    this.my = my;
    this.dx = dx;
    this.dy = dy;
    this.cumFrac = cumFrac;
    this.cx = cx;
    this.cy = cy;
    this.direction = direction;
  }

  /**
   * Map the already-drawn `uPos1` (arc-length parameter) and `uDir` (random-mode
   * direction) to a position + initial-velocity direction. `uPos1` indexes the
   * segment via the fraction-CDF (upper-bound binary search, the maskSampler idiom),
   * then lerps within it — no intra-segment jitter to draw. Direction per T1:
   *   • `normal`  — CCW normal of the tangent `(dx,dy)`, i.e. `(dy,−dx)`, so a
   *                 left→right segment emits UP (`dirDeg −90`), `edge` exactly.
   *   • `outward` — away from the centroid; degenerate (spawn exactly at the
   *                 centroid) falls back to `uDir·360`.
   *   • `random`  — `uDir·360`, point/texture behavior.
   */
  sample(uPos1: number, uDir: number): SpawnSample {
    // First fraction strictly greater than uPos1 (upper-bound). Because uPos1 is in
    // [0,1) and cumFrac[last] === 1, `lo` never exceeds the last index; a zero-length
    // segment (flat CDF step) is skipped by construction.
    let lo = 0;
    let hi = this.cumFrac.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumFrac[mid]! > uPos1) hi = mid;
      else lo = mid + 1;
    }
    const seg = lo;
    const fracStart = seg === 0 ? 0 : this.cumFrac[seg - 1]!;
    const fracSpan = this.cumFrac[seg]! - fracStart;
    // fracSpan > 0 for the selected segment (zero-length segments are never chosen);
    // the guard keeps a pathological all-but-one-zero polyline from dividing by 0.
    const localT = fracSpan > 0 ? (uPos1 - fracStart) / fracSpan : 0;
    const tx = this.dx[seg]!;
    const ty = this.dy[seg]!;
    // Midpoint-centered lerp (see `mx`): for a single origin-symmetric segment with
    // localT === uPos1, this is `(uPos1 − 0.5)·length`, `edge` bit-for-bit.
    const half = localT - 0.5;
    const px = this.mx[seg]! + half * tx;
    const py = this.my[seg]! + half * ty;
    let dirDeg: number;
    if (this.direction === "normal") {
      // CCW normal (dy, −dx): for a left→right segment (tx>0, ty=0) this is
      // (0, −tx) ⇒ atan2(−tx, ty) ⇒ −90°, byte-identical to `edge`.
      dirDeg = Math.atan2(-tx, ty) * DEG;
    } else if (this.direction === "outward") {
      const ox = px - this.cx;
      const oy = py - this.cy;
      dirDeg = ox === 0 && oy === 0 ? uDir * 360 : Math.atan2(oy, ox) * DEG;
    } else {
      dirDeg = uDir * 360;
    }
    return { px, py, dirDeg };
  }
}

/**
 * Build a polyline sampler for a polyline shape, or null on the E37 degenerate
 * condition (total arc length ~zero). Segments are the consecutive point pairs plus,
 * when `closed`, the wrap segment `points[n−1] → points[0]`. The length threshold
 * (`< 1e-6`) is NORMATIVE and MUST match `validate.ts checkPolyline` exactly, so a
 * document that warns "bad-polyline" is precisely the one that falls back to point
 * spawning here — the same validator/sampler agreement maskSampler keeps with
 * checkMask. Lengths use `Math.hypot`, matching the validator's total.
 */
export function buildPolylineSampler(shape: PolylineShape): PolylineSampler | null {
  const pts = shape.points;
  const n = pts.length;
  const segCount = shape.closed ? n : n - 1;
  if (segCount < 1) return null; // < 2 points — validator rejects, defense in depth
  const mx = new Float64Array(segCount);
  const my = new Float64Array(segCount);
  const dx = new Float64Array(segCount);
  const dy = new Float64Array(segCount);
  const cumFrac = new Float64Array(segCount);
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!; // (i+1)%n gives point[0] for the closed wrap segment
    mx[i] = (a.x + b.x) / 2;
    my[i] = (a.y + b.y) / 2;
    dx[i] = b.x - a.x;
    dy[i] = b.y - a.y;
    total += Math.hypot(dx[i]!, dy[i]!);
    cumFrac[i] = total; // raw cumulative length for now; normalized to [0,1] below
  }
  if (total < 1e-6) return null; // E37 degenerate ⇒ point-shape fallback
  // Normalize to fractions in a second pass so the last entry is exactly total/total
  // === 1 (guaranteeing every uPos1 in [0,1) finds a segment) and a single segment
  // yields cumFrac [1] ⇒ localT === uPos1 exactly (edge-equivalence law).
  for (let i = 0; i < segCount; i++) cumFrac[i] = cumFrac[i]! / total;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i]!.x;
    cy += pts[i]!.y;
  }
  cx /= n;
  cy /= n;
  return new PolylineSampler(mx, my, dx, dy, cumFrac, cx, cy, shape.direction);
}
