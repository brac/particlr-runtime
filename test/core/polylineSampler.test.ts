import { describe, it, expect } from "vitest";
import {
  LayerSim,
  Effect,
  buildPolylineSampler,
  sampleShape,
  deriveLayerSeed,
  mulberry32,
  validateParticle,
  type Layer,
  type Shape,
  type Rng,
} from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);

type PolyShape = Extract<Shape, { kind: "polyline" }>;
const poly = (points: { x: number; y: number }[], closed: boolean, direction: PolyShape["direction"]): PolyShape => ({
  kind: "polyline",
  points,
  closed,
  direction,
  emitFrom: "volume",
});
const polyLayer = (shape: PolyShape, layerOver: Partial<Layer> = {}): Layer => makeLayer({ shape, ...layerOver });

// True iff validating a doc holding this polyline emits the E37 "bad-polyline"
// warning — the exact predicate whose agreement with the sampler we pin below.
const validatorBadPolyline = (shape: PolyShape): boolean => {
  const r = validateParticle(makeDoc({ layers: [makeLayer({ shape })] }));
  return r.warnings.some((w) => w.code === "bad-polyline");
};

describe("polylineSampler — build + arc-length sampling (§B1)", () => {
  it("CDF weighting ∝ segment length: uPos1·total indexes proportionally", () => {
    // seg0 (0,0)→(90,0) len 90 (horizontal, y=0); seg1 (90,0)→(90,30) len 30
    // (vertical, x=90). total 120, so seg0 owns 75% of the uPos1 range.
    const s = buildPolylineSampler(poly([{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 30 }], false, "random"))!;
    expect(s).not.toBeNull();
    // Exact interior positions: uPos1·120 is the arc-length target.
    expect(s.sample(0, 0)).toMatchObject({ px: 0, py: 0 });
    expect(s.sample(0.375, 0)).toMatchObject({ px: 45, py: 0 }); // target 45 → seg0 mid
    expect(s.sample(0.75, 0)).toMatchObject({ px: 90, py: 0 }); // target 90 → seg1 start
    expect(s.sample(0.875, 0)).toMatchObject({ px: 90, py: 15 }); // target 105 → seg1 mid
    // Proportion: uniformly-spaced uPos1 lands on seg0 (py===0) ≈ 75% of the time.
    let onSeg0 = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) if (s.sample((i + 0.5) / N, 0).py === 0) onSeg0++;
    expect(onSeg0 / N).toBeGreaterThan(0.74);
    expect(onSeg0 / N).toBeLessThan(0.76);
  });

  it("closed wrap segment (points[n−1]→points[0]) joins the length-CDF", () => {
    // Unit square, 4 equal edges of length 10; closed adds the 4th (wrap) edge
    // (0,10)→(0,0). total 40, cdf [10,20,30,40].
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const closed = buildPolylineSampler(poly(sq, true, "random"))!;
    // target 35 → seg3 (wrap), localT 0.5 → (0, 5) — only reachable WITH the wrap.
    expect(closed.sample(0.875, 0)).toMatchObject({ px: 0, py: 5 });
    const w = closed.sample(0.9, 0); // deeper into the wrap edge (localT 0.6)
    expect(w.px).toBe(0);
    expect(w.py).toBeCloseTo(4, 10);

    // Open (no wrap): 3 edges, total 30. uPos1 0.9 → seg2 (10,10)→(0,10), NOT the
    // wrap edge — proves the wrap segment is absent when closed=false. (thirds are
    // not float-exact, so px is asserted with tolerance; py is exact.)
    const open = buildPolylineSampler(poly(sq, false, "random"))!;
    const o = open.sample(0.9, 0);
    expect(o.px).toBeCloseTo(3, 10);
    expect(o.py).toBe(10);
  });

  it("direction basis `normal` is the CCW normal of the segment tangent", () => {
    // left→right emits UP (dirDeg −90) — the `edge` convention, exactly.
    const horiz = buildPolylineSampler(poly([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, "normal"))!;
    expect(horiz.sample(0.5, 0.3).dirDeg).toBe(-90);
    // top→bottom (tangent +y) → normal points +x (dirDeg 0; atan2(-0,+) yields −0).
    const vert = buildPolylineSampler(poly([{ x: 0, y: 0 }, { x: 0, y: 10 }], false, "normal"))!;
    expect(Math.abs(vert.sample(0.5, 0.3).dirDeg)).toBe(0);
  });

  it("direction basis `outward` points away from the polygon centroid", () => {
    // Square centered on the origin; centroid (0,0). Edges len 20, total 80.
    const sq = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
    const s = buildPolylineSampler(poly(sq, true, "outward"))!;
    // target 30 → seg1 (right edge x=10) mid → (10,0) → outward = +x (dirDeg 0).
    expect(s.sample(0.375, 0)).toMatchObject({ px: 10, py: 0, dirDeg: 0 });
    // target 50 → seg2 (top edge y=10) mid → (0,10) → outward = +y (dirDeg 90).
    expect(s.sample(0.625, 0)).toMatchObject({ px: 0, py: 10, dirDeg: 90 });
  });

  it("direction basis `outward` degrades to uDir·360 at the centroid", () => {
    // A segment passing THROUGH the centroid: sampling its midpoint = centroid.
    const s = buildPolylineSampler(poly([{ x: -10, y: 0 }, { x: 10, y: 0 }], false, "outward"))!;
    const at = s.sample(0.5, 0.25); // midpoint → (0,0) = centroid
    expect(at.px).toBe(0);
    expect(at.py).toBe(0);
    expect(at.dirDeg).toBe(90); // uDir·360 = 0.25·360
  });

  it("direction basis `random` is uDir·360 regardless of position", () => {
    const s = buildPolylineSampler(poly([{ x: 0, y: 0 }, { x: 40, y: -20 }, { x: 80, y: 0 }], false, "random"))!;
    expect(s.sample(0.1, 0.5).dirDeg).toBe(180);
    expect(s.sample(0.9, 0.5).dirDeg).toBe(180);
  });

  it("edge-equivalence law: a horizontal 2-point `normal` polyline === `edge`", () => {
    // The load-bearing continuity claim (T1): `edge` is a one-segment horizontal
    // polyline. IDENTICAL SpawnSamples for the same uniforms.
    const L = 60;
    const edge: Shape = { kind: "edge", length: L, emitFrom: "volume" };
    const pl = buildPolylineSampler(poly([{ x: -L / 2, y: 0 }, { x: L / 2, y: 0 }], false, "normal"))!;
    for (let i = 0; i < 100; i++) {
      const uPos1 = i / 100;
      const uDir = ((i * 7) % 100) / 100;
      const e = sampleShape(edge, uPos1, 0.123, uDir);
      const p = pl.sample(uPos1, uDir);
      expect(p).toEqual({ px: e.px, py: e.py, dirDeg: e.dirDeg });
      expect(p.dirDeg).toBe(-90);
    }
  });

  it("returns null on the E37 degenerate condition (zero total length)", () => {
    expect(buildPolylineSampler(poly([{ x: 5, y: 5 }, { x: 5, y: 5 }], false, "normal"))).toBeNull(); // coincident
    expect(buildPolylineSampler(poly([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }], true, "normal"))).toBeNull();
    // near-boundary: 5e-7 < 1e-6 → degenerate; 2e-6 ≥ 1e-6 → live.
    expect(buildPolylineSampler(poly([{ x: 0, y: 0 }, { x: 5e-7, y: 0 }], false, "normal"))).toBeNull();
    expect(buildPolylineSampler(poly([{ x: 0, y: 0 }, { x: 2e-6, y: 0 }], false, "normal"))).not.toBeNull();
  });

  it("the degenerate threshold agrees with validate.ts checkPolyline (1e-6 boundary)", () => {
    // sampler null ⇔ validator warns, so a doc never warns-but-works or passes-but-
    // degrades — the same agreement maskSampler keeps with checkMask.
    const dead = poly([{ x: 0, y: 0 }, { x: 5e-7, y: 0 }], false, "normal");
    const live = poly([{ x: 0, y: 0 }, { x: 2e-6, y: 0 }], false, "normal");
    expect(buildPolylineSampler(dead)).toBeNull();
    expect(validatorBadPolyline(dead)).toBe(true);
    expect(buildPolylineSampler(live)).not.toBeNull();
    expect(validatorBadPolyline(live)).toBe(false);
  });
});

describe("polylineSampler — layerSim draw contract (T7: zero new draws)", () => {
  it("a polyline layer takes EXACTLY the 13 standard draws (no appended draws)", () => {
    const sim = new LayerSim(polyLayer(poly([{ x: -40, y: 0 }, { x: 0, y: -30 }, { x: 40, y: 0 }], false, "normal")), seed);
    let count = 0;
    const base = mulberry32(seed);
    const counting: Rng = () => {
      count++;
      return base();
    };
    expect(sim.spawnFrom(counting, 0, 0, 0, 0)).toBe(true);
    expect(count).toBe(13); // 13 standard, ZERO polyline draws — unlike texture's 16
  });

  it("Nth-spawn rand0 matches a plain 13-draw/spawn stream (draw-count pin)", () => {
    const sim = new LayerSim(polyLayer(poly([{ x: -40, y: 0 }, { x: 40, y: 0 }], false, "normal")), seed);
    sim.spawn();
    sim.spawn();
    const r = mulberry32(seed);
    for (let k = 0; k < 13 + 8; k++) r(); // spawn0 (13) + spawn1 up to rand0 (8)
    expect(sim.pool.rand0[1]).toBe(Math.fround(r()));
  });

  it("a polyline layer spawns particles that lie on the polyline segments", () => {
    // A horizontal segment y=0 from x=−40..40: every spawn has py===0 and px in range.
    const sim = new LayerSim(polyLayer(poly([{ x: -40, y: 0 }, { x: 40, y: 0 }], false, "normal")), seed);
    for (let i = 0; i < 200; i++) sim.spawn();
    for (let i = 0; i < sim.count; i++) {
      expect(sim.pool.y[i]).toBe(0);
      expect(sim.pool.x[i]).toBeGreaterThanOrEqual(-40);
      expect(sim.pool.x[i]).toBeLessThanOrEqual(40);
    }
  });

  it("E37: a degenerate polyline layer falls back to point spawning at (0,0)", () => {
    const sim = new LayerSim(polyLayer(poly([{ x: 7, y: 7 }, { x: 7, y: 7 }], false, "normal")), seed);
    let count = 0;
    const base = mulberry32(seed);
    const counting: Rng = () => {
      count++;
      return base();
    };
    expect(sim.spawnFrom(counting, 0, 0, 0, 0)).toBe(true);
    expect(count).toBe(13); // still exactly 13 — degenerate takes no extra draws either
    expect(sim.pool.x[0]).toBe(0); // point-shape origin
    expect(sim.pool.y[0]).toBe(0);
  });
});

describe("polylineSampler — determinism", () => {
  it("is bit-identical across two runs (polyline layer, 300 mixed-dt steps)", () => {
    const doc = makeDoc({
      duration: 3,
      layers: [
        polyLayer(poly([{ x: -60, y: 20 }, { x: -20, y: -30 }, { x: 20, y: 25 }, { x: 60, y: -20 }], false, "normal"), {
          emission: { ...makeLayer().emission, rateOverTime: { mode: "constant", value: 40 }, bursts: [] },
        }),
      ],
    });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(7, 300);
    const checkpoints = new Set([1, 60, 150, 300]);
    for (let i = 1; i <= 300; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
    expect(a.layers[0]!.count).toBe(b.layers[0]!.count);
    expect(Array.from(a.layers[0]!.pool.x.slice(0, a.layers[0]!.count))).toEqual(
      Array.from(b.layers[0]!.pool.x.slice(0, b.layers[0]!.count)),
    );
  });
});
