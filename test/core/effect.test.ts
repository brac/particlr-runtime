import { describe, it, expect } from "vitest";
import { Effect, MAX_DT, type SparkDoc, type Layer } from "../../src/index.js";
import { makeDoc, makeLayer } from "../format/_helpers.js";

// A layer with no continuous emission and no bursts, tuned per-test.
function layer(over: Partial<Layer> = {}): Layer {
  const base = makeLayer();
  return {
    ...base,
    shape: { kind: "point", emitFrom: "volume" },
    emission: { rateOverTime: { mode: "constant", value: 0 }, bursts: [], delay: 0, prewarm: false, maxParticles: 1000 },
    initial: { ...base.initial, life: { mode: "constant", value: 100 }, speed: { mode: "constant", value: 0 } },
    ...over,
  };
}
function doc(l: Layer, over: Partial<SparkDoc> = {}): SparkDoc {
  return makeDoc({ layers: [l], ...over });
}

describe("Effect — dt clamping", () => {
  it("E1: dt > maxDt is clamped (emission and clock)", () => {
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 100 }, bursts: [], delay: 0, prewarm: false, maxParticles: 1000 } });
    const fx = new Effect(doc(l, { looping: false, duration: 10 }));
    fx.step(1); // one giant step
    expect(fx.time).toBeCloseTo(MAX_DT, 9); // 0.05, not 1
    expect(fx.particleCount).toBe(5); // floor(100 * 0.05)
  });

  it("E2: dt <= 0 is a no-op", () => {
    const fx = new Effect(doc(layer({ emission: { rateOverTime: { mode: "constant", value: 100 }, bursts: [], delay: 0, prewarm: false, maxParticles: 1000 } })));
    fx.step(0);
    fx.step(-1);
    expect(fx.time).toBe(0);
    expect(fx.particleCount).toBe(0);
  });
});

describe("Effect — bursts", () => {
  it("fires a burst at t=0 on the first step, exactly once", () => {
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 0 }, bursts: [{ time: 0, count: 10, spread: 0 }], delay: 0, prewarm: false, maxParticles: 1000 } });
    const fx = new Effect(doc(l, { looping: false, duration: 10 }));
    fx.step(1 / 60);
    expect(fx.particleCount).toBe(10);
    fx.step(1 / 60);
    expect(fx.particleCount).toBe(10); // does not re-fire mid-cycle
  });

  it("re-fires the burst on each loop cycle", () => {
    // duration == MAX_DT so exactly one clamped step advances one full cycle.
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 0 }, bursts: [{ time: 0, count: 3, spread: 0 }], delay: 0, prewarm: false, maxParticles: 1000 } });
    const fx = new Effect(doc(l, { looping: true, duration: MAX_DT }));
    fx.step(MAX_DT);
    expect(fx.particleCount).toBe(3);
    fx.step(MAX_DT);
    expect(fx.particleCount).toBe(6);
    fx.step(MAX_DT);
    expect(fx.particleCount).toBe(9);
  });

  it("E7: burst beyond maxParticles is capped and flags the layer", () => {
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 0 }, bursts: [{ time: 0, count: 100, spread: 0 }], delay: 0, prewarm: false, maxParticles: 10 } });
    const fx = new Effect(doc(l, { looping: false, duration: 10 }));
    fx.step(1 / 60);
    expect(fx.particleCount).toBe(10);
    expect(fx.layers[0]!.capped).toBe(true);
  });
});

describe("Effect — continuous accumulator (§2.8)", () => {
  it("emits floor(integral of rate) across an odd dt sequence", () => {
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 10 }, bursts: [], delay: 0, prewarm: false, maxParticles: 10000 } });
    const fx = new Effect(doc(l, { looping: false, duration: 1000 }));
    let total = 0;
    for (let i = 0; i < 100; i++) {
      fx.step(1 / 60);
      total += 1 / 60;
    }
    expect(fx.particleCount).toBe(Math.floor(10 * total));
  });
});

describe("Effect — prewarm (E5)", () => {
  it("prewarm fills continuous emission before the first visible frame", () => {
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 10 }, bursts: [], delay: 0, prewarm: true, maxParticles: 10000 } });
    const fx = new Effect(doc(l, { looping: true, duration: 0.5 }));
    expect(fx.time).toBe(0);
    expect(fx.particleCount).toBeGreaterThan(0);
  });

  it("without prewarm the pool starts empty", () => {
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 10 }, bursts: [], delay: 0, prewarm: false, maxParticles: 10000 } });
    const fx = new Effect(doc(l, { looping: true, duration: 0.5 }));
    expect(fx.particleCount).toBe(0);
  });

  it("suppresses bursts during prewarm; the t=0 burst fires on the first visible step", () => {
    // rate 0 => prewarm produces nothing; a burst at 0 must NOT fire during
    // prewarm, only on the first visible step.
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 0 }, bursts: [{ time: 0, count: 5, spread: 0 }], delay: 0, prewarm: true, maxParticles: 1000 } });
    const fx = new Effect(doc(l, { looping: true, duration: 0.3 }));
    expect(fx.particleCount).toBe(0); // burst suppressed during prewarm
    fx.step(1 / 60);
    expect(fx.particleCount).toBe(5); // fires on the visible cycle
  });
});

describe("Effect — isDone (E6)", () => {
  it("non-looping: emitters stop, particles live out, isDone when count hits 0", () => {
    const l = layer({
      emission: { rateOverTime: { mode: "constant", value: 0 }, bursts: [{ time: 0, count: 3, spread: 0 }], delay: 0, prewarm: false, maxParticles: 100 },
      initial: { ...makeLayer().initial, life: { mode: "constant", value: 0.05 }, speed: { mode: "constant", value: 0 } },
    });
    const fx = new Effect(doc(l, { looping: false, duration: 0.1 }));
    expect(fx.isDone).toBe(false);
    fx.step(1 / 60); // fire burst
    expect(fx.particleCount).toBe(3);
    for (let i = 0; i < 30; i++) fx.step(1 / 60);
    expect(fx.particleCount).toBe(0);
    expect(fx.isDone).toBe(true);
  });

  it("looping is never done", () => {
    const fx = new Effect(doc(layer(), { looping: true }));
    for (let i = 0; i < 100; i++) fx.step(1 / 60);
    expect(fx.isDone).toBe(false);
  });
});

describe("Effect — reset & determinism handles", () => {
  it("reset rewinds the clock and reproduces state for the same seed", () => {
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 30 }, bursts: [], delay: 0, prewarm: false, maxParticles: 10000 } });
    const fx = new Effect(doc(l, { looping: true, duration: 2 }), { seed: 99 });
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    const count1 = fx.particleCount;
    const x1 = Array.from(fx.layers[0]!.pool.x.slice(0, count1));
    fx.reset();
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.particleCount).toBe(count1);
    expect(Array.from(fx.layers[0]!.pool.x.slice(0, count1))).toEqual(x1);
  });
});
