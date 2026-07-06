import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Effect, parseSpark, type SparkDoc } from "../../src/index.js";
import { stateHash, dtSequence } from "./_statehash.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const presetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../presets");
function loadFrom(base: string, name: string): SparkDoc {
  const parsed = parseSpark(readFileSync(resolve(base, name), "utf8"));
  if (!parsed.ok) throw new Error(`${name} failed to parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.doc!;
}
const loadDoc = (name: string): SparkDoc => loadFrom(fixtures, name);
const presetNames = readdirSync(presetsDir)
  .filter((f) => f.endsWith(".spark"))
  .sort();

describe("determinism (Gate 1)", () => {
  it("two runs with the same doc/seed/dt-sequence are bit-identical over 600 steps", () => {
    const doc = loadDoc("explosion.spark");
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(99, 600);

    const checkpoints = new Set([1, 60, 300, 600]);
    for (let i = 1; i <= 600; i++) {
      const dt = dts[i - 1]!;
      a.step(dt);
      b.step(dt);
      if (checkpoints.has(i)) {
        expect(stateHash(a)).toBe(stateHash(b));
      }
    }
    // extra rigor: full array equality at the end
    for (const [la, lb] of a.layers.map((l, i) => [l, b.layers[i]!] as const)) {
      expect(la.count).toBe(lb.count);
      expect(Array.from(la.pool.x.slice(0, la.count))).toEqual(Array.from(lb.pool.x.slice(0, lb.count)));
    }
  });

  it("a different seed produces different state", () => {
    const doc = loadDoc("explosion.spark");
    const a = new Effect(doc, { seed: 1 });
    const b = new Effect(doc, { seed: 2 });
    const dts = dtSequence(99, 60);
    for (let i = 0; i < 60; i++) {
      a.step(dts[i]!);
      b.step(dts[i]!);
    }
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});

describe("preset snapshots (Gate 1)", () => {
  // Hash of full state after 60 steps at dt=1/60 for EVERY preset. Any change to
  // the sim (or a preset) changes this digest and requires explicit human
  // sign-off — presets are fixtures (SLICE_ONE session guidance).
  for (const name of presetNames) {
    it(`${name} state @60 steps is stable`, () => {
      const fx = new Effect(loadFrom(presetsDir, name), { seed: 1337 });
      for (let i = 0; i < 60; i++) fx.step(1 / 60);
      expect(stateHash(fx)).toMatchSnapshot();
    });
  }

  it("every preset validates and is deterministic across two runs", () => {
    for (const name of presetNames) {
      const doc = loadFrom(presetsDir, name);
      const a = new Effect(doc, { seed: 1337 });
      const b = new Effect(doc, { seed: 1337 });
      for (let i = 0; i < 120; i++) {
        a.step(1 / 60);
        b.step(1 / 60);
      }
      expect(stateHash(a), name).toBe(stateHash(b));
    }
  });
});
