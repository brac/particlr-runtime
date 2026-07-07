import { describe, it, expect } from "vitest";
import { parseParticle, migrateToCurrent } from "../../src/index.js";
import { makeDoc } from "./_helpers.js";

describe("parseParticle", () => {
  it("parses a JSON string and an object identically", () => {
    const doc = makeDoc();
    const fromObj = parseParticle(doc);
    const fromStr = parseParticle(JSON.stringify(doc));
    expect(fromObj.ok).toBe(true);
    expect(fromStr.ok).toBe(true);
  });

  it("throws only on non-JSON input", () => {
    expect(() => parseParticle("{not json")).toThrow();
  });

  it("returns errors (does not throw) on a structurally invalid document", () => {
    const r = parseParticle(makeDoc({ duration: 0 }));
    expect(r.ok).toBe(false);
    expect(r.doc).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("refuses a newer schemaVersion with the newer-version code (E11)", () => {
    const r = parseParticle({ ...makeDoc(), schemaVersion: 99 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("newer-version");
  });

  it("surfaces warnings on success (E10 missing texture)", () => {
    const doc = makeDoc();
    doc.layers[0]!.texture.ref = "user:ghost";
    const r = parseParticle(doc);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "missing-texture")).toBe(true);
  });
});

describe("migrateToCurrent", () => {
  it("passes a current-version document through unchanged", () => {
    const doc = makeDoc();
    const r = migrateToCurrent(doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc).toBe(doc);
  });

  it("migrates a v1 document to v2 by injecting inert emitter-motion defaults", () => {
    // A v1 layer/emission with none of the schemaVersion-2 fields.
    const v1 = {
      ...makeDoc(),
      schemaVersion: 1,
      layers: [
        (() => {
          const l = JSON.parse(JSON.stringify(makeDoc().layers[0])) as Record<string, unknown>;
          delete l.space;
          delete l.inheritVelocity;
          delete (l.emission as Record<string, unknown>).rateOverDistance;
          return l;
        })(),
      ],
    };
    const r = migrateToCurrent(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.doc as { schemaVersion: number; layers: Array<Record<string, unknown>> };
    expect(doc.schemaVersion).toBe(2);
    expect(doc.layers[0]!.space).toBe("local");
    expect(doc.layers[0]!.inheritVelocity).toBe(0);
    expect((doc.layers[0]!.emission as Record<string, unknown>).rateOverDistance).toBe(null);
    // The migrated document validates cleanly (defaults are spec-valid).
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("refuses newer and rejects invalid versions", () => {
    expect(migrateToCurrent({ schemaVersion: 3 }).ok).toBe(false);
    expect(migrateToCurrent({ schemaVersion: 0 }).ok).toBe(false);
    expect(migrateToCurrent(null).ok).toBe(false);
  });
});
