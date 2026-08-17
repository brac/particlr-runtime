import { describe, it, expect } from "vitest";
import { RGBAFormat, ClampToEdgeWrapping, RepeatWrapping, LinearFilter } from "three";
import { builtinTexture, textureFromData, dissolveNoiseTexture } from "../../src/three/textures.js";
import { generateBuiltinTexture } from "../../src/texgen/index.js";

describe("three textures", () => {
  it("builds a straight-alpha, non-flipped DataTexture from TextureData", () => {
    const t = textureFromData(generateBuiltinTexture("circle-soft"));
    expect(t.image.width).toBe(64);
    expect(t.format).toBe(RGBAFormat);
    expect(t.flipY).toBe(false);
    expect(t.premultiplyAlpha).toBe(false);
    expect(t.magFilter).toBe(LinearFilter);
    expect(t.wrapS).toBe(ClampToEdgeWrapping);
    expect(t.needsUpdate === true || t.version > 0).toBe(true);
  });
  it("caches built-ins at module scope and self-heals a destroyed entry", () => {
    const a = builtinTexture("spark");
    expect(builtinTexture("spark")).toBe(a);
    a.dispose();
    // dispose() does not mark DataTexture unusable in three; our guard keys on
    // our own `userData.particlrDisposed` flag set by dispose listener.
    const b = builtinTexture("spark");
    expect(b).not.toBe(a);
  });
  it("dissolve noise tile is repeat-wrapped", () => {
    const n = dissolveNoiseTexture();
    expect(n.wrapS).toBe(RepeatWrapping);
    expect(n.wrapT).toBe(RepeatWrapping);
    expect(dissolveNoiseTexture()).toBe(n);
  });
});
