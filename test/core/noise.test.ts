import { describe, it, expect } from "vitest";
import { hash2, valueNoise2, curl2, type Vec2 } from "../../src/core/noise.js";

const SEED = 0x1234abcd;

describe("hash2 (schemaVersion 3, §0.3)", () => {
  it("is deterministic: same cell + seed → same value", () => {
    expect(hash2(3, 7, SEED)).toBe(hash2(3, 7, SEED));
    expect(hash2(-12, 40, 99)).toBe(hash2(-12, 40, 99));
  });

  it("returns values in [0, 1)", () => {
    for (let ix = -8; ix <= 8; ix++) {
      for (let iy = -8; iy <= 8; iy++) {
        const v = hash2(ix, iy, SEED);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("decorrelates neighbours and seeds (not a constant field)", () => {
    expect(hash2(0, 0, SEED)).not.toBe(hash2(1, 0, SEED));
    expect(hash2(0, 0, SEED)).not.toBe(hash2(0, 1, SEED));
    expect(hash2(5, 5, 1)).not.toBe(hash2(5, 5, 2));
    // Coordinate order matters (x and y use distinct multipliers).
    expect(hash2(3, 7, SEED)).not.toBe(hash2(7, 3, SEED));
  });
});

describe("valueNoise2 (schemaVersion 3, §0.3)", () => {
  it("is deterministic", () => {
    expect(valueNoise2(1.3, 4.7, SEED)).toBe(valueNoise2(1.3, 4.7, SEED));
  });

  it("stays in [0, 1) across a fractional grid", () => {
    for (let x = -3; x <= 3; x += 0.37) {
      for (let y = -3; y <= 3; y += 0.41) {
        const v = valueNoise2(x, y, SEED);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("reproduces the lattice hash exactly at integer corners", () => {
    // At integer coordinates fade(0)=0, so the interpolation collapses to the
    // corner hash — a quick sanity that the bilinear weights are correct.
    expect(valueNoise2(2, 5, SEED)).toBeCloseTo(hash2(2, 5, SEED), 12);
  });

  it("varies smoothly (adjacent samples are close)", () => {
    const a = valueNoise2(1.0, 1.0, SEED);
    const b = valueNoise2(1.001, 1.0, SEED);
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });
});

describe("curl2 (schemaVersion 3, §0.3)", () => {
  const at = (x: number, y: number, oct = 1): Vec2 => curl2(x, y, SEED, oct, { x: 0, y: 0 });

  it("is deterministic and writes into the supplied out", () => {
    const out: Vec2 = { x: 0, y: 0 };
    const ret = curl2(2.5, 3.5, SEED, 2, out);
    expect(ret).toBe(out);
    const out2: Vec2 = { x: 0, y: 0 };
    curl2(2.5, 3.5, SEED, 2, out2);
    expect(out2).toEqual(out);
  });

  it("produces finite, non-degenerate vectors over a grid", () => {
    let maxMag = 0;
    for (let x = -4; x <= 4; x += 0.5) {
      for (let y = -4; y <= 4; y += 0.5) {
        const c = at(x, y);
        expect(Number.isFinite(c.x)).toBe(true);
        expect(Number.isFinite(c.y)).toBe(true);
        maxMag = Math.max(maxMag, Math.hypot(c.x, c.y));
      }
    }
    expect(maxMag).toBeGreaterThan(0); // the field is not identically zero
  });

  it("more octaves add detail (differs from a single octave)", () => {
    const c1 = at(1.7, 2.3, 1);
    const c3 = at(1.7, 2.3, 3);
    expect(c3).not.toEqual(c1);
  });

  it("is approximately divergence-free (swirls, doesn't bunch)", () => {
    // Curl of a scalar potential is divergence-free. For this discrete curl
    // (central differences at ε), measuring the divergence with the SAME step
    // ε telescopes the four-corner stencil to exactly zero (in exact
    // arithmetic), so the residual is pure floating-point noise — orders of
    // magnitude below the curl magnitude. (EPS in noise.ts is 0.35.)
    const h = 0.35;
    let sumDiv2 = 0;
    let sumMag2 = 0;
    let n = 0;
    const o1: Vec2 = { x: 0, y: 0 };
    const o2: Vec2 = { x: 0, y: 0 };
    const o3: Vec2 = { x: 0, y: 0 };
    const o4: Vec2 = { x: 0, y: 0 };
    const oc: Vec2 = { x: 0, y: 0 };
    for (let x = -3; x <= 3; x += 0.5) {
      for (let y = -3; y <= 3; y += 0.5) {
        const dCurlXdx = (curl2(x + h, y, SEED, 1, o1).x - curl2(x - h, y, SEED, 1, o2).x) / (2 * h);
        const dCurlYdy = (curl2(x, y + h, SEED, 1, o3).y - curl2(x, y - h, SEED, 1, o4).y) / (2 * h);
        const div = dCurlXdx + dCurlYdy;
        curl2(x, y, SEED, 1, oc);
        sumDiv2 += div * div;
        sumMag2 += oc.x * oc.x + oc.y * oc.y;
        n++;
      }
    }
    const rmsDiv = Math.sqrt(sumDiv2 / n);
    const rmsMag = Math.sqrt(sumMag2 / n);
    expect(rmsMag).toBeGreaterThan(0);
    // Divergence is machine-epsilon relative to the field magnitude.
    expect(rmsDiv / rmsMag).toBeLessThan(1e-6);
  });
});
