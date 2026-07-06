import { describe, it, expect } from "vitest";
import { serializeSpark, parseSpark, type SparkDoc } from "../../src/index.js";
import { makeDoc } from "./_helpers.js";

describe("serializeSpark — canonical form", () => {
  it("uses 2-space indent, LF endings, and a trailing newline", () => {
    const out = serializeSpark(makeDoc());
    expect(out.endsWith("\n")).toBe(true);
    expect(out.includes("\r")).toBe(false);
    expect(out.split("\n")[1]).toBe('  "schemaVersion": 1,');
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
    } as unknown as SparkDoc;
    const out = serializeSpark(scrambled);
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
    } as unknown as SparkDoc;
    const text = serializeSpark(withUnknown);
    // unknown top-level key comes after the known ones
    expect(text.indexOf('"futureTop"')).toBeGreaterThan(text.indexOf('"layers"'));

    const reparsed = parseSpark(text);
    expect(reparsed.ok).toBe(true);
    // round-trip is byte-stable
    expect(serializeSpark(reparsed.doc as SparkDoc)).toBe(text);
  });

  it("round-trips a canonical document byte-for-byte", () => {
    const text = serializeSpark(makeDoc());
    const again = serializeSpark(parseSpark(text).doc as SparkDoc);
    expect(again).toBe(text);
  });

  it("emits empty arrays and objects compactly", () => {
    const out = serializeSpark(makeDoc({ layers: [] }));
    expect(out).toContain('"layers": []');
  });
});
