import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Mesh, DataTexture, RGBAFormat, UnsignedByteType } from "three";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { ThreeParticleRenderer } from "../../src/three/renderer.js";
import { presetsDir, hasPresets } from "../_presets.js";
import type { Flipbook } from "../../src/format/types.js";

// Any preset with a flipbook layer works; the test constructs its own doc to
// be preset-independent, matching the real `Flipbook` shape (format/types.ts).
function flipbookDoc() {
  const raw = readFileSync(resolve(presetsDir, "fireball.prt"), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error("fixture invalid");
  const doc = structuredClone(parsed.doc!);
  const frames: Flipbook = { cols: 4, rows: 2, fps: 12, mode: "loop", randomStartFrame: false, frameOverLife: null };
  doc.layers[0]!.texture.frames = frames;
  return doc;
}
const matOf = (r: ThreeParticleRenderer, i = 0) => (r.root.children[i] as Mesh).material as any;

describe.skipIf(!hasPresets)("three flipbook", () => {
  it("sets uCols/uRows and the frame-cell aspect from the sheet", () => {
    const fx = new Effect(flipbookDoc(), { seed: 1 });
    const r = new ThreeParticleRenderer(fx, {
      loadTexture: async () => new DataTexture(new Uint8Array(128 * 64 * 4), 128, 64, RGBAFormat, UnsignedByteType),
    });
    const m = matOf(r);
    // Built-in 64x64 sheet, 4x2 grid: frame = 16x32, aspect = 2.
    expect(m.uniforms.uCols.value).toBe(4);
    expect(m.uniforms.uRows.value).toBe(2);
    expect(m.uniforms.uAspect.value).toBeCloseTo((64 / 2) / (64 / 4), 5);
    r.destroy();
  });
  it("recomputes the aspect after an async user-sheet swap", async () => {
    const doc = flipbookDoc();
    doc.layers[0]!.texture.ref = "user:sheet";
    doc.textures = { sheet: "data:image/png;base64,PLACEHOLDER" };
    const fx = new Effect(doc, { seed: 1 });
    const r = new ThreeParticleRenderer(fx, {
      loadTexture: async () => new DataTexture(new Uint8Array(128 * 64 * 4), 128, 64, RGBAFormat, UnsignedByteType),
    });
    await r.ready;
    const m = matOf(r);
    // 128x64 sheet, 4x2 grid: frame = 32x32, aspect 1.
    expect(m.uniforms.uAspect.value).toBeCloseTo(1, 5);
    expect(m.uniforms.uCols.value).toBe(4);
    r.destroy();
  });
});
