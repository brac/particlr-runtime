import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseParticle, validateParticle, MAX_BURST_CYCLES } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { presetsDir, hasPresets } from "../_presets.js";

function loadDoc(name: string) {
  const raw = readFileSync(resolve(presetsDir, `${name}.prt`), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid`);
  return structuredClone(parsed.doc!);
}

describe.skipIf(!hasPresets)("spawn-loop clamps (P1.3)", () => {
  it("a hostile continuous rate fills the pool once and does not hang", () => {
    const doc = loadDoc("fire");
    doc.layers[0]!.emission.rateOverTime = { mode: "constant", value: 1e15 };
    doc.layers[0]!.emission.maxParticles = 500;
    const fx = new Effect(doc, { seed: doc.seed });

    const t0 = performance.now();
    fx.step(1 / 60);
    const elapsed = performance.now() - t0;

    expect(fx.layers[0]!.count).toBe(500); // filled to capacity, not 5e13
    expect(fx.layers[0]!.capped).toBe(true);
    expect(elapsed).toBeLessThan(50); // no trillion-iteration spin
  });

  it("a hostile burst count fills the pool once and does not hang", () => {
    const doc = loadDoc("sparks");
    doc.layers[0]!.emission.bursts = [{ time: 0, count: 2147483647, spread: 0 }];
    doc.layers[0]!.emission.maxParticles = 300;
    const fx = new Effect(doc, { seed: doc.seed });

    const t0 = performance.now();
    fx.step(1 / 60);
    const elapsed = performance.now() - t0;

    expect(fx.layers[0]!.count).toBe(300);
    expect(fx.layers[0]!.capped).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  // F-2/S-6: hosts can build Effects from UNVALIDATED docs, so the cycle loop must
  // clamp its bound to MAX_BURST_CYCLES the same way count is clamped to capacity.
  it("a hostile burst cycles count runs at most MAX_BURST_CYCLES cycles and does not hang", () => {
    const doc = loadDoc("sparks");
    // interval 0 ⇒ every clamped cycle fires one sub-event at t=0 within this step;
    // capacity (20000) is above the cycle cap so the CLAMP, not the pool, sets count.
    doc.layers[0]!.emission.bursts = [
      { time: 0, count: 1, spread: 0, cycles: 9007199254740991, interval: 0, probability: 1 },
    ];
    doc.layers[0]!.emission.maxParticles = 20000;
    const fx = new Effect(doc, { seed: doc.seed });

    const t0 = performance.now();
    fx.step(1 / 60);
    const elapsed = performance.now() - t0;

    expect(fx.layers[0]!.count).toBe(MAX_BURST_CYCLES); // exactly the clamp, not 9e15
    expect(fx.layers[0]!.capped).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});

// Determinism guard (F-2/S-6): the cycle clamp is Math.min(cycles, MAX_BURST_CYCLES),
// a no-op for any cycles the validator accepts, so an in-range burst doc must emit
// exactly as before. Pins the emitted count of a small multi-cycle burst.
describe.skipIf(!hasPresets)("cycle clamp preserves in-range emission (F-2/S-6)", () => {
  it("a 3-cycle burst emits an identical particle count", () => {
    const doc = loadDoc("sparks");
    doc.looping = false;
    doc.duration = 2;
    doc.layers = [doc.layers[0]!];
    doc.layers[0]!.emission.rateOverTime = { mode: "constant", value: 0 }; // bursts only
    doc.layers[0]!.emission.bursts = [
      { time: 0, count: 5, spread: 0, cycles: 3, interval: 0.5, probability: 1 },
    ];
    doc.layers[0]!.emission.maxParticles = 10000;
    doc.layers[0]!.initial.life = { mode: "constant", value: 5 }; // all 15 coexist
    const fx = new Effect(doc, { seed: doc.seed });
    // Step past all three cycles (0, 0.5, 1.0s) but keep particles alive.
    let peak = 0;
    for (let i = 0; i < 80; i++) {
      fx.step(1 / 60);
      peak = Math.max(peak, fx.layers[0]!.count);
    }
    expect(peak).toBe(15); // 3 cycles × 5 = 15 particles, unchanged by the clamp
  });
});

describe.skipIf(!hasPresets)("validation ceilings (P1.3)", () => {
  it("rejects a rate above the ceiling", () => {
    const doc = loadDoc("fire");
    doc.layers[0]!.emission.rateOverTime = { mode: "constant", value: 1e15 };
    const res = validateParticle(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /rate must be <=/.test(e.message))).toBe(true);
  });

  it("rejects a burst count above the ceiling", () => {
    const doc = loadDoc("sparks");
    doc.layers[0]!.emission.bursts = [{ time: 0, count: 20000, spread: 0 }];
    const res = validateParticle(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /count must be an integer/.test(e.message))).toBe(true);
  });

  it("still accepts a normal rate and burst count", () => {
    const doc = loadDoc("explosion");
    expect(validateParticle(doc).ok).toBe(true);
  });
});
