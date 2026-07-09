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

  it("migrates a v2 document forward and validates it (autosave-restore path)", () => {
    // A v2 layer/emission missing every schemaVersion-3 field (the shape a
    // localStorage autosave written by a prior build would have).
    const v2 = {
      ...makeDoc(),
      schemaVersion: 2,
      layers: [
        (() => {
          const l = JSON.parse(JSON.stringify(makeDoc().layers[0])) as Record<string, unknown>;
          for (const k of ["noise", "bySpeed", "startColor", "randomFlip", "render", "collision"]) delete l[k];
          const ol = l.overLifetime as { velocity: Record<string, unknown> };
          for (const k of ["x", "y", "orbital", "radial"]) delete ol.velocity[k];
          const shape = l.shape as Record<string, unknown>;
          for (const k of ["arcMode", "arcSpeed"]) delete shape[k]; // cone
          return l;
        })(),
      ],
    };
    const r = parseParticle(v2);
    expect(r.ok).toBe(true);
    expect(r.doc?.schemaVersion).toBe(6);
    expect(r.doc?.layers[0]?.noise).toBe(null);
    expect(r.doc?.layers[0]?.overLifetime.velocity.orbital).toBe(null);
    // v3 -> v4 defaults injected too.
    expect(r.doc?.layers[0]?.attractor).toBe(null);
    expect(r.doc?.layers[0]?.attractorInfluence).toBe(0);
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

  it("chains a v1 document all the way to v5, injecting every migration's defaults", () => {
    // A v1 layer/emission with none of the schemaVersion-2 or -3 fields.
    const v1 = {
      ...makeDoc(),
      schemaVersion: 1,
      layers: [
        (() => {
          const l = JSON.parse(JSON.stringify(makeDoc().layers[0])) as Record<string, unknown>;
          delete l.space;
          delete l.inheritVelocity;
          for (const k of ["noise", "bySpeed", "startColor", "randomFlip", "render", "collision"]) delete l[k];
          delete (l.emission as Record<string, unknown>).rateOverDistance;
          const ol = l.overLifetime as { velocity: Record<string, unknown> };
          for (const k of ["x", "y", "orbital", "radial"]) delete ol.velocity[k];
          const shape = l.shape as Record<string, unknown>;
          for (const k of ["arcMode", "arcSpeed"]) delete shape[k];
          return l;
        })(),
      ],
    };
    const r = migrateToCurrent(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.doc as { schemaVersion: number; layers: Array<Record<string, unknown>> };
    expect(doc.schemaVersion).toBe(6);
    // v1->v2 defaults
    expect(doc.layers[0]!.space).toBe("local");
    expect(doc.layers[0]!.inheritVelocity).toBe(0);
    expect((doc.layers[0]!.emission as Record<string, unknown>).rateOverDistance).toBe(null);
    // v2->v3 defaults
    expect(doc.layers[0]!.noise).toBe(null);
    expect(doc.layers[0]!.render).toBe(null);
    expect((doc.layers[0]!.shape as Record<string, unknown>).arcMode).toBe("random");
    // v3->v4 defaults
    expect(doc.layers[0]!.attractor).toBe(null);
    expect(doc.layers[0]!.dissolve).toBe(null);
    expect(doc.layers[0]!.attractorInfluence).toBe(0);
    // v4->v5 default (A4 limit-velocity, inert null).
    expect(doc.layers[0]!.limitVelocity).toBe(null);
    // The migrated document validates cleanly (defaults are spec-valid).
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("is idempotent on an already-current v5 document", () => {
    const doc = makeDoc();
    const once = migrateToCurrent(doc);
    expect(once.ok).toBe(true);
    if (once.ok) expect(once.doc).toBe(doc); // current version passes through by reference
  });

  it("refuses newer and rejects invalid versions", () => {
    expect(migrateToCurrent({ schemaVersion: 7 }).ok).toBe(false);
    expect(migrateToCurrent({ schemaVersion: 0 }).ok).toBe(false);
    expect(migrateToCurrent(null).ok).toBe(false);
  });
});
