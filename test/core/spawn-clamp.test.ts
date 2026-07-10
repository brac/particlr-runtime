import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseParticle, validateParticle } from "../../src/index.js";
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
