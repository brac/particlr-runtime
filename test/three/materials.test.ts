import { describe, it, expect } from "vitest";
import {
  CustomBlending, AddEquation, OneFactor, ZeroFactor,
  OneMinusSrcAlphaFactor, OneMinusSrcColorFactor, DstColorFactor, DataTexture,
  RGBAFormat, UnsignedByteType, DoubleSide,
} from "three";
import { makeSpriteMaterial, applyBlend, spriteVertexGl, spriteFragmentGl } from "../../src/three/materials.js";

const tex = () => new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);

describe("blend table (normative — README copies this)", () => {
  const cases = [
    ["normal", OneFactor, OneMinusSrcAlphaFactor],
    ["add", OneFactor, OneFactor],
    ["multiply", DstColorFactor, OneMinusSrcAlphaFactor],
    ["screen", OneFactor, OneMinusSrcColorFactor],
    ["erase", ZeroFactor, OneMinusSrcAlphaFactor],
  ] as const;
  for (const [mode, src, dst] of cases) {
    it(mode, () => {
      const m = makeSpriteMaterial(tex(), mode);
      expect(m.blending).toBe(CustomBlending);
      expect(m.blendSrc).toBe(src);
      expect(m.blendDst).toBe(dst);
      expect(m.blendEquation).toBe(AddEquation);
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
    });
  }
});

describe("sprite material", () => {
  it("declares every per-instance attribute and uniform the renderer fills", () => {
    for (const name of ["aInstPos", "aSize", "aColor", "aFrame", "aStretch", "aAngle", "aFlip"]) {
      expect(spriteVertexGl).toContain(`attribute`);
      expect(spriteVertexGl).toContain(name);
    }
    for (const u of ["uCols", "uRows", "uAspect", "uBillboard"]) expect(spriteVertexGl).toContain(u);
    expect(spriteFragmentGl).toContain("uTexture");
    const m = makeSpriteMaterial(tex(), "normal");
    for (const u of ["uTexture", "uCols", "uRows", "uAspect", "uBillboard"]) {
      expect(m.uniforms[u], u).toBeDefined();
    }
  });
  it("outputs premultiplied alpha (rgb * a in the final write)", () => {
    expect(spriteFragmentGl).toMatch(/gl_FragColor\s*=\s*vec4\(\s*rgb\s*\*\s*a\s*,\s*a\s*\)/);
  });
  it("never backface-culls (DoubleSide) — quad winding + per-instance randomFlip can't support FrontSide", () => {
    expect(makeSpriteMaterial(tex(), "normal").side).toBe(DoubleSide);
  });
});
