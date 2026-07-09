import { describe, it, expect } from "vitest";
import { serializeParticle, parseParticle, type ParticleDoc } from "../../src/index.js";
import { makeDoc } from "./_helpers.js";

describe("serializeParticle — canonical form", () => {
  it("uses 2-space indent, LF endings, and a trailing newline", () => {
    const out = serializeParticle(makeDoc());
    expect(out.endsWith("\n")).toBe(true);
    expect(out.includes("\r")).toBe(false);
    expect(out.split("\n")[1]).toBe('  "schemaVersion": 6,');
  });

  it("orders known keys by their declared order regardless of input order", () => {
    // Build a doc with keys deliberately out of declared order.
    const scrambled = {
      layers: [],
      seed: 7,
      looping: false,
      duration: 1,
      meta: { notes: "n", name: "N", createdWith: "c" },
      schemaVersion: 1,
    } as unknown as ParticleDoc;
    const out = serializeParticle(scrambled);
    const keyLines = out.split("\n").filter((l) => /^ {2}"/.test(l));
    const keys = keyLines.map((l) => l.trim().split('"')[1]);
    expect(keys).toEqual(["schemaVersion", "meta", "duration", "looping", "seed", "layers"]);
    // meta sub-keys also canonicalized
    expect(out).toContain('"meta": {\n    "name": "N",\n    "createdWith": "c",\n    "notes": "n"\n  }');
  });

  it("appends unknown fields after known ones and preserves them on round-trip", () => {
    const withUnknown = {
      ...makeDoc(),
      futureTop: { z: 1, a: [1, 2] },
    } as unknown as ParticleDoc;
    const text = serializeParticle(withUnknown);
    // unknown top-level key comes after the known ones
    expect(text.indexOf('"futureTop"')).toBeGreaterThan(text.indexOf('"layers"'));

    const reparsed = parseParticle(text);
    expect(reparsed.ok).toBe(true);
    // round-trip is byte-stable
    expect(serializeParticle(reparsed.doc as ParticleDoc)).toBe(text);
  });

  it("round-trips a canonical document byte-for-byte", () => {
    const text = serializeParticle(makeDoc());
    const again = serializeParticle(parseParticle(text).doc as ParticleDoc);
    expect(again).toBe(text);
  });

  it("emits empty arrays and objects compactly", () => {
    const out = serializeParticle(makeDoc({ layers: [] }));
    expect(out).toContain('"layers": []');
  });
});
