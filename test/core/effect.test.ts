import { describe, it, expect } from "vitest";
import { Effect, MAX_DT, type ParticleDoc, type Layer } from "../../src/index.js";
import { makeDoc, makeLayer } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

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
function doc(l: Layer, over: Partial<ParticleDoc> = {}): ParticleDoc {
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

// A gravity + noise + bursts + continuous world-space doc that exercises PRNG,
// motion integration, the noise field, and emitter-velocity — the load-bearing
// fixture for the timeScale equivalence law.
function eqDoc(): ParticleDoc {
  const l = makeLayer({
    space: "world",
    noise: { strength: { mode: "constant", value: 30 }, frequency: 1.2, scrollSpeed: 0.6, octaves: 2 },
  });
  return makeDoc({ layers: [l], looping: false, duration: 10 });
}

describe("Effect — timeScale (host API)", () => {
  it("equivalence law: timeScale=s; step(dt) ≡ timeScale=1; step(dt·s) (stateHash)", () => {
    const a = new Effect(eqDoc(), { seed: 7 }); // scaled via timeScale
    const b = new Effect(eqDoc(), { seed: 7 }); // scaled via dt (control)
    a.timeScale = 0.5;
    const seq = dtSequence(123, 40); // all < MAX_DT even before scaling ⇒ exact
    const checkpoints = new Set([9, 19, 29, 39]);
    seq.forEach((dt, i) => {
      // Same absolute emitter target in both runs (a host input, not dt-scaled):
      // its implied velocity divides by the same scaled dt in each, so the
      // world-space spawn stream stays bit-identical.
      const ex = 100 + i * 3;
      a.setEmitterPosition(ex, 0);
      a.step(dt);
      b.setEmitterPosition(ex, 0);
      b.step(dt * 0.5);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    });
  });

  it("timeScale = 1 is the IEEE identity (byte-identical to never setting it)", () => {
    const a = new Effect(eqDoc(), { seed: 7 });
    const b = new Effect(eqDoc(), { seed: 7 });
    b.timeScale = 1;
    for (const dt of dtSequence(99, 30)) {
      a.step(dt);
      b.step(dt);
    }
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it("timeScale = 0 freezes: state + clock unchanged; a pending emitter target survives", () => {
    const fx = new Effect(eqDoc(), { seed: 7 });
    for (const dt of dtSequence(5, 12)) fx.step(dt); // build some live state
    const frozen = stateHash(fx);
    const t0 = fx.time;
    fx.timeScale = 0;
    fx.setEmitterPosition(500, 250); // queued while frozen
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    expect(stateHash(fx)).toBe(frozen); // nothing moved or aged
    expect(fx.time).toBe(t0); // clock frozen
    expect(fx.emitterX).toBe(0); // target NOT applied while paused
    expect(fx.emitterY).toBe(0);
    // Unfreeze: the still-pending target applies on the next real step.
    fx.timeScale = 1;
    fx.step(1 / 60);
    expect(fx.emitterX).toBe(500);
    expect(fx.emitterY).toBe(250);
  });

  it("clamp composition: timeScale 3 × step(1/30) ≡ step(MAX_DT) (fast-forward can't defeat E1)", () => {
    const a = new Effect(eqDoc(), { seed: 7 });
    const b = new Effect(eqDoc(), { seed: 7 });
    a.timeScale = 3;
    for (let i = 0; i < 15; i++) {
      a.step(1 / 30); // 3 · 1/30 = 0.1 > MAX_DT ⇒ clamps to MAX_DT
      b.step(MAX_DT);
    }
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it("setter normalizes non-finite / ≤0 to 0 (paused); a positive value restores", () => {
    const fx = new Effect(eqDoc());
    fx.timeScale = -1;
    expect(fx.timeScale).toBe(0);
    fx.timeScale = NaN;
    expect(fx.timeScale).toBe(0);
    fx.timeScale = Infinity;
    expect(fx.timeScale).toBe(0);
    fx.timeScale = -Infinity;
    expect(fx.timeScale).toBe(0);
    fx.timeScale = 0;
    expect(fx.timeScale).toBe(0);
    fx.timeScale = 2.5;
    expect(fx.timeScale).toBe(2.5);
  });

  it("timeScale persists across reset()", () => {
    const fx = new Effect(eqDoc());
    fx.timeScale = 0.5;
    fx.reset();
    expect(fx.timeScale).toBe(0.5);
  });
});

// A short non-looping doc that finishes: a t=0 burst of short-lived particles,
// no continuous emission — reaches isDone (E6) after a handful of steps.
function doneDoc(): ParticleDoc {
  const l = layer({
    emission: { rateOverTime: { mode: "constant", value: 0 }, bursts: [{ time: 0, count: 3, spread: 0 }], delay: 0, prewarm: false, maxParticles: 100 },
    initial: { ...makeLayer().initial, life: { mode: "constant", value: 0.05 }, speed: { mode: "constant", value: 0 } },
  });
  return doc(l, { looping: false, duration: 0.1 });
}

describe("Effect — onDone (host API)", () => {
  it("fires exactly once, on the step where isDone flips (never re-fires)", () => {
    const fx = new Effect(doneDoc());
    let calls = 0;
    fx.onDone = () => calls++;
    fx.step(1 / 60);
    expect(fx.isDone).toBe(false);
    expect(calls).toBe(0); // still running
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.isDone).toBe(true);
    expect(calls).toBe(1); // fired once
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    expect(calls).toBe(1); // and never again
  });

  it("a looping effect never fires onDone", () => {
    const fx = new Effect(doc(layer(), { looping: true }));
    let calls = 0;
    fx.onDone = () => calls++;
    for (let i = 0; i < 200; i++) fx.step(1 / 60);
    expect(calls).toBe(0);
  });

  it("late attach: a callback set AFTER the effect finished fires on the next step, once", () => {
    const fx = new Effect(doneDoc());
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.isDone).toBe(true);
    let calls = 0;
    fx.onDone = () => calls++; // attach after already done
    fx.step(1 / 60);
    expect(calls).toBe(1); // latch-on-fire, not on transition
    fx.step(1 / 60);
    expect(calls).toBe(1);
  });

  it("reset() re-arms onDone (fires again after a second playthrough)", () => {
    const fx = new Effect(doneDoc());
    let calls = 0;
    fx.onDone = () => calls++;
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(calls).toBe(1);
    fx.reset();
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(calls).toBe(2);
  });

  it("fires after state commit: inside the callback isDone is true and particleCount is 0", () => {
    const fx = new Effect(doneDoc());
    let seenDone = false;
    let seenCount = -1;
    fx.onDone = () => {
      seenDone = fx.isDone;
      seenCount = fx.particleCount;
    };
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(seenDone).toBe(true);
    expect(seenCount).toBe(0);
  });

  it("a callback that calls reset() is safe (re-arms; the fresh playthrough also completes)", () => {
    const fx = new Effect(doneDoc());
    let calls = 0;
    // Reset only on the first completion; the second playthrough finishes and
    // fires once more (doneFired stays latched thereafter).
    fx.onDone = () => {
      calls++;
      if (calls === 1) fx.reset();
    };
    for (let i = 0; i < 80; i++) fx.step(1 / 60);
    expect(calls).toBe(2);
  });

  it("attaching a (non-mutating) onDone does not change the simulation (stateHash)", () => {
    const a = new Effect(doneDoc(), { seed: 42 });
    const b = new Effect(doneDoc(), { seed: 42 });
    b.onDone = () => void b.isDone; // observe only
    for (let i = 0; i < 40; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it("prewarm (advance, not step) never fires onDone", () => {
    // onDone is null during construction, so prewarm-on-construct trivially can't
    // fire; this asserts the invariant on reset()'s re-prewarm path too, since
    // runPrewarm uses advance() and never the step() tail that fires the callback.
    const l = layer({ emission: { rateOverTime: { mode: "constant", value: 10 }, bursts: [], delay: 0, prewarm: true, maxParticles: 1000 } });
    const fx = new Effect(doc(l, { looping: false, duration: 0.5 }));
    let calls = 0;
    fx.onDone = () => calls++;
    fx.reset(); // re-runs prewarm via advance()
    expect(calls).toBe(0);
  });
});
