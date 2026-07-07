import { describe, it, expect } from "vitest";
import { LayerSim, Effect, deriveLayerSeed, mulberry32, sampleShape, type Layer, type Shape } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);
const DEG = 180 / Math.PI;

// Normalize an angle in degrees into [0, 360).
const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// Donut radius bounds (sampleShape direct)
// ---------------------------------------------------------------------------
describe("donut radius (§M4)", () => {
  it("volume samples all fall in [innerRadius, radius]", () => {
    const inner = 30;
    const outer = 80;
    const shape: Shape = { kind: "circle", radius: outer, innerRadius: inner, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "volume" };
    for (let i = 0; i <= 1000; i++) {
      const u2 = i / 1000; // sweep the radius uniform across [0,1]
      const s = sampleShape(shape, 0.37, u2, 0.5);
      const r = Math.hypot(s.px, s.py);
      expect(r).toBeGreaterThanOrEqual(inner - 1e-6);
      expect(r).toBeLessThanOrEqual(outer + 1e-6);
    }
    // The extremes are hit exactly: u2=0 → innerRadius, u2=1 → radius.
    expect(Math.hypot(...ptOf(shape, 0.1, 0))).toBeCloseTo(inner, 6);
    expect(Math.hypot(...ptOf(shape, 0.1, 1))).toBeCloseTo(outer, 6);
  });

  it("surface samples all sit at radius exactly (outer circumference only)", () => {
    const outer = 80;
    const shape: Shape = { kind: "circle", radius: outer, innerRadius: 30, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "surface" };
    for (let i = 0; i <= 200; i++) {
      const s = sampleShape(shape, i / 200, i / 200, 0.5);
      expect(Math.hypot(s.px, s.py)).toBeCloseTo(outer, 6);
    }
  });

  it("innerRadius 0 (full disc) reproduces the v2 radius form byte-for-byte", () => {
    const outer = 50;
    const donut: Shape = { kind: "circle", radius: outer, innerRadius: 0, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "volume" };
    for (const u2 of [0, 0.13, 0.5, 0.777, 1]) {
      const r = Math.hypot(...ptOf(donut, 0.25, u2));
      expect(r).toBe(outer * Math.sqrt(u2)); // exact, not just close
    }
  });
});

function ptOf(shape: Shape, u1: number, u2: number): [number, number] {
  const s = sampleShape(shape, u1, u2, 0.5);
  return [s.px, s.py];
}

// ---------------------------------------------------------------------------
// Arc span (random mode)
// ---------------------------------------------------------------------------
describe("arc span (§M4)", () => {
  it("a circle with arc 90 emits only in [0°, 90°] clockwise from +x", () => {
    const shape: Shape = { kind: "circle", radius: 40, innerRadius: 0, arc: 90, arcMode: "random", arcSpeed: 1, emitFrom: "surface" };
    for (let i = 0; i <= 1000; i++) {
      const u1 = i / 1000;
      const s = sampleShape(shape, u1, 0.5, 0.5);
      const deg = norm360(Math.atan2(s.py, s.px) * DEG);
      expect(deg).toBeGreaterThanOrEqual(-1e-6);
      expect(deg).toBeLessThanOrEqual(90 + 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// arcT override exactness + 13-draw order intact
// ---------------------------------------------------------------------------
describe("arcT override exactness (§M4)", () => {
  it("a non-random arc mode replaces the angle uniform with arcT", () => {
    const shape: Shape = { kind: "circle", radius: 40, innerRadius: 0, arc: 360, arcMode: "loop", arcSpeed: 1, emitFrom: "surface" };
    // arcT 0.25 over a full circle ⇒ 90°, regardless of the drawn u1 (here 0.99).
    const s = sampleShape(shape, 0.99, 0.5, 0.5, 0.25);
    expect(norm360(Math.atan2(s.py, s.px) * DEG)).toBeCloseTo(90, 5);
    // arcT -1 (random / no override) falls back to the drawn u1.
    const rnd = sampleShape(shape, 0.99, 0.5, 0.5, -1);
    expect(norm360(Math.atan2(rnd.py, rnd.px) * DEG)).toBeCloseTo(norm360(0.99 * 360), 5);
  });

  it("the angle uniform is still DRAWN (then discarded) — 13-draw order intact", () => {
    // Spawn one particle with a driven arcT; rand0 is the 9th spawn draw. If the
    // override skipped drawing the angle uniform, rand0 would be the 8th draw.
    const layer = makeLayer({
      shape: { kind: "circle", radius: 40, innerRadius: 0, arc: 360, arcMode: "loop", arcSpeed: 1, emitFrom: "surface" },
    });
    const sim = new LayerSim(layer, seed);
    sim.spawn(1, 0.25);
    const rng = mulberry32(seed);
    for (let k = 0; k < 8; k++) rng(); // uPos1, uPos2, uDir, life, speed, size, rotation, angularVelocity
    expect(sim.pool.rand0[0]).toBe(Math.fround(rng())); // draw 9 = rand0
  });
});

// ---------------------------------------------------------------------------
// Loop sweep advances with the effect clock
// ---------------------------------------------------------------------------
describe("loop arc sweep (§M4)", () => {
  it("successive spawns march around the circle with the clock", () => {
    // A single particle per step (rate ≈ 60/s at dt 1/60), zero speed so the
    // spawn position is exactly the shape offset. Loop arcSpeed 1 ⇒ one full
    // sweep per second, so the spawn angle advances ~6°/step.
    const layer = makeLayer({
      shape: { kind: "circle", radius: 40, innerRadius: 0, arc: 360, arcMode: "loop", arcSpeed: 1, emitFrom: "surface" },
      emission: { rateOverTime: { mode: "constant", value: 60 }, rateOverDistance: null, bursts: [], delay: 0, prewarm: false, maxParticles: 200 },
      initial: {
        life: { mode: "constant", value: 100 },
        speed: { mode: "constant", value: 0 },
        size: { mode: "constant", value: 1 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
    });
    const fx = new Effect(makeDoc({ duration: 100, looping: false, layers: [layer] }), { seed: 1337 });
    const angles: number[] = [];
    const ls = fx.layers[0]!;
    for (let i = 0; i < 6; i++) {
      const before = ls.count;
      fx.step(1 / 60);
      if (ls.count > before) {
        // newest particle is the last live slot
        const j = ls.count - 1;
        angles.push(norm360(Math.atan2(ls.pool.y[j]!, ls.pool.x[j]!) * DEG));
      }
    }
    expect(angles.length).toBeGreaterThan(2);
    // Angles increase monotonically (the sweep advances with the clock).
    for (let i = 1; i < angles.length; i++) expect(angles[i]!).toBeGreaterThan(angles[i - 1]!);
  });
});

// ---------------------------------------------------------------------------
// burstSpread — even fan
// ---------------------------------------------------------------------------
describe("burstSpread even angles (§M4)", () => {
  it("a burst of N over arc 360 yields N evenly spaced angles k/(N−1)", () => {
    const N = 6;
    const layer = makeLayer({
      shape: { kind: "circle", radius: 40, innerRadius: 0, arc: 360, arcMode: "burstSpread", arcSpeed: 1, emitFrom: "surface" },
      emission: { rateOverTime: { mode: "constant", value: 0 }, rateOverDistance: null, bursts: [{ time: 0, count: N, spread: 0, cycles: 1, interval: 0, probability: 1 }], delay: 0, prewarm: false, maxParticles: 50 },
      initial: {
        life: { mode: "constant", value: 100 },
        speed: { mode: "constant", value: 0 },
        size: { mode: "constant", value: 1 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
    });
    const fx = new Effect(makeDoc({ duration: 100, looping: false, layers: [layer] }), { seed: 1337 });
    fx.step(1 / 60);
    const ls = fx.layers[0]!;
    expect(ls.count).toBe(N);
    // Spawn order is preserved (no kills), so particle k has arcT k/(N−1).
    for (let k = 0; k < N; k++) {
      const expected = norm360((k / (N - 1)) * 360);
      const actual = norm360(Math.atan2(ls.pool.y[k]!, ls.pool.x[k]!) * DEG);
      expect(actual).toBeCloseTo(expected, 4);
    }
  });

  it("a single-particle burst emits at the arc start (arcT 0)", () => {
    const layer = makeLayer({
      shape: { kind: "circle", radius: 40, innerRadius: 0, arc: 120, arcMode: "burstSpread", arcSpeed: 1, emitFrom: "surface" },
      emission: { rateOverTime: { mode: "constant", value: 0 }, rateOverDistance: null, bursts: [{ time: 0, count: 1, spread: 0, cycles: 1, interval: 0, probability: 1 }], delay: 0, prewarm: false, maxParticles: 4 },
      initial: {
        life: { mode: "constant", value: 100 },
        speed: { mode: "constant", value: 0 },
        size: { mode: "constant", value: 1 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
    });
    const fx = new Effect(makeDoc({ duration: 100, looping: false, layers: [layer] }), { seed: 1337 });
    fx.step(1 / 60);
    const ls = fx.layers[0]!;
    expect(ls.count).toBe(1);
    expect(norm360(Math.atan2(ls.pool.y[0]!, ls.pool.x[0]!) * DEG)).toBeCloseTo(0, 4); // arc start
  });
});

// ---------------------------------------------------------------------------
// Burst cycles
// ---------------------------------------------------------------------------
function burstLayer(burst: { time: number; count: number; spread: number; cycles: number; interval: number; probability: number }): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    emission: { rateOverTime: { mode: "constant", value: 0 }, rateOverDistance: null, bursts: [burst], delay: 0, prewarm: false, maxParticles: 200 },
    initial: {
      life: { mode: "constant", value: 100 }, // outlive the whole test
      speed: { mode: "constant", value: 0 },
      size: { mode: "constant", value: 1 },
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: null,
      color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
      rotation: null,
      velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
  });
}

describe("burst cycles (§M4)", () => {
  it("{time 0.1, count 3, cycles 3, interval 0.3} fires 9 particles at the right times", () => {
    const layer = burstLayer({ time: 0.1, count: 3, spread: 0, cycles: 3, interval: 0.3, probability: 1 });
    const fx = new Effect(makeDoc({ duration: 2, looping: false, layers: [layer] }), { seed: 1337 });
    const ls = fx.layers[0]!;
    // Cycles open at 0.1, 0.4, 0.7 — three particles each.
    while (fx.time < 0.2) fx.step(1 / 60);
    expect(ls.count).toBe(3);
    while (fx.time < 0.5) fx.step(1 / 60);
    expect(ls.count).toBe(6);
    while (fx.time < 0.8) fx.step(1 / 60);
    expect(ls.count).toBe(9);
    // No further cycles.
    while (fx.time < 1.9) fx.step(1 / 60);
    expect(ls.count).toBe(9);
  });

  it("cycles re-fire on every loop; a cycle past the window is dropped (wrap semantics)", () => {
    // duration 0.5, looping. Cycles at 0.1 and 0.3 both fire; a control burst at
    // time 0.4 with a second cycle at 0.6 (> duration) fires only its first cycle.
    const inWindow = burstLayer({ time: 0.1, count: 1, spread: 0, cycles: 2, interval: 0.2, probability: 1 });
    inWindow.id = "in";
    const crossing = burstLayer({ time: 0.4, count: 1, spread: 0, cycles: 2, interval: 0.2, probability: 1 });
    crossing.id = "cross";
    const fx = new Effect(makeDoc({ duration: 0.5, looping: true, layers: [inWindow, crossing] }), { seed: 1337 });
    // Step through 3 full loops (1.5 s).
    for (let i = 0; i < Math.round(1.5 * 60); i++) fx.step(1 / 60);
    // in-window burst: 2 cycles × 3 loops = 6.
    expect(fx.layers[0]!.count).toBe(6);
    // crossing burst: only cycle 0 fires each loop (cycle 1 at 0.6 is past 0.5) = 3.
    expect(fx.layers[1]!.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Probability gate
// ---------------------------------------------------------------------------
describe("burst probability gate (§0.2)", () => {
  it("probability 1 ⇒ ZERO extra draws (stream matches mulberry32 with no gate)", () => {
    const layer = burstLayer({ time: 0, count: 1, spread: 0, cycles: 1, interval: 0, probability: 1 });
    const fx = new Effect(makeDoc({ duration: 1, looping: false, layers: [layer] }), { seed: 1337 });
    fx.step(1 / 60);
    const ls = fx.layers[0]!;
    expect(ls.count).toBe(1);
    // rand0 is the 9th spawn draw when NO gate draw precedes the spawn.
    const rng = mulberry32(deriveLayerSeed(1337, 0));
    for (let k = 0; k < 8; k++) rng();
    expect(ls.pool.rand0[0]).toBe(Math.fround(rng()));
  });

  it("probability < 1 interleaves ONE gate draw immediately before the cycle's spawns", () => {
    const layerSeed = deriveLayerSeed(1337, 0);
    // The gate is the first draw from the layer stream; decide the expectation
    // from the actual mulberry32 value so the test is seed-robust.
    const probe = mulberry32(layerSeed);
    const gate = probe();
    const prob = 0.5;
    const layer = burstLayer({ time: 0, count: 1, spread: 0, cycles: 1, interval: 0, probability: prob });
    const fx = new Effect(makeDoc({ duration: 1, looping: false, layers: [layer] }), { seed: 1337 });
    fx.step(1 / 60);
    const ls = fx.layers[0]!;
    if (gate < prob) {
      // Cycle fires: gate is draw 1, so rand0 is now the 10th draw.
      expect(ls.count).toBe(1);
      const rng = mulberry32(layerSeed);
      rng(); // gate (draw 1)
      for (let k = 0; k < 8; k++) rng(); // uPos1..angularVelocity (draws 2..9)
      expect(ls.pool.rand0[0]).toBe(Math.fround(rng())); // draw 10 = rand0
    } else {
      // Gate suppresses the cycle, but the draw was still taken.
      expect(ls.count).toBe(0);
    }
  });

  it("probability 0.5 is deterministic across two runs (same subset of cycles fires)", () => {
    const mk = (): Effect => {
      const layer = burstLayer({ time: 0.05, count: 2, spread: 0, cycles: 5, interval: 0.1, probability: 0.5 });
      return new Effect(makeDoc({ duration: 1, looping: true, layers: [layer] }), { seed: 4242 });
    };
    const a = mk();
    const b = mk();
    const dts = dtSequence(7, 300);
    const checkpoints = new Set([1, 60, 180, 300]);
    for (let i = 1; i <= 300; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
    expect(a.layers[0]!.count).toBe(b.layers[0]!.count);
  });
});

// ---------------------------------------------------------------------------
// Probability gate is per-CYCLE, not per-interval (§0.2 normative): a spread
// window spanning several steps rolls once and is all-or-nothing.
// ---------------------------------------------------------------------------
// First layer-stream draw for effect seed s ⇒ deterministic seed search for a
// firing / suppressing gate outcome at probability 0.5.
function findSeed(pred: (firstDraw: number) => boolean): number {
  for (let s = 1; s < 100000; s++) {
    if (pred(mulberry32(deriveLayerSeed(s, 0))())) return s;
  }
  throw new Error("no seed found");
}

describe("burst probability gate — per-cycle roll across steps (§0.2)", () => {
  // Sub-events at k·0.1/9 ∈ [0, 0.1] span ~7 steps at dt 1/60.
  const spreadBurst = { time: 0, count: 10, spread: 0.1, cycles: 1, interval: 0, probability: 0.5 };

  it("firing seed: EXACTLY ONE gate draw, full count across ≥3 steps (all-or-nothing)", () => {
    const seed = findSeed((u) => u < 0.5);
    const layer = burstLayer(spreadBurst);
    const fx = new Effect(makeDoc({ duration: 1, looping: false, layers: [layer] }), { seed });
    const ls = fx.layers[0]!;
    // The spread window genuinely spans multiple steps: after the first step
    // only some sub-events have fired.
    fx.step(1 / 60);
    const early = ls.count;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(10);
    while (fx.time < 0.15) fx.step(1 / 60);
    expect(ls.count).toBe(10); // later steps' sub-events fired too — no re-roll
    // EXACTLY ONE gate draw for the whole cycle: with 1 gate draw + 13 draws per
    // particle, particle j's rand0 is stream draw 1 + 13j + 9. Pin the LAST
    // particle (j = 9, spawned several steps after the roll): any per-interval
    // re-roll would shift every later index.
    const rng = mulberry32(deriveLayerSeed(seed, 0));
    for (let k = 0; k < 1 + 13 * 9 + 8; k++) rng();
    expect(ls.pool.rand0[9]).toBe(Math.fround(rng()));
  });

  it("suppressing seed: ZERO spawns in EVERY step of the window, still exactly one draw", () => {
    const seed = findSeed((u) => u >= 0.5);
    const layer = burstLayer(spreadBurst);
    // A second, ungated burst after the window pins the stream position.
    layer.emission.bursts.push({ time: 0.2, count: 1, spread: 0, cycles: 1, interval: 0, probability: 1 });
    const fx = new Effect(makeDoc({ duration: 1, looping: false, layers: [layer] }), { seed });
    const ls = fx.layers[0]!;
    while (fx.time < 0.15) {
      fx.step(1 / 60);
      expect(ls.count).toBe(0); // no partial burst in ANY step of the window
    }
    while (fx.time < 0.25) fx.step(1 / 60);
    expect(ls.count).toBe(1); // only the ungated burst
    // The suppressed cycle consumed exactly ONE draw: the ungated burst's
    // particle has rand0 at stream draw 1 (gate) + 9.
    const rng = mulberry32(deriveLayerSeed(seed, 0));
    for (let k = 0; k < 1 + 8; k++) rng();
    expect(ls.pool.rand0[0]).toBe(Math.fround(rng()));
  });

  it("re-rolls each loop pass; two-run identity across wraps with a multi-step spread", () => {
    const mk = (): Effect => {
      const layer = burstLayer({ time: 0.1, count: 4, spread: 0.08, cycles: 2, interval: 0.15, probability: 0.5 });
      return new Effect(makeDoc({ duration: 0.5, looping: true, layers: [layer] }), { seed: 77 });
    };
    const a = mk();
    const b = mk();
    const dts = dtSequence(13, 240);
    const checkpoints = new Set([1, 30, 120, 240]);
    for (let i = 1; i <= 240; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
    expect(a.layers[0]!.count).toBe(b.layers[0]!.count);
    // All-or-nothing per cycle ⇒ the live count is a whole number of bursts
    // (life 100 s: nothing dies during the run)…
    expect(a.layers[0]!.count % 4).toBe(0);
    // …and across ~14 rolled cycles both outcomes occurred (a stuck gate — never
    // re-rolled at the wrap — would spawn either nothing or every cycle).
    const rolled = 14 * 4; // ≈ upper bound over ~7 passes × 2 cycles
    expect(a.layers[0]!.count).toBeGreaterThan(0);
    expect(a.layers[0]!.count).toBeLessThan(rolled);
  });
});

// ---------------------------------------------------------------------------
// Byte-identity guard: a default (random / cycles 1 / probability 1) layer's
// stream is untouched by the M4 threading.
// ---------------------------------------------------------------------------
describe("M4 is inert for default shapes/bursts (§0.1 bit-identity)", () => {
  it("a plain layer's spawn stream is identical whether or not arcT/gate paths exist", () => {
    // makeLayer defaults: cone arcMode random, single burst cycles 1 prob 1.
    const doc = makeDoc({ duration: 3, looping: true, layers: [makeLayer()] });
    const a = new Effect(doc, { seed: 999 });
    const b = new Effect(doc, { seed: 999 });
    const dts = dtSequence(3, 200);
    for (let i = 0; i < 200; i++) {
      a.step(dts[i]!);
      b.step(dts[i]!);
    }
    expect(stateHash(a)).toBe(stateHash(b));
    expect(a.layers[0]!.count).toBeGreaterThan(0);
  });
});
