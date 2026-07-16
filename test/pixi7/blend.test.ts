import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALPHA_MODES, BLEND_MODES, ParticleContainer, SCALE_MODES, Texture } from "pixi.js";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { PixiParticleRenderer } from "../../src/pixi7/renderer.js";
import { presetsDir, hasPresets } from "../_presets.js";

// v7 divergence from the v8 blend test: v8's BlendMode strings ARE its Pixi
// blend-mode values (identity passthrough), so the v8 test asserts the string
// 'erase'. In v7 blend modes are a NUMERIC enum, so the adapter maps
// string → BLEND_MODES and we assert the enum constant. `erase` →
// BLEND_MODES.ERASE (=26, == DST_OUT; GL func [ZERO, ONE_MINUS_SRC_ALPHA] —
// verified against 7.4.3 mapWebGLBlendModesToPixi). The actual GL compositing
// is exercised by the golden lane (M4) in CI.

function loadDoc(name: string) {
  const raw = readFileSync(resolve(presetsDir, `${name}.prt`), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${JSON.stringify(parsed.errors)}`);
  return structuredClone(parsed.doc!);
}

function fakeTexture(width: number): Texture {
  return Texture.fromBuffer(new Uint8Array(width * width * 4), width, width, {
    alphaMode: ALPHA_MODES.UNPACK,
    scaleMode: SCALE_MODES.LINEAR,
  });
}

const pcOf = (r: PixiParticleRenderer, i = 0) => r.container.children[i] as ParticleContainer;

describe.skipIf(!hasPresets)("PixiParticleRenderer (v7) — erase blend mode (B8)", () => {
  it("maps blend: 'erase' onto BLEND_MODES.ERASE", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.blend = "erase";
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx, { loadTexture: async () => fakeTexture(64) });
    expect(pcOf(r).blendMode).toBe(BLEND_MODES.ERASE);
    r.destroy();
  });

  it("maps every BlendMode string to its numeric enum (full table)", async () => {
    const cases: [string, BLEND_MODES][] = [
      ["normal", BLEND_MODES.NORMAL],
      ["add", BLEND_MODES.ADD],
      ["multiply", BLEND_MODES.MULTIPLY],
      ["screen", BLEND_MODES.SCREEN],
      ["erase", BLEND_MODES.ERASE],
    ];
    for (const [name, expected] of cases) {
      const doc = loadDoc("rain");
      doc.layers[0]!.blend = name as (typeof doc.layers)[0]["blend"];
      const fx = new Effect(doc, { seed: doc.seed });
      const r = new PixiParticleRenderer(fx, { loadTexture: async () => fakeTexture(64) });
      expect(pcOf(r).blendMode, name).toBe(expected);
      r.destroy();
    }
  });
});
