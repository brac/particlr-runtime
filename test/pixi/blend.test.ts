import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BufferImageSource, ParticleContainer, Texture } from "pixi.js";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { PixiParticleRenderer } from "../../src/pixi/renderer.js";
import { presetsDir, hasPresets } from "../_presets.js";

// B8 (schemaVersion 7): the adapter's blendOf identity passes `erase` straight
// through to the ParticleContainer's blendMode (Pixi v8's native 'erase'). This
// is the headless-practical portion of adapter coverage — a real
// PixiParticleRenderer is constructed and its container's blendMode inspected;
// the actual GL compositing is exercised by the golden lane in CI.

function loadDoc(name: string) {
  const raw = readFileSync(resolve(presetsDir, `${name}.prt`), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${JSON.stringify(parsed.errors)}`);
  return structuredClone(parsed.doc!);
}

function fakeTexture(width: number): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(width * width * 4), width, height: width }),
  });
}

const pcOf = (r: PixiParticleRenderer, i = 0) => r.container.children[i] as ParticleContainer;

describe.skipIf(!hasPresets)("PixiParticleRenderer — erase blend mode (B8)", () => {
  it("maps blend: 'erase' onto the ParticleContainer's blendMode", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.blend = "erase";
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx, { loadTexture: async () => fakeTexture(64) });
    expect(pcOf(r).blendMode).toBe("erase");
    r.destroy();
  });

  it("leaves other layers' blend untouched (identity passthrough)", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.blend = "normal";
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx, { loadTexture: async () => fakeTexture(64) });
    expect(pcOf(r).blendMode).toBe("normal");
    r.destroy();
  });
});
