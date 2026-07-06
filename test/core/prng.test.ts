import { describe, it, expect } from "vitest";
import { mulberry32, deriveLayerSeed } from "../../src/index.js";

describe("mulberry32", () => {
  it("matches the known vector for seed 1", () => {
    const r = mulberry32(1);
    expect([r(), r(), r()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
  });

  it("returns floats in [0,1)", () => {
    const r = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
  });
});

describe("deriveLayerSeed", () => {
  it("matches the §2.7 formula (unsigned 32-bit)", () => {
    expect(deriveLayerSeed(1337, 0)).toBe(1337);
    expect(deriveLayerSeed(1337, 1)).toBe(2654437106);
    expect(deriveLayerSeed(1337, 2)).toBe(1013905579);
  });

  it("gives distinct streams per layer index", () => {
    const s0 = mulberry32(deriveLayerSeed(1000, 0))();
    const s1 = mulberry32(deriveLayerSeed(1000, 1))();
    expect(s0).not.toBe(s1);
  });
});
