// Pure quad math: corners in TL,BL,TR,BR order under an explicit 2D matrix.
// y-down, degrees, P4.1 sizing (width = size*stretch, height = size*aspect),
// flip bits = mirror around center (bit1 X, bit2 Y).
import { describe, it, expect } from "vitest";
import { computeParticleQuad, frameUV, type Mat2D } from "../../src/phaser/quadMath.js";

const I: Mat2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const q = new Float32Array(8);
const uv = new Float32Array(4);

describe("computeParticleQuad", () => {
  it("axis-aligned quad at origin, size 10, aspect 1", () => {
    computeParticleQuad(q, 0, 0, 10, 1, 1, 0, 0, I);
    // TL, BL, TR, BR — y-down means top has the smaller y.
    expect(Array.from(q)).toEqual([-5, -5, -5, 5, 5, -5, 5, 5]);
  });

  it("applies stretch along width only", () => {
    computeParticleQuad(q, 0, 0, 10, 1, 2, 0, 0, I);
    expect(Array.from(q)).toEqual([-10, -5, -10, 5, 10, -5, 10, 5]);
  });

  it("aspect scales height only", () => {
    computeParticleQuad(q, 0, 0, 10, 2, 1, 0, 0, I);
    expect(Array.from(q)).toEqual([-5, -10, -5, 10, 5, -10, 5, 10]);
  });

  it("rotates 90deg clockwise (y-down)", () => {
    computeParticleQuad(q, 0, 0, 10, 1, 1, 90, 0, I);
    // TL(-5,-5) rotated 90cw in y-down: (x,y) -> (-y, x) => (5,-5)
    expect(q[0]).toBeCloseTo(5);
    expect(q[1]).toBeCloseTo(-5);
  });

  it("flip X mirrors around center before rotation", () => {
    computeParticleQuad(q, 0, 0, 10, 1, 2, 0, 1, I);
    // TL local x negated: was -10, now +10.
    expect(Array.from(q)).toEqual([10, -5, 10, 5, -10, -5, -10, 5]);
  });

  it("applies the matrix (translate + scale)", () => {
    const m: Mat2D = { a: 2, b: 0, c: 0, d: 2, tx: 100, ty: 50 };
    computeParticleQuad(q, 0, 0, 10, 1, 1, 0, 0, m);
    expect(Array.from(q)).toEqual([90, 40, 90, 60, 110, 40, 110, 60]);
  });

  it("offsets by particle center through the matrix", () => {
    computeParticleQuad(q, 30, 40, 10, 1, 1, 0, 0, I);
    expect(Array.from(q)).toEqual([25, 35, 25, 45, 35, 35, 35, 45]);
  });
});

// V is BOTTOM-UP and the window height is NEGATIVE: Phaser's Textures.Frame
// computes `v0 = 1 - cy/th` with `v1 - v0 < 0`, so every Phaser texture samples
// with v=0 at the bottom of the source image (see frameUV's doc comment). The
// expectations below are the top edge of the window in that space.
describe("frameUV", () => {
  it("whole texture when 1x1", () => {
    frameUV(uv, 0, 1, 1);
    expect(Array.from(uv)).toEqual([0, 1, 1, -1]);
  });
  it("row-major window, v mirrored", () => {
    frameUV(uv, 5, 4, 2); // frame 5 in 4x2 grid: col 1, row 1 (the BOTTOM row)
    expect(Array.from(uv)).toEqual([0.25, 0.5, 0.25, -0.5]);
  });
  it("frame 0 is the TOP-left tile of the sheet", () => {
    frameUV(uv, 0, 4, 4); // top edge v=1, bottom edge v=0.75 — the image's top row
    expect(Array.from(uv)).toEqual([0, 1, 0.25, -0.25]);
  });
});
