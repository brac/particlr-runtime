import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseSpark, serializeSpark, type SparkDoc } from "../../src/index.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const read = (name: string) => readFileSync(resolve(fixtures, name), "utf8");

describe("byte-stable round-trip (Gate 0)", () => {
  for (const name of ["explosion.spark", "unknowns.spark"]) {
    it(`${name}: serializeSpark(parseSpark(text)) === text`, () => {
      const text = read(name);
      const parsed = parseSpark(text);
      expect(parsed.ok).toBe(true);
      expect(serializeSpark(parsed.doc as SparkDoc)).toBe(text);
    });
  }

  it("preserves unknown fields at every nesting level", () => {
    const text = read("unknowns.spark");
    // Known validator ignores them, but they survive verbatim in the bytes.
    for (const marker of ["metaExtra", "textureExtra", "trackExtra", "emissionExtra", "keyExtra", "layerExtra", "futureField"]) {
      expect(text).toContain(marker);
    }
    const reserialized = serializeSpark(parseSpark(text).doc as SparkDoc);
    for (const marker of ["metaExtra", "textureExtra", "trackExtra", "emissionExtra", "keyExtra", "layerExtra", "futureField"]) {
      expect(reserialized).toContain(marker);
    }
  });

  it("explosion.spark has three layers and validates cleanly", () => {
    const parsed = parseSpark(read("explosion.spark"));
    expect(parsed.ok).toBe(true);
    expect(parsed.doc?.layers.length).toBe(3);
    expect(parsed.warnings.length).toBe(0);
  });
});
