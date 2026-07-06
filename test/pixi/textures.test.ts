import { describe, it, expect } from "vitest";
import { generateBuiltinTexture } from "../../src/pixi/textures.js";
import { BUILTIN_TEXTURE_IDS, type BuiltinTextureId } from "../../src/index.js";

function hash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

describe("procedural built-in textures (§2.11)", () => {
  it("generates every built-in id with RGBA pixel data", () => {
    for (const id of BUILTIN_TEXTURE_IDS) {
      const t = generateBuiltinTexture(id as BuiltinTextureId);
      expect(t.pixels.length).toBe(t.width * t.height * 4);
      expect(t.width).toBeGreaterThan(0);
    }
  });

  it("is deterministic (identical bytes across calls)", () => {
    for (const id of BUILTIN_TEXTURE_IDS) {
      const a = generateBuiltinTexture(id as BuiltinTextureId);
      const b = generateBuiltinTexture(id as BuiltinTextureId);
      expect(hash(a.pixels)).toBe(hash(b.pixels));
    }
  });

  it("has the expected dimensions", () => {
    expect(generateBuiltinTexture("circle-soft")).toMatchObject({ width: 64, height: 64 });
    expect(generateBuiltinTexture("spark")).toMatchObject({ width: 64, height: 16 });
  });

  it("circle-soft is opaque at the centre and transparent at the corner", () => {
    const t = generateBuiltinTexture("circle-soft");
    const at = (x: number, y: number) => t.pixels[(y * t.width + x) * 4 + 3]!;
    expect(at(32, 32)).toBeGreaterThan(240);
    expect(at(0, 0)).toBe(0);
  });

  it("pixel digests are stable (regression guard)", () => {
    const digests = Object.fromEntries(
      BUILTIN_TEXTURE_IDS.map((id) => [id, hash(generateBuiltinTexture(id as BuiltinTextureId).pixels)]),
    );
    expect(digests).toMatchSnapshot();
  });
});
