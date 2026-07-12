// Polyline spawn-shape sampling (schemaVersion 10, B1 / TIERB §B1). Precomputes a
// per-segment cumulative arc-length CDF ONCE (built in the LayerSim constructor and
// reused across resets, exactly like maskSampler), so a spawn maps the ALREADY-DRAWN
// `uPos1` onto the total arc length (a long segment gets proportionally more
// particles) and `uDir` supplies the `random` direction — ZERO new PRNG draws (T7).
// The sampler is config-derived and carries no per-run state. It returns null on the
// E37 degenerate condition (zero total length), so the caller falls back to
// point-shape spawning via shapes.ts. Pixi-free and Node-safe.
import type { Shape, PolylineDirection, Vec2 } from "../format/types.js";
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

/** Fixed subdivision per curved span (CURVES_PLAN C4). Chord error is
 * `~L/(8·N²)`, so N=16 keeps a ≤300px span under 0.2px — invisible at preview
 * scale — while a 64-point closed polyline flattens to only `64·16 = 1024`
 * sub-segments (a single per-layer transient, built once). Shared so the sampler
 * CDF and the editor overlay (C-M2) subdivide IDENTICALLY. Defined once — the sole
 * source of N. */
export const POLYLINE_FLATTEN_N = 16;

/** de Casteljau evaluation of the cubic Bézier `(b0,b1,b2,b3)` at `u ∈ [0,1]`
 * (repeated lerp, no basis polynomial — CURVES_RESEARCH Q1 route (b)). At `u === 1`
 * every lerp returns its second argument, so the result is EXACTLY `b3` — adjacent
 * spans join, and the curve interpolates every authored point, bit-exactly. */
function bezier(
  b0x: number, b0y: number, b1x: number, b1y: number,
  b2x: number, b2y: number, b3x: number, b3y: number, u: number,
): Vec2 {
  const ax = b0x + (b1x - b0x) * u, ay = b0y + (b1y - b0y) * u;
  const bx = b1x + (b2x - b1x) * u, by = b1y + (b2y - b1y) * u;
  const cx = b2x + (b3x - b2x) * u, cy = b2y + (b3y - b2y) * u;
  const dx = ax + (bx - ax) * u, dy = ay + (by - ay) * u;
  const ex = bx + (cx - bx) * u, ey = by + (cy - by) * u;
  return { x: dx + (ex - dx) * u, y: dy + (ey - dy) * u };
}

/**
 * Flatten a polyline into a dense vertex chain by CENTRIPETAL (α=0.5) Catmull-Rom
 * smoothing (CURVES_PLAN C1/C2/C4/C5). Exported beside the sampler so the editor
 * overlay draws the SAME curve the sampler builds its CDF from — parity by
 * construction, no duplicated spline math, and no sampler needed to call it.
 *
 * `smoothing` (`τ`) scales the tangent MAGNITUDE (tension / cardinal-spline
 * semantics): `0` → collinear chain (a caller SHOULD short-circuit before here),
 * `1` → full centripetal CR. The curve passes THROUGH every authored point (the
 * Bézier endpoints are the authored points exactly) at every `τ`.
 *
 * Each span `P1→P2` uses neighbors `P0`,`P3` for its Barry–Goldman non-uniform
 * tangents. Open ends use ONE-SIDED (natural) tangents — the forward/backward chord
 * — so no phantom point and no zero-knot division (CURVES_RESEARCH Q1). Closed uses
 * periodic wrap neighbors (C¹ across the seam). Coincident points (Δt = 0 knot
 * spans) fall back to the one-sided chord / zero tangent — NEVER a division by zero,
 * so the output is finite for any input. The result is an OPEN chain of consecutive
 * points (for `closed` it ends exactly at `points[0]`, closing the loop), fed to the
 * existing CDF pair-loop verbatim.
 */
export function flattenPolyline(points: Vec2[], closed: boolean, smoothing: number): Vec2[] {
  const n = points.length;
  if (n < 2) return points.map((p) => ({ x: p.x, y: p.y })); // defense; caller guards
  const tau = smoothing;
  const N = POLYLINE_FLATTEN_N;
  const out: Vec2[] = [{ x: points[0]!.x, y: points[0]!.y }];
  const spanCount = closed ? n : n - 1;
  // Centripetal knot spacing between two points = sqrt(euclidean distance).
  const knot = (a: Vec2, b: Vec2): number => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
  for (let s = 0; s < spanCount; s++) {
    const P1 = points[s]!;
    const P2 = points[(s + 1) % n]!;
    let P0: Vec2 | null;
    let P3: Vec2 | null;
    if (closed) {
      P0 = points[(s - 1 + n) % n]!;
      P3 = points[(s + 2) % n]!;
    } else {
      P0 = s > 0 ? points[s - 1]! : null;
      P3 = s + 2 <= n - 1 ? points[s + 2]! : null;
    }
    const d12 = knot(P1, P2);
    const d01 = P0 ? knot(P0, P1) : 0;
    const d23 = P3 ? knot(P2, P3) : 0;
    // Tangent at P1 (Barry–Goldman); fall back to the one-sided forward chord at an
    // open start or a Δt=0 neighbor (no phantom point, no zero-knot division).
    let m1x = 0, m1y = 0;
    if (d12 > 0) {
      if (P0 && d01 > 0) {
        m1x = (P1.x - P0.x) / d01 - (P2.x - P0.x) / (d01 + d12) + (P2.x - P1.x) / d12;
        m1y = (P1.y - P0.y) / d01 - (P2.y - P0.y) / (d01 + d12) + (P2.y - P1.y) / d12;
      } else {
        m1x = (P2.x - P1.x) / d12;
        m1y = (P2.y - P1.y) / d12;
      }
    }
    // Tangent at P2; one-sided backward chord at an open end or a Δt=0 neighbor.
    let m2x = 0, m2y = 0;
    if (d12 > 0) {
      if (P3 && d23 > 0) {
        m2x = (P2.x - P1.x) / d12 - (P3.x - P1.x) / (d12 + d23) + (P3.x - P2.x) / d23;
        m2y = (P2.y - P1.y) / d12 - (P3.y - P1.y) / (d12 + d23) + (P3.y - P2.y) / d23;
      } else {
        m2x = (P2.x - P1.x) / d12;
        m2y = (P2.y - P1.y) / d12;
      }
    }
    // CR → cubic Bézier: B0=P1, B3=P2, inner handles at (Δt/3)·(τ·tangent). Tension
    // scales the TANGENTS (handle length), never the endpoints — the curve stays
    // pinned to the authored points. Δt=0 ⇒ c=0 ⇒ all handles collapse to P1/P2.
    const c = (d12 * tau) / 3;
    const b1x = P1.x + c * m1x, b1y = P1.y + c * m1y;
    const b2x = P2.x - c * m2x, b2y = P2.y - c * m2y;
    for (let k = 1; k <= N; k++) {
      out.push(bezier(P1.x, P1.y, b1x, b1y, b2x, b2y, P2.x, P2.y, k / N));
    }
  }
  return out;
}

/**
 * Build a polyline sampler for a polyline shape, or null on the E37 degenerate
 * condition (total arc length ~zero). Segments are the consecutive point pairs plus,
 * when `closed`, the wrap segment `points[n−1] → points[0]`. The length threshold
 * (`< 1e-6`) is NORMATIVE and MUST match `validate.ts checkPolyline` exactly, so a
 * document that warns "bad-polyline" is precisely the one that falls back to point
 * spawning here — the same validator/sampler agreement maskSampler keeps with
 * checkMask. Lengths use `Math.hypot`, matching the validator's total.
 *
 * CURVES (schemaVersion 12): `smoothing > 0` flattens each span (`flattenPolyline`)
 * and builds the SAME CDF from the flattened chain. `smoothing === 0` (EXACT — and
 * `undefined`, treated as 0) takes the pre-CURVES build below UNCHANGED, so a
 * `smoothing: 0` polyline is BIT-IDENTICAL to a pre-v12 one (research trap 1/2: a
 * zero-tension Hermite is smoothstep-parameterized, not linear, so ONLY the
 * short-circuit — not any math path — guarantees exactness; the edge-equivalence law
 * and every existing test hold untouched).
 */
export function buildPolylineSampler(shape: PolylineShape): PolylineSampler | null {
  // Short-circuit: only a strictly-positive smoothing enters the flatten path;
  // `0`/`undefined`/`NaN` fall through to the exact build (`> 0` is false for all).
  if (shape.smoothing > 0) return buildSmoothedPolylineSampler(shape);
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

/**
 * The `smoothing > 0` path: flatten the authored points into a dense CR chain
 * (`flattenPolyline`) and build the identical MIDPOINT/DELTA/FRACTION-CDF machinery
 * over consecutive flattened pairs (the chain already bakes in the closed wrap, so
 * no `%n` here). `normal` therefore becomes the LOCAL CURVE normal per sub-segment
 * automatically (each carries its own tangent). The centroid for `outward` stays the
 * mean of the AUTHORED points (research Q5) — cheaper, stable, and unchanged by
 * smoothing. Degeneracy: the flattened total vanishes iff all authored points
 * coincide (same boundary as the validator's straight-length E37 test), so a
 * near-coincident curve returns null → point-shape fallback, agreement preserved.
 */
function buildSmoothedPolylineSampler(shape: PolylineShape): PolylineSampler | null {
  const pts = shape.points;
  const n = pts.length;
  if ((shape.closed ? n : n - 1) < 1) return null; // < 2 points — defense in depth
  const flat = flattenPolyline(pts, shape.closed, shape.smoothing);
  const segCount = flat.length - 1;
  if (segCount < 1) return null;
  const mx = new Float64Array(segCount);
  const my = new Float64Array(segCount);
  const dx = new Float64Array(segCount);
  const dy = new Float64Array(segCount);
  const cumFrac = new Float64Array(segCount);
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const a = flat[i]!;
    const b = flat[i + 1]!;
    mx[i] = (a.x + b.x) / 2;
    my[i] = (a.y + b.y) / 2;
    dx[i] = b.x - a.x;
    dy[i] = b.y - a.y;
    total += Math.hypot(dx[i]!, dy[i]!);
    cumFrac[i] = total;
  }
  if (total < 1e-6) return null; // E37 degenerate ⇒ point-shape fallback
  for (let i = 0; i < segCount; i++) cumFrac[i] = cumFrac[i]! / total;
  // Centroid on the AUTHORED points (not the flattened vertices) — matches the exact
  // path, so `outward` is identical geometry at any smoothing.
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
