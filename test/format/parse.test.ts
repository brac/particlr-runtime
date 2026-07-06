import { describe, it, expect } from "vitest";
import { parseSpark, migrateToCurrent } from "../../src/index.js";
import { makeDoc } from "./_helpers.js";

describe("parseSpark", () => {
  it("parses a JSON string and an object identically", () => {
    const doc = makeDoc();
    const fromObj = parseSpark(doc);
    const fromStr = parseSpark(JSON.stringify(doc));
    expect(fromObj.ok).toBe(true);
    expect(fromStr.ok).toBe(true);
  });

  it("throws only on non-JSON input", () => {
    expect(() => parseSpark("{not json")).toThrow();
  });

  it("returns errors (does not throw) on a structurally invalid document", () => {
    const r = parseSpark(makeDoc({ duration: 0 }));
    expect(r.ok).toBe(false);
    expect(r.doc).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("refuses a newer schemaVersion with the newer-version code (E11)", () => {
    const r = parseSpark({ ...makeDoc(), schemaVersion: 99 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("newer-version");
  });

  it("surfaces warnings on success (E10 missing texture)", () => {
    const doc = makeDoc();
    doc.layers[0]!.texture.ref = "user:ghost";
    const r = parseSpark(doc);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "missing-texture")).toBe(true);
  });
});

describe("migrateToCurrent", () => {
  it("passes a v1 document through unchanged", () => {
    const doc = makeDoc();
    const r = migrateToCurrent(doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc).toBe(doc);
  });

  it("refuses newer and rejects invalid versions", () => {
    expect(migrateToCurrent({ schemaVersion: 2 }).ok).toBe(false);
    expect(migrateToCurrent({ schemaVersion: 0 }).ok).toBe(false);
    expect(migrateToCurrent(null).ok).toBe(false);
  });
});
