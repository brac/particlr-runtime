import { describe, it, expect } from "vitest";
import { Effect, evalScalarTrack, type Layer, type ScalarTrack } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const ct = (value: number): ScalarTrack => ({ mode: "constant", value });

// A5 randomBetweenCurves (§0.3b). The evaluator landed in M0; these pins guard
// the load-bearing invariants from the sim side: the mode reuses the track's OWN
// reserved per-particle uniform (ZERO new draws), stays bit-identical across
// runs, and — when both curves are the SAME flat line at V — is byte-identical to
// a plain constant V (lerp(V, V, u) === V, the uniform consumed identically).
describe("random-between-curves — reserved-uniform equivalence (M2, §0.2)", () => {
  it("a==b flat at V is bitwise-identical to constant V (same uniform consumed)", () => {
    const V = 1.3;
    const flat: ScalarTrack = { mode: "randomBetweenCurves", a: [{ t: 0, v: V }, { t: 1, v: V }], b: [{ t: 0, v: V }, { t: 1, v: V }] };
    // Same layer twice: size over life via randomBetweenCurves(a==b==V) vs a plain
    // constant V. Everything else (spawn stream, motion) is identical, so the
    // reserved size uniform is drawn+consumed the same in both — the states match.
    const base = (size: ScalarTrack): Layer =>
      makeLayer({
        overLifetime: {
          size,
          color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
          rotation: null,
          velocity: { gravity: { x: 0, y: 200 }, drag: ct(0.4), speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
        },
      });
    const rbcFx = new Effect(makeDoc({ duration: 2, looping: true, layers: [base(flat)] }), { seed: 1337 });
    const constFx = new Effect(makeDoc({ duration: 2, looping: true, layers: [base(ct(V))] }), { seed: 1337 });
    for (let i = 0; i < 200; i++) {
      rbcFx.step(1 / 60);
      constFx.step(1 / 60);
    }
    expect(stateHash(rbcFx)).toBe(stateHash(constFx));
  });

  it("evaluator endpoints: rand 0 => curve a, rand 1 => curve b, 0.5 => midpoint", () => {
    const track: ScalarTrack = { mode: "randomBetweenCurves", a: [{ t: 0, v: 2 }, { t: 1, v: 4 }], b: [{ t: 0, v: 10 }, { t: 1, v: 20 }] };
    // t = 0.5: curve a = 3, curve b = 15.
    expect(evalScalarTrack(track, 0.5, 0)).toBeCloseTo(3, 12);
    expect(evalScalarTrack(track, 0.5, 1)).toBeCloseTo(15, 12);
    expect(evalScalarTrack(track, 0.5, 0.5)).toBeCloseTo(9, 12);
  });
});

describe("random-between-curves — determinism (M2)", () => {
  it("two-run bit identity on size + orbital over 600 mixed-dt steps", () => {
    const layer = makeLayer({
      space: "world",
      shape: { kind: "cone", direction: -90, spread: 40, radius: 6, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
      initial: {
        life: { mode: "range", min: 0.5, max: 1 },
        speed: { mode: "range", min: 80, max: 200 },
        size: { mode: "constant", value: 8 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        // size and orbital both in randomBetweenCurves: each reuses its OWN
        // reserved uniform (rand0 / velRandOrbital), so no new draws.
        size: { mode: "randomBetweenCurves", a: [{ t: 0, v: 0.5, ease: "easeOut" }, { t: 1, v: 0 }], b: [{ t: 0, v: 1.6, ease: "easeOut" }, { t: 1, v: 0.3 }] },
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: {
          gravity: { x: 0, y: 300 },
          drag: ct(0.3),
          speedMultiplier: null,
          x: null,
          y: null,
          orbital: { mode: "randomBetweenCurves", a: [{ t: 0, v: -180 }, { t: 1, v: 0 }], b: [{ t: 0, v: 180 }, { t: 1, v: 0 }] },
          radial: null,
        },
      },
    });
    const doc = makeDoc({ duration: 2, looping: true, layers: [layer] });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(23, 600);
    const checkpoints = new Set([1, 200, 400, 600]);
    for (let i = 1; i <= 600; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
  });
});
