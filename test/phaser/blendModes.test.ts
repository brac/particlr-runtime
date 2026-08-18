// Blend table unit test — verifies the normative mapping and the custom-add
// registration incl. the 4.2.1 addBlendMode off-by-one workaround (we read
// blendModes.length - 1, never the return value).
import { describe, it, expect } from "vitest";
import { phaserBlendIndex, type PhaserBlendRegistry } from "../../src/phaser/blendModes.js";

function fakeRenderer(): PhaserBlendRegistry & { added: Array<{ func: number[]; equation: number }> } {
  const blendModes: unknown[] = new Array(28).fill({});
  const added: Array<{ func: number[]; equation: number }> = [];
  return {
    blendModes,
    added,
    addBlendMode(func: number[], equation: number): number {
      added.push({ func, equation });
      blendModes.push({ func, equation });
      return blendModes.length - 2; // reproduce the 4.2.1 off-by-one bug
    },
  };
}

describe("phaserBlendIndex", () => {
  it("maps native modes to Phaser constants", () => {
    const r = fakeRenderer();
    expect(phaserBlendIndex(r, "normal")).toBe(0);
    expect(phaserBlendIndex(r, "multiply")).toBe(2);
    expect(phaserBlendIndex(r, "screen")).toBe(3);
    expect(phaserBlendIndex(r, "erase")).toBe(17);
    expect(r.added).toHaveLength(0);
  });

  it("registers ONE,ONE for add and ignores the buggy return value", () => {
    const r = fakeRenderer();
    const idx = phaserBlendIndex(r, "add");
    expect(idx).toBe(28); // length-1 after push, NOT the buggy return (27)
    expect(r.added).toEqual([{ func: [1, 1], equation: 0x8006 }]); // gl.ONE, gl.ONE, gl.FUNC_ADD
  });

  it("registers add only once per renderer", () => {
    const r = fakeRenderer();
    const a = phaserBlendIndex(r, "add");
    const b = phaserBlendIndex(r, "add");
    expect(a).toBe(b);
    expect(r.added).toHaveLength(1);
  });
});
