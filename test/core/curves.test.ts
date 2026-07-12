import { describe, it, expect } from "vitest";
import {
  buildPolylineSampler,
  flattenPolyline,
  POLYLINE_FLATTEN_N,
  sampleShape,
  type Shape,
  type Vec2,
} from "../../src/index.js";

// CURVES C-M1 (schemaVersion 12): Catmull-Rom polyline smoothing. `flattenPolyline`
// (centripetal CR, tension = smoothing, one-sided open ends, periodic closed, N=16)
// + the `smoothing === 0` EXACT short-circuit in buildPolylineSampler. These tests
// pin: 0-path BIT-IDENTITY to the authored-points construction, smoothing-1 lying on
// an INDEPENDENT centripetal-CR evaluation, length-proportional CDF on the flattened
// chain, closed-seam continuity, coincident-point guards, and two-run determinism.

type PolyShape = Extract<Shape, { kind: "polyline" }>;
const DEG = 180 / Math.PI;
const poly = (
  points: Vec2[],
  closed: boolean,
  smoothing: number,
  direction: PolyShape["direction"] = "normal",
): PolyShape => ({ kind: "polyline", points, closed, smoothing, direction, emitFrom: "volume" });

// ---------------------------------------------------------------------------
// Independent reference: the EXACT (authored-points) arc-length sampler, reproduced
// from scratch here. A `smoothing: 0` sampler MUST equal this bit-for-bit — the proof
// the short-circuit routes to the authored-points build, not the flatten path (whose
// 16x subdivision would yield different midpoints / localT).
function refStraightSample(
  points: Vec2[],
  closed: boolean,
  direction: PolyShape["direction"],
  uPos1: number,
  uDir: number,
): { px: number; py: number; dirDeg: number } {
  const n = points.length;
  const segCount = closed ? n : n - 1;
  const mx: number[] = [], my: number[] = [], dx: number[] = [], dy: number[] = [], cum: number[] = [];
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    mx[i] = (a.x + b.x) / 2; my[i] = (a.y + b.y) / 2;
    dx[i] = b.x - a.x; dy[i] = b.y - a.y;
    total += Math.hypot(dx[i]!, dy[i]!); cum[i] = total;
  }
  for (let i = 0; i < segCount; i++) cum[i] = cum[i]! / total;
  let lo = 0, hi = segCount - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m]! > uPos1) hi = m; else lo = m + 1; }
  const seg = lo;
  const fracStart = seg === 0 ? 0 : cum[seg - 1]!;
  const fracSpan = cum[seg]! - fracStart;
  const localT = fracSpan > 0 ? (uPos1 - fracStart) / fracSpan : 0;
  const half = localT - 0.5;
  const px = mx[seg]! + half * dx[seg]!;
  const py = my[seg]! + half * dy[seg]!;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += points[i]!.x; cy += points[i]!.y; }
  cx /= n; cy /= n;
  let dirDeg: number;
  if (direction === "normal") dirDeg = Math.atan2(-dx[seg]!, dy[seg]!) * DEG;
  else if (direction === "outward") {
    const ox = px - cx, oy = py - cy;
    dirDeg = ox === 0 && oy === 0 ? uDir * 360 : Math.atan2(oy, ox) * DEG;
  } else dirDeg = uDir * 360;
  return { px, py, dirDeg };
}

// Independent centripetal-CR via the HERMITE route (research route (a)); flattenPolyline
// uses the Bézier route (b). Identical curves ⇒ a genuine cross-check of the impl.
function hermiteCR(P0: Vec2, P1: Vec2, P2: Vec2, P3: Vec2, tau: number, s: number): Vec2 {
  const kn = (a: Vec2, b: Vec2) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
  const d01 = kn(P0, P1), d12 = kn(P1, P2), d23 = kn(P2, P3);
  const m1x = (P1.x - P0.x) / d01 - (P2.x - P0.x) / (d01 + d12) + (P2.x - P1.x) / d12;
  const m1y = (P1.y - P0.y) / d01 - (P2.y - P0.y) / (d01 + d12) + (P2.y - P1.y) / d12;
  const m2x = (P2.x - P1.x) / d12 - (P3.x - P1.x) / (d12 + d23) + (P3.x - P2.x) / d23;
  const m2y = (P2.y - P1.y) / d12 - (P3.y - P1.y) / (d12 + d23) + (P3.y - P2.y) / d23;
  const T1x = d12 * tau * m1x, T1y = d12 * tau * m1y, T2x = d12 * tau * m2x, T2y = d12 * tau * m2y;
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return { x: h00 * P1.x + h10 * T1x + h01 * P2.x + h11 * T2x, y: h00 * P1.y + h10 * T1y + h01 * P2.y + h11 * T2y };
}

// ---------------------------------------------------------------------------
describe("CURVES C-M1 — smoothing:0 EXACT short-circuit (bit-identity)", () => {
  const shapes: Array<[string, Vec2[], boolean, PolyShape["direction"]]> = [
    ["3-pt open normal", [{ x: -40, y: 0 }, { x: 0, y: -30 }, { x: 40, y: 0 }], false, "normal"],
    ["4-pt open random", [{ x: -60, y: 20 }, { x: -20, y: -30 }, { x: 20, y: 25 }, { x: 60, y: -20 }], false, "random"],
    ["closed square outward", [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }], true, "outward"],
  ];
  for (const [label, pts, closed, dir] of shapes) {
    it(`${label}: smoothing:0 sampler === the authored-points construction over a uniform sweep`, () => {
      const s = buildPolylineSampler(poly(pts, closed, 0, dir))!;
      expect(s).not.toBeNull();
      for (let i = 0; i < 128; i++) {
        const uPos1 = i / 128;
        const uDir = ((i * 7) % 128) / 128;
        expect(s.sample(uPos1, uDir)).toEqual(refStraightSample(pts, closed, dir, uPos1, uDir));
      }
    });
  }

  it("the edge-equivalence law survives at smoothing:0 (one-segment === `edge`)", () => {
    const L = 60;
    const edge: Shape = { kind: "edge", length: L, emitFrom: "volume" };
    const pl = buildPolylineSampler(poly([{ x: -L / 2, y: 0 }, { x: L / 2, y: 0 }], false, 0, "normal"))!;
    for (let i = 0; i < 100; i++) {
      const uPos1 = i / 100, uDir = ((i * 7) % 100) / 100;
      const e = sampleShape(edge, uPos1, 0.123, uDir);
      expect(pl.sample(uPos1, uDir)).toEqual({ px: e.px, py: e.py, dirDeg: e.dirDeg });
    }
  });

  it("undefined smoothing (legacy shape) also takes the exact path (=== smoothing:0)", () => {
    const pts = [{ x: -40, y: 0 }, { x: 0, y: -30 }, { x: 40, y: 0 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacy = { kind: "polyline", points: pts, closed: false, direction: "normal", emitFrom: "volume" } as any;
    const a = buildPolylineSampler(legacy)!;
    const b = buildPolylineSampler(poly(pts, false, 0, "normal"))!;
    for (let i = 0; i < 50; i++) expect(a.sample(i / 50, 0.3)).toEqual(b.sample(i / 50, 0.3));
  });

  it("smoothing > 0 actually curves (differs from smoothing:0 on a non-collinear shape)", () => {
    const pts = [{ x: -40, y: 0 }, { x: 0, y: -30 }, { x: 40, y: 0 }];
    const straight = buildPolylineSampler(poly(pts, false, 0, "normal"))!;
    const curved = buildPolylineSampler(poly(pts, false, 1, "normal"))!;
    let differ = 0;
    for (let i = 1; i < 50; i++) {
      const a = straight.sample(i / 50, 0), b = curved.sample(i / 50, 0);
      if (Math.abs(a.px - b.px) > 1e-6 || Math.abs(a.py - b.py) > 1e-6) differ++;
    }
    expect(differ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("CURVES C-M1 — flattenPolyline centripetal Catmull-Rom", () => {
  it("interpolates every authored point exactly at span boundaries (open)", () => {
    const pts = [{ x: -60, y: 20 }, { x: -20, y: -30 }, { x: 20, y: 25 }, { x: 60, y: -20 }];
    const flat = flattenPolyline(pts, false, 1);
    expect(flat.length).toBe((pts.length - 1) * POLYLINE_FLATTEN_N + 1);
    for (let k = 0; k < pts.length; k++) {
      expect(flat[k * POLYLINE_FLATTEN_N]!.x).toBeCloseTo(pts[k]!.x, 9);
      expect(flat[k * POLYLINE_FLATTEN_N]!.y).toBeCloseTo(pts[k]!.y, 9);
    }
  });

  it("smoothing:1 interior span lies on the independent Hermite CR evaluation", () => {
    // 4-pt open ⇒ span 1 (P1→P2) is interior with both neighbors → full Barry–Goldman.
    const pts = [{ x: -60, y: 20 }, { x: -20, y: -30 }, { x: 20, y: 25 }, { x: 60, y: -20 }];
    const flat = flattenPolyline(pts, false, 1);
    for (const k of [1, 4, 8, 11, 16]) {
      const got = flat[POLYLINE_FLATTEN_N + k]!; // span 1 sample at u = k/16
      const ref = hermiteCR(pts[0]!, pts[1]!, pts[2]!, pts[3]!, 1, k / POLYLINE_FLATTEN_N);
      expect(got.x).toBeCloseTo(ref.x, 9);
      expect(got.y).toBeCloseTo(ref.y, 9);
    }
  });

  it("tension scales the bulge monotonically (0 collinear → 1 fullest)", () => {
    // Symmetric shallow arc; the middle span's midpoint sample bows further from the
    // straight chord as smoothing rises. At smoothing 0 the flatten is not called, so
    // we compare > 0 values that DO flatten.
    const pts = [{ x: -40, y: 0 }, { x: 0, y: -30 }, { x: 40, y: 0 }];
    const bow = (sm: number): number => {
      const flat = flattenPolyline(pts, false, sm);
      // sample at the very first span's quarter point; its y-offset from the straight
      // chord grows with tension (the chord P0→P1 is y from 0 to −30).
      const p = flat[4]!; // span0, u=4/16
      const chordY = 0 + (p.x - pts[0]!.x) / (pts[1]!.x - pts[0]!.x) * (pts[1]!.y - pts[0]!.y);
      return Math.abs(p.y - chordY);
    };
    expect(bow(1)).toBeGreaterThan(bow(0.3));
    expect(bow(0.3)).toBeGreaterThan(bow(0.05));
  });

  it("closed loop is periodic, closes exactly, and the seam is treated as an interior vertex", () => {
    const sq = [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }];
    const N = POLYLINE_FLATTEN_N;
    const flat = flattenPolyline(sq, true, 1);
    expect(flat.length).toBe(sq.length * N + 1);
    // ends exactly back at the start vertex (seam closes).
    expect(flat[flat.length - 1]!.x).toBeCloseTo(sq[0]!.x, 9);
    expect(flat[flat.length - 1]!.y).toBeCloseTo(sq[0]!.y, 9);
    // The seam (vertex 0, using periodic wrap neighbors) must behave EXACTLY like the
    // three interior vertices — a symmetric square makes all four geometrically
    // identical, so the small finite-difference tangent-jump at the seam matches an
    // interior vertex's to within rounding (no special corner discontinuity).
    const jumpAt = (v: number): number => {
      const c = v * N; // chain index of vertex v (0 == seam == flat[0]/flat[last])
      const inA = flat[c === 0 ? flat.length - 1 : c]!;
      const inB = flat[c === 0 ? flat.length - 2 : c - 1]!;
      const outA = flat[c]!, outB = flat[c + 1]!;
      const aIn = Math.atan2(inA.y - inB.y, inA.x - inB.x) * DEG;
      const aOut = Math.atan2(outB.y - outA.y, outB.x - outA.x) * DEG;
      let d = Math.abs(aIn - aOut) % 360;
      if (d > 180) d = 360 - d;
      return d;
    };
    expect(jumpAt(0)).toBeCloseTo(jumpAt(1), 6); // seam === interior vertex 1
    expect(jumpAt(0)).toBeCloseTo(jumpAt(2), 6);
    expect(jumpAt(0)).toBeCloseTo(jumpAt(3), 6);
  });

  it("guards coincident points: interior duplicate stays finite (no NaN)", () => {
    const dup = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    const flat = flattenPolyline(dup, false, 1);
    for (const p of flat) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("guards all-coincident points: finite flatten AND null sampler (E37 fallback)", () => {
    const same = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
    const flat = flattenPolyline(same, false, 1);
    for (const p of flat) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(buildPolylineSampler(poly(same, false, 1, "normal"))).toBeNull();
    expect(buildPolylineSampler(poly(same, true, 1, "normal"))).toBeNull();
  });

  it("two-run determinism: flattenPolyline and the smoothed sampler are bit-identical across builds", () => {
    const pts = [{ x: -60, y: 20 }, { x: -20, y: -30 }, { x: 20, y: 25 }, { x: 60, y: -20 }];
    expect(flattenPolyline(pts, true, 0.8)).toEqual(flattenPolyline(pts, true, 0.8));
    const a = buildPolylineSampler(poly(pts, true, 0.8, "normal"))!;
    const b = buildPolylineSampler(poly(pts, true, 0.8, "normal"))!;
    for (let i = 0; i < 64; i++) expect(a.sample(i / 64, (i % 7) / 7)).toEqual(b.sample(i / 64, (i % 7) / 7));
  });
});

// ---------------------------------------------------------------------------
describe("CURVES C-M1 — CDF length-proportionality on the flattened chain", () => {
  it("sample(frac) lands at the flattened chain's arc-length point for that fraction", () => {
    const pts = [{ x: -60, y: 0 }, { x: -20, y: -40 }, { x: 20, y: 30 }, { x: 60, y: 0 }];
    const smoothing = 0.9;
    const flat = flattenPolyline(pts, false, smoothing);
    const s = buildPolylineSampler(poly(pts, false, smoothing, "random"))!;
    // Independent arc-length walk over the flattened chain.
    const seglen: number[] = [];
    let total = 0;
    for (let i = 0; i < flat.length - 1; i++) {
      const L = Math.hypot(flat[i + 1]!.x - flat[i]!.x, flat[i + 1]!.y - flat[i]!.y);
      seglen.push(L); total += L;
    }
    const arcPoint = (frac: number): Vec2 => {
      const target = frac * total;
      let acc = 0;
      for (let i = 0; i < seglen.length; i++) {
        if (acc + seglen[i]! >= target) {
          const t = seglen[i]! > 0 ? (target - acc) / seglen[i]! : 0;
          return { x: flat[i]!.x + t * (flat[i + 1]!.x - flat[i]!.x), y: flat[i]!.y + t * (flat[i + 1]!.y - flat[i]!.y) };
        }
        acc += seglen[i]!;
      }
      return flat[flat.length - 1]!;
    };
    for (const frac of [0.17, 0.33, 0.5, 0.68, 0.86]) {
      const got = s.sample(frac, 0);
      const ref = arcPoint(frac);
      expect(got.px).toBeCloseTo(ref.x, 6);
      expect(got.py).toBeCloseTo(ref.y, 6);
    }
  });
});
