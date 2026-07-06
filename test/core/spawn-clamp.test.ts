import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSpark, validateSpark } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";

function loadDoc(name: string) {
  const raw = readFileSync(resolve(__dirname, `../../../../presets/${name}.spark`), "utf8");
  const parsed = parseSpark(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid`);
  return structuredClone(parsed.doc!);
}

describe("spawn-loop clamps (P1.3)", () => {
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

describe("validation ceilings (P1.3)", () => {
  it("rejects a rate above the ceiling", () => {
    const doc = loadDoc("fire");
    doc.layers[0]!.emission.rateOverTime = { mode: "constant", value: 1e15 };
    const res = validateSpark(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /rate must be <=/.test(e.message))).toBe(true);
  });

  it("rejects a burst count above the ceiling", () => {
    const doc = loadDoc("sparks");
    doc.layers[0]!.emission.bursts = [{ time: 0, count: 20000, spread: 0 }];
    const res = validateSpark(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /count must be an integer/.test(e.message))).toBe(true);
  });

  it("still accepts a normal rate and burst count", () => {
    const doc = loadDoc("explosion");
    expect(validateSpark(doc).ok).toBe(true);
  });
});
