import { describe, it, expect } from "vitest";
import { LayerSim, Effect, deriveLayerSeed, mulberry32, type Layer, type StartColor, type GradientTrack } from "../../src/index.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";

const seed = deriveLayerSeed(1337, 0);

// A minimal point-shape, zero-speed, effectively-immortal layer so spawn draws
// are isolated. `startColor`/`randomFlip` are merged in per test.
function scLayer(extra: Partial<Layer> = {}): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
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
    ...extra,
  });
}

// Single-key gradients whose lerp reduces to the drawn uniform: a=(0,0,0,0),
// b=(1,1,1,1) ⇒ tint channel = u exactly, so draw 19 is directly pinnable.
const gA: GradientTrack = { keys: [{ t: 0, r: 0, g: 0, b: 0, a: 0 }] };
const gB: GradientTrack = { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] };
const uniformStartColor: StartColor = { mode: "gradients", a: gA, b: gB };

const ct = (value: number) => ({ mode: "constant" as const, value });

describe("start color + random flip — draw-count matrix (§0.2, M5)", () => {
  it("startColor null + randomFlip null ⇒ zero extra draws, no columns (twin pin)", () => {
    const plain = new LayerSim(makeLayer(), seed);
    const bare = new LayerSim(scLayer(), seed);
    expect(bare.pool.tintR).toBeNull();
    expect(bare.pool.flipBits).toBeNull();
    plain.spawn();
    plain.spawn();
    bare.spawn();
    bare.spawn();
    // Same 13 standard draws per spawn ⇒ the second particle's first uniform lines up.
    expect(bare.pool.rand0[1]).toBe(plain.pool.rand0[1]);
  });

  it("startColor-only ⇒ exactly 1 extra draw (draw 19 pinned at index 13)", () => {
    const sim = new LayerSim(scLayer({ startColor: uniformStartColor }), seed);
    expect(sim.pool.tintR).not.toBeNull();
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng(); // the 13 standard spawn draws
    // tint = lerp(a=(0..), b=(1..), u) = u ⇒ draw 19 is the tint uniform.
    expect(sim.pool.tintR![0]).toBe(Math.fround(rng())); // draw 19
  });

  it("startColor-only shifts the NEXT spawn's stream by exactly one draw", () => {
    const plain = new LayerSim(scLayer(), seed);
    const sc = new LayerSim(scLayer({ startColor: uniformStartColor }), seed);
    plain.spawn();
    plain.spawn();
    sc.spawn();
    sc.spawn();
    expect(sc.pool.rand0[1]).not.toBe(plain.pool.rand0[1]);
  });

  it("randomFlip-only ⇒ exactly 2 extra draws (draws 20–21 pinned at indices 13,14)", () => {
    const sim = new LayerSim(scLayer({ randomFlip: { x: 0.5, y: 0.5 } }), seed);
    expect(sim.pool.flipBits).not.toBeNull();
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng();
    const ux = rng(); // draw 20
    const uy = rng(); // draw 21
    const expected = (ux < 0.5 ? 1 : 0) | (uy < 0.5 ? 2 : 0);
    expect(sim.pool.flipBits![0]).toBe(expected);
  });

  it("both + noise + all four vel tracks ⇒ draws 14–21 pinned in order", () => {
    const noise = { strength: ct(10), frequency: 0.02, scrollSpeed: 0, octaves: 1 };
    const layer = scLayer({
      noise,
      startColor: uniformStartColor,
      randomFlip: { x: 0.5, y: 0.5 },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: ct(1), y: ct(2), orbital: ct(3), radial: ct(4) },
      },
    });
    const sim = new LayerSim(layer, seed);
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng();
    expect(sim.pool.noisePhase![0]).toBe(Math.fround(rng())); // draw 14
    expect(sim.pool.velRandX![0]).toBe(Math.fround(rng())); // draw 15
    expect(sim.pool.velRandY![0]).toBe(Math.fround(rng())); // draw 16
    expect(sim.pool.velRandOrbital![0]).toBe(Math.fround(rng())); // draw 17
    expect(sim.pool.velRandRadial![0]).toBe(Math.fround(rng())); // draw 18
    expect(sim.pool.tintR![0]).toBe(Math.fround(rng())); // draw 19
    const ux = rng(); // draw 20
    const uy = rng(); // draw 21
    expect(sim.pool.flipBits![0]).toBe((ux < 0.5 ? 1 : 0) | (uy < 0.5 ? 2 : 0));
  });
});

describe("start color — palette (§M5)", () => {
  const palette: StartColor = {
    mode: "palette",
    colors: [
      { r: 0.1, g: 0, b: 0, a: 1 },
      { r: 0.2, g: 0, b: 0, a: 1 },
      { r: 0.3, g: 0, b: 0, a: 1 },
      { r: 0.4, g: 0, b: 0, a: 1 },
    ],
  };

  it("picks colors[min(n−1, floor(u·n))] — reconstructed index matches the stored tint", () => {
    const sim = new LayerSim(scLayer({ startColor: palette }), seed);
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng();
    const u = rng();
    const n = palette.colors.length;
    const idx = Math.min(n - 1, Math.floor(u * n));
    expect(sim.pool.tintR![0]).toBe(Math.fround(palette.colors[idx]!.r));
  });

  // A big pool so thousands of spawns actually land (default cap is 256).
  const bigPool = (): Partial<Layer> => ({
    startColor: palette,
    emission: { rateOverTime: ct(0), rateOverDistance: null, bursts: [], delay: 0, prewarm: false, maxParticles: 5000 },
  });

  it("never indexes past the last entry: every spawn's tint is a palette member (u→1 clamp)", () => {
    // mulberry32 emits [0,1); the min() guards the theoretical u→1 that would floor
    // to n. Over many spawns, prove no index n (undefined) ever leaks through.
    const sim = new LayerSim(scLayer(bigPool()), seed);
    const rSet = new Set(palette.colors.map((c) => Math.fround(c.r)));
    for (let i = 0; i < 4000; i++) sim.spawn();
    for (let i = 0; i < sim.count; i++) {
      expect(rSet.has(sim.pool.tintR![i]!)).toBe(true);
      expect(Number.isNaN(sim.pool.tintR![i]!)).toBe(false);
    }
  });

  it("is roughly equal-probability across the palette over many spawns", () => {
    const sim = new LayerSim(scLayer(bigPool()), seed);
    for (let i = 0; i < 4000; i++) sim.spawn();
    const counts = new Map<number, number>();
    for (let i = 0; i < sim.count; i++) {
      const key = sim.pool.tintR![i]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(palette.colors.length); // all four appear
    const expected = sim.count / palette.colors.length;
    for (const c of counts.values()) expect(Math.abs(c - expected)).toBeLessThan(expected * 0.2);
  });
});

describe("start color — gradients lerp (§M5)", () => {
  it("lerps evalGradient(a) and evalGradient(b) by the drawn uniform (hand-computed)", () => {
    const a: GradientTrack = { keys: [{ t: 0, r: 0.2, g: 0.4, b: 0.6, a: 0.8 }] };
    const b: GradientTrack = { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] };
    const sim = new LayerSim(scLayer({ startColor: { mode: "gradients", a, b } }), seed);
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng();
    const u = rng();
    expect(sim.pool.tintR![0]).toBeCloseTo(0.2 + (1 - 0.2) * u, 5);
    expect(sim.pool.tintG![0]).toBeCloseTo(0.4 + (1 - 0.4) * u, 5);
    expect(sim.pool.tintB![0]).toBeCloseTo(0.6 + (1 - 0.6) * u, 5);
    expect(sim.pool.tintA![0]).toBeCloseTo(0.8 + (1 - 0.8) * u, 5);
  });

  it("samples the gradients at the emission-interval start time (tSpawnNorm)", () => {
    // Two bursts at t=0 and t=1 of a 2s effect, with identical time-ramping
    // gradients (a===b ⇒ lerp collapses to evalGradient(a, tSpawnNorm), u-independent).
    // r ramps 0→1 over the effect, so the two burst waves carry distinct tints.
    const ramp: GradientTrack = { keys: [{ t: 0, r: 0, g: 1, b: 1, a: 1 }, { t: 1, r: 1, g: 1, b: 1, a: 1 }] };
    const layer = scLayer({
      startColor: { mode: "gradients", a: ramp, b: ramp },
      emission: {
        rateOverTime: ct(0),
        rateOverDistance: null,
        bursts: [
          { time: 0, count: 6, spread: 0, cycles: 1, interval: 0, probability: 1 },
          { time: 1, count: 6, spread: 0, cycles: 1, interval: 0, probability: 1 },
        ],
        delay: 0,
        prewarm: false,
        maxParticles: 64,
      },
    });
    const fx = new Effect(makeDoc({ duration: 2, looping: false, layers: [layer] }), { seed: 1337 });
    for (let i = 0; i < 90; i++) fx.step(1 / 60); // past t=1 (frame 90 ≈ 1.5s)
    const p = fx.layers[0]!.pool;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < fx.layers[0]!.count; i++) {
      min = Math.min(min, p.tintR![i]!);
      max = Math.max(max, p.tintR![i]!);
    }
    expect(min).toBeLessThan(0.02); // t=0 wave: r≈0
    expect(max).toBeGreaterThan(0.4); // t≈0.49 wave: r≈0.49
  });
});

describe("random flip — determinism (§M5)", () => {
  it("flip bits are bit-identical across two runs from the same seed", () => {
    const layer = scLayer({ randomFlip: { x: 0.5, y: 0.5 } });
    const a = new LayerSim(layer, seed);
    const b = new LayerSim(layer, seed);
    for (let i = 0; i < 200; i++) {
      a.spawn();
      b.spawn();
    }
    expect(a.count).toBe(b.count);
    expect(Array.from(a.pool.flipBits!.slice(0, a.count))).toEqual(Array.from(b.pool.flipBits!.slice(0, b.count)));
    // With x=y=0.5 both bit patterns 0..3 should occur.
    expect(new Set(Array.from(a.pool.flipBits!.slice(0, a.count))).size).toBeGreaterThan(1);
  });

  it("probabilities gate the bits: x=1,y=0 always flips X, never Y", () => {
    const sim = new LayerSim(scLayer({ randomFlip: { x: 1, y: 0 } }), seed);
    for (let i = 0; i < 100; i++) sim.spawn();
    for (let i = 0; i < sim.count; i++) {
      expect(sim.pool.flipBits![i]! & 1).toBe(1); // X always set
      expect(sim.pool.flipBits![i]! & 2).toBe(0); // Y never set
    }
  });
});

describe("render — tint multiply + flip buffer (§M5)", () => {
  function simWithLive(extra: Partial<Layer>, tint: { velX?: number } = {}): LayerSim {
    const ls = new LayerSim(scLayer(extra), seed);
    const i = ls.pool.spawn();
    ls.pool.age[i] = 0;
    ls.pool.lifetime[i] = 1;
    ls.pool.sizeInit[i] = 10;
    if (tint.velX !== undefined) ls.pool.velX[i] = tint.velX;
    return ls;
  }

  it("startColor multiplies the over-lifetime gradient RGBA per channel", () => {
    const palette: StartColor = { mode: "palette", colors: [{ r: 0.5, g: 0.25, b: 0.75, a: 0.5 }] };
    // over-lifetime color is white a=1 at t=0, so buffer = 1 × tint.
    const ls = simWithLive({ startColor: palette });
    // startColor stored at spawn; override the pool tint to a known value.
    ls.pool.tintR![0] = 0.5;
    ls.pool.tintG![0] = 0.25;
    ls.pool.tintB![0] = 0.75;
    ls.pool.tintA![0] = 0.5;
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.r[0]).toBeCloseTo(0.5, 6);
    expect(buf.g[0]).toBeCloseTo(0.25, 6);
    expect(buf.b[0]).toBeCloseTo(0.75, 6);
    expect(buf.a[0]).toBeCloseTo(0.5, 6);
  });

  it("randomFlip fills the flip buffer from pool.flipBits", () => {
    const ls = simWithLive({ randomFlip: { x: 0.5, y: 0.5 } });
    ls.pool.flipBits![0] = 3;
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.flip[0]).toBe(3);
  });

  it("randomFlip null but render non-null ⇒ flip buffer reads 0 (extended body valid)", () => {
    const ls = simWithLive({ render: { align: "none", speedScale: 0, minStretch: 1, maxStretch: 2 } });
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.flip[0]).toBe(0);
  });
});
