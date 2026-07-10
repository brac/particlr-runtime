import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseParticle, validateParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { presetsDir, hasPresets } from "../_presets.js";

function baseDoc() {
  // Start from a real preset and strip it to a single, controllable layer.
  const doc = structuredClone(parseParticle(readFileSync(resolve(presetsDir, "sparks.prt"), "utf8")).doc!);
  return doc;
}

describe.skipIf(!hasPresets)("burst spread endpoint (P2.2)", () => {
  it("distributes count-2 sub-events across [time, time+spread] inclusive", () => {
    const doc = baseDoc();
    doc.looping = false;
    doc.duration = 2;
    const layer = doc.layers[0]!;
    layer.emission.rateOverTime = { mode: "constant", value: 0 };
    layer.emission.bursts = [{ time: 0.1, count: 2, spread: 0.4 }];
    layer.emission.delay = 0;
    layer.emission.prewarm = false;
    layer.initial.life = { mode: "constant", value: 5 }; // outlive the whole test
    const fx = new Effect(doc, { seed: 1 });

    // Step to t≈0.4: the first sub-event (t=0.1) has fired; the second is due at
    // t=0.1+0.4=0.5 (inclusive endpoint), NOT 0.3 (the old k/count midpoint).
    while (fx.time < 0.4) fx.step(1 / 60);
    expect(fx.layers[0]!.count).toBe(1);

    // Step past t=0.5: the second sub-event fires.
    while (fx.time < 0.55) fx.step(1 / 60);
    expect(fx.layers[0]!.count).toBe(2);
  });
});

describe.skipIf(!hasPresets)("burst-window validation warnings (P2.2 / P2.3)", () => {
  const doc = () => {
    const d = structuredClone(parseParticle(readFileSync(resolve(presetsDir, "sparks.prt"), "utf8")).doc!);
    d.looping = true;
    d.duration = 1;
    d.layers[0]!.emission.delay = 0;
    return d;
  };

  it("warns when a burst's spread tail exceeds the emission window", () => {
    const d = doc();
    d.layers[0]!.emission.bursts = [{ time: 0.9, count: 10, spread: 0.5 }]; // 0.9+0.5 > 1
    const res = validateParticle(d);
    expect(res.ok).toBe(true); // warning, not error
    expect(res.warnings.some((w) => /spread extends past/.test(w.message))).toBe(true);
  });

  it("warns when a burst's time is past the emission window", () => {
    const d = doc();
    d.layers[0]!.emission.bursts = [{ time: 1.5, count: 4, spread: 0 }]; // > duration
    const res = validateParticle(d);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => /past the emission window/.test(w.message))).toBe(true);
  });

  it("does not warn for an in-window burst", () => {
    const d = doc();
    d.layers[0]!.emission.bursts = [{ time: 0.1, count: 4, spread: 0.2 }];
    expect(validateParticle(d).warnings.length).toBe(0);
  });
});

describe.skipIf(!hasPresets)("negative emission rate banks no credit (P2.3)", () => {
  it("a rate curve dipping negative spawns nothing until it turns positive", () => {
    const doc = baseDoc();
    doc.looping = false;
    doc.duration = 2;
    const layer = doc.layers[0]!;
    layer.emission.bursts = [];
    layer.emission.prewarm = false;
    // Rate is negative for the first half, then positive.
    layer.emission.rateOverTime = { mode: "curve", keys: [{ t: 0, v: -1000 }, { t: 0.5, v: -1000 }, { t: 0.5, v: 60 }, { t: 1, v: 60 }] };
    const fx = new Effect(doc, { seed: 1 });

    // Halfway (t=1.0 of duration 2): the negative half must have produced no
    // particles and, crucially, banked no negative "credit" that would suppress
    // later spawns or spawn a spurious one at the flip.
    while (fx.time < 0.99) fx.step(1 / 60);
    expect(fx.layers[0]!.count).toBe(0);

    // After the rate goes positive, particles appear.
    while (fx.time < 1.2) fx.step(1 / 60);
    expect(fx.layers[0]!.count).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasPresets)("Effect duration guard (P2.3)", () => {
  it("throws on a non-positive duration instead of hanging", () => {
    const doc = baseDoc();
    doc.duration = 0;
    expect(() => new Effect(doc, { seed: 1 })).toThrow(/duration must be > 0/);
  });
});

describe.skipIf(!hasPresets)("seed & flipbook validation (P2.3)", () => {
  const doc = () => structuredClone(parseParticle(readFileSync(resolve(presetsDir, "sparks.prt"), "utf8")).doc!);

  it("rejects a fractional or negative seed", () => {
    const a = doc();
    a.seed = 1.5 as number;
    expect(validateParticle(a).ok).toBe(false);
    const b = doc();
    b.seed = -1 as number;
    expect(validateParticle(b).ok).toBe(false);
  });

  it("accepts an integer seed", () => {
    expect(validateParticle(doc()).ok).toBe(true);
  });

  it("rejects flipbook cols/rows above the bound", () => {
    const d = doc();
    d.layers[0]!.texture.frames = { cols: 100, rows: 1, fps: 12, mode: "loop" };
    expect(validateParticle(d).ok).toBe(false);
  });
});
