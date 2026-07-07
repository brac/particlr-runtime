import { describe, it, expect } from "vitest";
import { LayerSim, deriveLayerSeed, type Layer, type BySpeedConfig, type ScalarTrack, type GradientTrack, type StartColor } from "../../src/index.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { makeLayer } from "../format/_helpers.js";

const seed = deriveLayerSeed(1337, 0);

// Single-key white gradient / null over-lifetime size so a render pass isolates
// exactly the by-speed remap (no over-lifetime contribution to size or color).
const whiteColor: GradientTrack = { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] };
// bySpeed.size / color built so that evalScalarTrack/evalGradient(t) == t: a
// linear 0→1 track reads back the normalized speed t directly.
const idSize: ScalarTrack = { mode: "curve", keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] };
const idColor: GradientTrack = { keys: [{ t: 0, r: 0, g: 0, b: 0, a: 0 }, { t: 1, r: 1, g: 1, b: 1, a: 1 }] };

// A layer whose render pass exposes tSpeed directly: sizeInit 1, over-lifetime
// size null (sizeMul 1), white over-lifetime color, and a by-speed size/color
// that are the identity of t. buf.size[i] === buf.r[i] === tSpeed[i].
function probeLayer(bySpeed: BySpeedConfig): Layer {
  return makeLayer({
    bySpeed,
    overLifetime: {
      size: null,
      color: whiteColor,
      rotation: null,
      velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
  });
}

// Drive one live particle at a chosen velocity and read back its render state.
function probe(bySpeed: BySpeedConfig, vx: number, vy = 0): { size: number; r: number } {
  const ls = new LayerSim(probeLayer(bySpeed), seed);
  const i = ls.pool.spawn();
  ls.pool.velX[i] = vx;
  ls.pool.velY[i] = vy;
  ls.pool.age[i] = 0;
  ls.pool.lifetime[i] = 1;
  ls.pool.sizeInit[i] = 1;
  const buf = makeRenderBuffers(ls.pool.capacity);
  computeRenderState(ls, buf);
  return { size: buf.size[i]!, r: buf.r[i]! };
}

describe("by-speed remap — window edges (M6)", () => {
  const bs = (): BySpeedConfig => ({ range: { min: 100, max: 300 }, size: idSize, color: idColor, rotation: null });

  it("speed at/below range.min ⇒ tSpeed 0", () => {
    expect(probe(bs(), 100).size).toBeCloseTo(0, 6); // exactly min
    expect(probe(bs(), 50).size).toBeCloseTo(0, 6); // below min, clamped
  });

  it("speed at/above range.max ⇒ tSpeed 1", () => {
    expect(probe(bs(), 300).size).toBeCloseTo(1, 6); // exactly max
    expect(probe(bs(), 400).size).toBeCloseTo(1, 6); // above max, clamped
  });

  it("midpoint ⇒ tSpeed 0.5 (size and color track it together)", () => {
    const p = probe(bs(), 200); // (200-100)/(300-100) = 0.5
    expect(p.size).toBeCloseTo(0.5, 6);
    expect(p.r).toBeCloseTo(0.5, 6); // white gradient × idColor(0.5) = 0.5
  });

  it("speed uses √(velX²+velY²), not a single axis", () => {
    // (150,200) ⇒ speed 250 ⇒ (250-100)/200 = 0.75
    expect(probe(bs(), 150, 200).size).toBeCloseTo(0.75, 6);
  });
});

describe("by-speed remap — degenerate zero-width range (M6)", () => {
  // min === max is allowed by the validator; tSpeed is a hard step at the bound:
  // 1 for speed ≥ max, 0 below (documented in FORMAT_SPEC "By-speed remaps").
  const bs = (): BySpeedConfig => ({ range: { min: 200, max: 200 }, size: idSize, color: null, rotation: null });

  it("speed below the shared bound ⇒ 0", () => {
    expect(probe(bs(), 199).size).toBeCloseTo(0, 6);
  });
  it("speed exactly at the shared bound ⇒ 1", () => {
    expect(probe(bs(), 200).size).toBeCloseTo(1, 6);
  });
  it("speed above the shared bound ⇒ 1 (no divide-by-zero / NaN)", () => {
    const p = probe(bs(), 201);
    expect(p.size).toBeCloseTo(1, 6);
    expect(Number.isNaN(p.size)).toBe(false);
  });
});

describe("by-speed size/color compose with over-lifetime + startColor (M6)", () => {
  it("a particle with all three multipliers active gets the product", () => {
    const startColor: StartColor = { mode: "palette", colors: [{ r: 0.5, g: 0.5, b: 0.5, a: 0.5 }] };
    const layer = makeLayer({
      startColor,
      // Constant by-speed tracks: independent of speed, so the product is exact.
      bySpeed: { range: { min: 0, max: 200 }, size: { mode: "constant", value: 0.6 }, color: { keys: [{ t: 0, r: 0.5, g: 0.5, b: 0.5, a: 0.5 }] }, rotation: null },
      overLifetime: {
        size: { mode: "constant", value: 0.5 },
        color: whiteColor,
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
    });
    const ls = new LayerSim(layer, seed);
    const i = ls.pool.spawn();
    ls.pool.velX[i] = 120;
    ls.pool.age[i] = 0;
    ls.pool.lifetime[i] = 1;
    ls.pool.sizeInit[i] = 10;
    // startColor tint is drawn at spawn in the full path; set it directly here.
    ls.pool.tintR![i] = 0.5;
    ls.pool.tintG![i] = 0.5;
    ls.pool.tintB![i] = 0.5;
    ls.pool.tintA![i] = 0.5;
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    // size = sizeInit(10) × over-lifetime(0.5) × bySpeed(0.6) = 3
    expect(buf.size[i]!).toBeCloseTo(3, 6);
    // r = gradient(1) × startColorTint(0.5) × bySpeedColor(0.5) = 0.25
    expect(buf.r[i]!).toBeCloseTo(0.25, 6);
    expect(buf.a[i]!).toBeCloseTo(1 * 0.5 * 0.5, 6);
  });
});

describe("by-speed rotation integrates sim-side (M6)", () => {
  // bySpeed.rotation curve 0→360 deg/s over [0,400] speed: a fast particle spins
  // fast; strong drag bleeds its speed so the per-step spin shrinks over time.
  function spinLayer(): Layer {
    return makeLayer({
      bySpeed: { range: { min: 0, max: 400 }, size: null, color: null, rotation: { mode: "curve", keys: [{ t: 0, v: 0 }, { t: 1, v: 360 }] } },
      overLifetime: {
        size: null,
        color: whiteColor,
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: { mode: "constant", value: 2 }, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
    });
  }

  it("spin per step is larger while fast than after drag slows the particle", () => {
    const ls = new LayerSim(spinLayer(), seed);
    const i = ls.pool.spawn();
    ls.pool.velX[i] = 400;
    ls.pool.velY[i] = 0;
    ls.pool.age[i] = 0;
    ls.pool.lifetime[i] = 100; // effectively immortal for the window measured
    ls.pool.rotation[i] = 0;
    ls.pool.angVel[i] = 0;
    ls.pool.sizeInit[i] = 1;

    ls.update(0.1);
    const delta1 = ls.pool.rotation[i]!; // spin during the first (fastest) step
    const before2 = ls.pool.rotation[i]!;
    ls.update(0.1);
    const delta2 = ls.pool.rotation[i]! - before2; // spin during a slower step

    expect(delta1).toBeGreaterThan(0);
    expect(delta2).toBeGreaterThan(0);
    expect(delta1).toBeGreaterThan(delta2); // spin slows as the particle slows
    // The stored angular-velocity column is never modified by the remap.
    expect(ls.pool.angVel[i]!).toBe(0);
  });
});

describe("by-speed — null pin & zero-draw pin (M6)", () => {
  it("null bySpeed: render output ignores speed entirely (byte-identical to pre-M6)", () => {
    // Two null-bySpeed sims differing only in velocity produce identical render
    // buffers — the by-speed branch is never entered, so speed cannot leak in.
    const layer = probeLayer({ range: { min: 0, max: 200 }, size: idSize, color: idColor, rotation: null });
    layer.bySpeed = null; // force the null path while keeping the isolating over-lifetime setup
    const run = (vx: number): { size: number; r: number } => {
      const ls = new LayerSim(layer, seed);
      const i = ls.pool.spawn();
      ls.pool.velX[i] = vx;
      ls.pool.age[i] = 0;
      ls.pool.lifetime[i] = 1;
      ls.pool.sizeInit[i] = 7;
      const buf = makeRenderBuffers(ls.pool.capacity);
      computeRenderState(ls, buf);
      return { size: buf.size[i]!, r: buf.r[i]! };
    };
    const slow = run(0);
    const fast = run(500);
    expect(fast.size).toBe(slow.size);
    expect(fast.r).toBe(slow.r);
    expect(slow.size).toBe(7); // sizeInit × 1 (over-lifetime null) × nothing
  });

  it("non-null bySpeed adds ZERO spawn draws (stream identical to a bySpeed-null twin)", () => {
    const bs: BySpeedConfig = {
      range: { min: 0, max: 200 },
      size: { mode: "curve", keys: [{ t: 0, v: 0.4 }, { t: 1, v: 1 }] },
      color: idColor,
      rotation: { mode: "constant", value: 90 },
    };
    const nullTwin = new LayerSim(makeLayer(), seed);
    const bsTwin = new LayerSim(makeLayer({ bySpeed: bs }), seed);
    for (let k = 0; k < 50; k++) {
      nullTwin.spawn();
      bsTwin.spawn();
    }
    expect(bsTwin.count).toBe(nullTwin.count);
    const n = nullTwin.count;
    // Spawn columns line up exactly ⇒ the two consumed the same PRNG stream.
    expect(Array.from(bsTwin.pool.rand0.slice(0, n))).toEqual(Array.from(nullTwin.pool.rand0.slice(0, n)));
    expect(Array.from(bsTwin.pool.velX.slice(0, n))).toEqual(Array.from(nullTwin.pool.velX.slice(0, n)));
    expect(Array.from(bsTwin.pool.x.slice(0, n))).toEqual(Array.from(nullTwin.pool.x.slice(0, n)));
  });
});
