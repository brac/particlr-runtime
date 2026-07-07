import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseParticle, serializeParticle, type ParticleDoc } from "../../src/index.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const read = (name: string) => readFileSync(resolve(fixtures, name), "utf8");

describe("byte-stable round-trip (Gate 0)", () => {
  for (const name of ["explosion.prt", "unknowns.prt"]) {
    it(`${name}: serializeParticle(parseParticle(text)) === text`, () => {
      const text = read(name);
      const parsed = parseParticle(text);
      expect(parsed.ok).toBe(true);
      expect(serializeParticle(parsed.doc as ParticleDoc)).toBe(text);
    });
  }

  it("preserves unknown fields at every nesting level", () => {
    const text = read("unknowns.prt");
    // Known validator ignores them, but they survive verbatim in the bytes.
    for (const marker of ["metaExtra", "textureExtra", "trackExtra", "emissionExtra", "keyExtra", "layerExtra", "futureField"]) {
      expect(text).toContain(marker);
    }
    const reserialized = serializeParticle(parseParticle(text).doc as ParticleDoc);
    for (const marker of ["metaExtra", "textureExtra", "trackExtra", "emissionExtra", "keyExtra", "layerExtra", "futureField"]) {
      expect(reserialized).toContain(marker);
    }
  });

  it("explosion.prt has three layers and validates cleanly", () => {
    const parsed = parseParticle(read("explosion.prt"));
    expect(parsed.ok).toBe(true);
    expect(parsed.doc?.layers.length).toBe(3);
    expect(parsed.warnings.length).toBe(0);
  });
});
