import { describe, it, expect } from "vitest";
import {
  sampleScalarInit,
  evalCurve,
  evalScalarTrack,
  evalGradient,
  mulberry32,
  type RGBA,
} from "../../src/index.js";
import type { CurveKey } from "../../src/index.js";

describe("sampleScalarInit", () => {
  it("returns the constant value without drawing", () => {
    const rng = mulberry32(1);
    expect(sampleScalarInit({ mode: "constant", value: 7 }, rng)).toBe(7);
  });
  it("maps a uniform draw into [min,max]", () => {
    const rng = () => 0.5;
    expect(sampleScalarInit({ mode: "range", min: 10, max: 20 }, rng)).toBe(15);
  });
});

describe("evalScalarTrack", () => {
  it("constant ignores t and rand", () => {
    expect(evalScalarTrack({ mode: "constant", value: 3 }, 0.7, 0.9)).toBe(3);
  });
  it("range uses the pre-drawn particle rand, not t", () => {
    expect(evalScalarTrack({ mode: "range", min: 0, max: 100 }, 0.1, 0.25)).toBe(25);
  });
  it("curve delegates to evalCurve", () => {
    const track = { mode: "curve", keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] } as const;
    expect(evalScalarTrack(track, 0.5, 0)).toBeCloseTo(5, 12);
  });
});

describe("evalCurve", () => {
  it("E3: one key is constant everywhere", () => {
    const keys: CurveKey[] = [{ t: 0.3, v: 42 }];
    expect(evalCurve(keys, 0)).toBe(42);
    expect(evalCurve(keys, 1)).toBe(42);
  });

  it("clamps outside the key range", () => {
    const keys: CurveKey[] = [{ t: 0.2, v: 1 }, { t: 0.8, v: 5 }];
    expect(evalCurve(keys, 0)).toBe(1);
    expect(evalCurve(keys, 1)).toBe(5);
  });

  it("interpolates linearly by default", () => {
    const keys: CurveKey[] = [{ t: 0, v: 0 }, { t: 1, v: 8 }];
    expect(evalCurve(keys, 0.25)).toBeCloseTo(2, 12);
    expect(evalCurve(keys, 0.5)).toBeCloseTo(4, 12);
  });

  it("applies per-segment easing from the left key", () => {
    const keys: CurveKey[] = [{ t: 0, v: 0, ease: "easeIn" }, { t: 1, v: 1 }];
    expect(evalCurve(keys, 0.5)).toBeCloseTo(0.25, 12); // u^2
  });

  it("E12: duplicate t — last key wins at that t", () => {
    const keys: CurveKey[] = [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 0.5, v: 9 }, { t: 1, v: 9 }];
    expect(evalCurve(keys, 0.5)).toBe(9);
  });

  it("step easing holds then jumps at the next key", () => {
    const keys: CurveKey[] = [{ t: 0, v: 2, ease: "step" }, { t: 1, v: 8 }];
    expect(evalCurve(keys, 0.5)).toBe(2);
    expect(evalCurve(keys, 1)).toBe(8);
  });
});

describe("evalGradient", () => {
  const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };

  it("interpolates each channel linearly", () => {
    const g = { keys: [
      { t: 0, r: 1, g: 0, b: 0, a: 1 },
      { t: 1, r: 0, g: 0, b: 1, a: 0 },
    ] };
    evalGradient(g, 0.5, out);
    expect(out.r).toBeCloseTo(0.5, 12);
    expect(out.b).toBeCloseTo(0.5, 12);
    expect(out.a).toBeCloseTo(0.5, 12);
  });

  it("clamps outside range and handles one key", () => {
    const one = { keys: [{ t: 0.5, r: 0.2, g: 0.4, b: 0.6, a: 0.8 }] };
    evalGradient(one, 0, out);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.2, 0.4, 0.6, 0.8]);
    evalGradient(one, 1, out);
    expect([out.r, out.g, out.b, out.a]).toEqual([0.2, 0.4, 0.6, 0.8]);
  });
});
