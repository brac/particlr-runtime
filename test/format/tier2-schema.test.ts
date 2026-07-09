import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  type ParticleDoc,
  type ValidationIssue,
} from "../../src/index.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// --- shared builders -------------------------------------------------------
const textureShape = (over: Record<string, unknown> = {}) => ({
  kind: "texture" as const,
  width: 64,
  height: 64,
  threshold: 0,
  mask: { width: 1, height: 1, data: "/w==" }, // 1×1 opaque = a uniform rect
  emitFrom: "volume" as const,
  ...over,
});
const attractor = (over: Record<string, unknown> = {}) => ({
  x: 0,
  y: 0,
  strength: { mode: "constant" as const, value: 300 },
  tangential: null,
  radius: 200,
  falloff: "smooth" as const,
  killRadius: 0,
  ...over,
});
const dissolve = (over: Record<string, unknown> = {}) => ({
  frequency: 4,
  scroll: { x: 0, y: 0 },
  edgeWidth: 0.15,
  edgeColor: null,
  ...over,
});

// A doc holding a single layer patched with `over`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docWith = (over: Record<string, any>) => makeDoc({ layers: [makeLayer(over as never)] });
const res = (over: Record<string, unknown>) => validateParticle(docWith(over));
const ok = (over: Record<string, unknown>) => res(over).ok;
const errPaths = (over: Record<string, unknown>): string[] => {
  const r = res(over);
  return r.ok ? [] : r.errors.map((e) => e.path);
};
const warns = (over: Record<string, unknown>): ValidationIssue[] => {
  const r = res(over);
  return r.ok ? r.warnings : r.warnings;
};
const hasWarn = (over: Record<string, unknown>, pred: (w: ValidationIssue) => boolean) =>
  warns(over).some(pred);

// ---------------------------------------------------------------------------
describe("v3 -> v4 migration", () => {
  it("injects the three inert defaults per layer (spread-after)", () => {
    const v3 = {
      ...makeDoc(),
      schemaVersion: 3,
      layers: [
        (() => {
          const l = clone(makeDoc().layers[0]!) as Record<string, unknown>;
          delete l.attractor;
          delete l.dissolve;
          delete l.attractorInfluence;
          return l;
        })(),
      ],
    };
    const m = migrateToCurrent(v3);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(6); // migrateToCurrent chains to CURRENT (now 6)
    expect(doc.layers[0]!.attractor).toBe(null);
    expect(doc.layers[0]!.dissolve).toBe(null);
    expect(doc.layers[0]!.attractorInfluence).toBe(0);
  });

  it("never clobbers a present value (defaults are spread first)", () => {
    const v3 = {
      ...makeDoc(),
      schemaVersion: 3,
      layers: [{ ...(clone(makeDoc().layers[0]!) as object), attractorInfluence: 1.5 }],
    };
    const m = migrateToCurrent(v3);
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).layers[0]!.attractorInfluence).toBe(1.5);
  });

  it("is idempotent on an already-current v5 document", () => {
    const doc = makeDoc();
    const m = migrateToCurrent(doc);
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.doc).toBe(doc); // current version passes through by reference
  });

  it("refuses a v7 document (E11)", () => {
    expect(migrateToCurrent({ schemaVersion: 7 }).ok).toBe(false);
    const r = parseParticle({ ...makeDoc(), schemaVersion: 7 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("newer-version");
  });

  it("chains a v1 document all the way to v5", () => {
    const v1 = {
      ...makeDoc(),
      schemaVersion: 1,
      layers: [
        (() => {
          const l = clone(makeDoc().layers[0]!) as Record<string, unknown>;
          delete l.space;
          delete l.inheritVelocity;
          delete l.attractor;
          delete l.dissolve;
          delete l.attractorInfluence;
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
    const m = migrateToCurrent(v1);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(6); // migrateToCurrent chains to CURRENT (now 6)
    expect(doc.layers[0]!.space).toBe("local"); // v1->v2
    expect(doc.layers[0]!.noise).toBe(null); // v2->v3
    expect(doc.layers[0]!.attractor).toBe(null); // v3->v4
    expect(doc.layers[0]!.attractorInfluence).toBe(0);
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("chains a v2 document to v5", () => {
    const v2 = {
      ...makeDoc(),
      schemaVersion: 2,
      layers: [
        (() => {
          const l = clone(makeDoc().layers[0]!) as Record<string, unknown>;
          delete l.attractor;
          delete l.dissolve;
          delete l.attractorInfluence;
          for (const k of ["noise", "bySpeed", "startColor", "randomFlip", "render", "collision"]) delete l[k];
          return l;
        })(),
      ],
    };
    const m = migrateToCurrent(v2);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(6); // migrateToCurrent chains to CURRENT (now 6)
    expect(doc.layers[0]!.dissolve).toBe(null);
    expect(doc.layers[0]!.attractorInfluence).toBe(0);
  });
});

describe("validator — texture shape", () => {
  it("accepts a 1×1 opaque mask (uniform rect) with no warnings (M1: implemented)", () => {
    expect(ok({ shape: textureShape() })).toBe(true);
    // M1 landed the behavior: the temporary "unimplemented" warning is gone.
    expect(hasWarn({ shape: textureShape() }, (w) => w.code === "unimplemented" && w.path === "layers[0].shape")).toBe(false);
    expect(hasWarn({ shape: textureShape() }, (w) => w.code === "bad-mask")).toBe(false);
  });

  it("accepts a real multi-pixel mask", () => {
    expect(ok({ shape: textureShape({ mask: { width: 3, height: 3, data: "/4AAQMgQ/1oH" } }) })).toBe(true);
  });

  it("bad base64 is a WARNING (bad-mask), not an error", () => {
    const over = { shape: textureShape({ mask: { width: 2, height: 2, data: "not base64!!" } }) };
    expect(ok(over)).toBe(true);
    expect(hasWarn(over, (w) => w.code === "bad-mask")).toBe(true);
  });

  it("length mismatch is a bad-mask warning", () => {
    const over = { shape: textureShape({ mask: { width: 2, height: 2, data: "/w==" } }) }; // 1 byte, expects 4
    expect(ok(over)).toBe(true);
    expect(hasWarn(over, (w) => w.code === "bad-mask")).toBe(true);
  });

  it("zero passing pixels is a bad-mask warning", () => {
    // 2×2 fully transparent mask (all-zero alpha) with threshold 0 -> no weight.
    const over = { shape: textureShape({ threshold: 0, mask: { width: 2, height: 2, data: "AAAAAA==" } }) };
    expect(ok(over)).toBe(true);
    expect(hasWarn(over, (w) => w.code === "bad-mask")).toBe(true);
  });

  it("errors on structural mask problems", () => {
    expect(errPaths({ shape: textureShape({ mask: undefined }) })).toContain("layers[0].shape.mask");
    expect(errPaths({ shape: textureShape({ mask: { width: 1.5, height: 1, data: "/w==" } }) })).toContain("layers[0].shape.mask.width");
    expect(errPaths({ shape: textureShape({ mask: { width: 200, height: 1, data: "/w==" } }) })).toContain("layers[0].shape.mask.width");
    expect(errPaths({ shape: textureShape({ mask: { width: 1, height: 1, data: 42 } }) })).toContain("layers[0].shape.mask.data");
  });

  it("errors on threshold out of range and non-positive dims", () => {
    expect(errPaths({ shape: textureShape({ threshold: 1.5 }) })).toContain("layers[0].shape.threshold");
    expect(errPaths({ shape: textureShape({ width: 0 }) })).toContain("layers[0].shape.width");
    expect(errPaths({ shape: textureShape({ height: -4 }) })).toContain("layers[0].shape.height");
  });

  it("warns (E26) when emitFrom is surface", () => {
    expect(hasWarn({ shape: textureShape({ emitFrom: "surface" }) }, (w) => /E26/.test(w.message))).toBe(true);
  });
});

describe("validator — attractor", () => {
  it("accepts a valid attractor with no unimplemented warning (M2: implemented)", () => {
    expect(ok({ attractor: attractor(), space: "world" })).toBe(true);
    // M2 landed the behavior: the temporary "unimplemented" warning is gone.
    expect(hasWarn({ attractor: attractor(), space: "world" }, (w) => w.code === "unimplemented" && w.path === "layers[0].attractor")).toBe(false);
  });

  it("accepts curve strength + tangential tracks", () => {
    const curve = { mode: "curve" as const, keys: [{ t: 0, v: 100 }, { t: 1, v: 400 }] };
    expect(ok({ attractor: attractor({ strength: curve, tangential: curve }), space: "world" })).toBe(true);
  });

  it("rejects radius <= 0", () => {
    expect(errPaths({ attractor: attractor({ radius: 0 }) })).toContain("layers[0].attractor.radius");
  });

  it("rejects killRadius > radius and killRadius < 0", () => {
    expect(errPaths({ attractor: attractor({ radius: 100, killRadius: 150 }) })).toContain("layers[0].attractor.killRadius");
    expect(errPaths({ attractor: attractor({ killRadius: -1 }) })).toContain("layers[0].attractor.killRadius");
  });

  it("rejects range-mode strength (no per-particle range)", () => {
    expect(errPaths({ attractor: attractor({ strength: { mode: "range", min: 0, max: 1 } }) })).toContain("layers[0].attractor.strength.mode");
  });

  it("rejects an invalid falloff", () => {
    expect(errPaths({ attractor: attractor({ falloff: "quadratic" }) })).toContain("layers[0].attractor.falloff");
  });

  it("rejects non-finite coordinates", () => {
    expect(errPaths({ attractor: attractor({ x: Infinity }) })).toContain("layers[0].attractor.x");
  });

  it("hints E24 when the layer is local space", () => {
    expect(hasWarn({ attractor: attractor(), space: "local" }, (w) => /E24/.test(w.message))).toBe(true);
    expect(hasWarn({ attractor: attractor(), space: "world" }, (w) => /E24/.test(w.message))).toBe(false);
  });
});

describe("validator — attractorInfluence", () => {
  it("accepts a value in [-2, 2]; zero draws no unimplemented warning", () => {
    expect(ok({ attractorInfluence: 0 })).toBe(true);
    expect(hasWarn({ attractorInfluence: 0 }, (w) => w.code === "unimplemented" && w.path === "layers[0].attractorInfluence")).toBe(false);
  });

  it("draws no unimplemented warning when non-zero (M2: implemented)", () => {
    expect(ok({ attractorInfluence: 1 })).toBe(true);
    // M2 landed the host hook: a non-zero influence no longer warns.
    expect(hasWarn({ attractorInfluence: 1 }, (w) => w.code === "unimplemented" && w.path === "layers[0].attractorInfluence")).toBe(false);
  });

  it("rejects out-of-range or non-finite values", () => {
    expect(errPaths({ attractorInfluence: 3 })).toContain("layers[0].attractorInfluence");
    expect(errPaths({ attractorInfluence: -2.1 })).toContain("layers[0].attractorInfluence");
    expect(errPaths({ attractorInfluence: NaN })).toContain("layers[0].attractorInfluence");
  });
});

describe("validator — dissolve", () => {
  it("accepts a valid dissolve with no unimplemented warning (M3: implemented)", () => {
    expect(ok({ dissolve: dissolve() })).toBe(true);
    // M3 landed the renderer behavior: the temporary "unimplemented" warning is gone.
    expect(hasWarn({ dissolve: dissolve() }, (w) => w.code === "unimplemented" && w.path === "layers[0].dissolve")).toBe(false);
  });

  it("rejects frequency out of (0, 64]", () => {
    expect(errPaths({ dissolve: dissolve({ frequency: 0 }) })).toContain("layers[0].dissolve.frequency");
    expect(errPaths({ dissolve: dissolve({ frequency: 65 }) })).toContain("layers[0].dissolve.frequency");
  });

  it("rejects edgeWidth out of [0, 1]", () => {
    expect(errPaths({ dissolve: dissolve({ edgeWidth: 1.2 }) })).toContain("layers[0].dissolve.edgeWidth");
  });

  it("accepts a null edgeColor and rejects an out-of-range one", () => {
    expect(ok({ dissolve: dissolve({ edgeColor: null }) })).toBe(true);
    expect(ok({ dissolve: dissolve({ edgeColor: { r: 1, g: 0.5, b: 0.2, a: 1 } }) })).toBe(true);
    expect(errPaths({ dissolve: dissolve({ edgeColor: { r: 2, g: 0, b: 0, a: 1 } }) })).toContain("layers[0].dissolve.edgeColor.r");
  });

  it("warns (E25) when the layer also has a trail", () => {
    const trail = { maxPoints: 8, minVertexDistance: 2, width: { mode: "constant" as const, value: 4 }, color: null };
    expect(hasWarn({ dissolve: dissolve(), trail }, (w) => /E25/.test(w.message))).toBe(true);
  });
});

describe("maximal v4 document — byte-stable round-trip", () => {
  function maximalDoc(): ParticleDoc {
    const curve = { mode: "curve" as const, keys: [{ t: 0, v: 100, ease: "easeOut" as const }, { t: 1, v: 400 }] };
    return makeDoc({
      layers: [
        makeLayer({
          id: "tex",
          space: "world",
          attractorInfluence: 1.25,
          shape: {
            kind: "texture",
            width: 96,
            height: 72,
            threshold: 0.25,
            mask: { width: 3, height: 3, data: "/4AAQMgQ/1oH" },
            emitFrom: "volume",
          },
          attractor: {
            x: 10,
            y: -20,
            strength: curve,
            tangential: { mode: "curve", keys: [{ t: 0, v: 0 }, { t: 1, v: 90 }] },
            radius: 250,
            falloff: "smooth",
            killRadius: 12,
          },
          dissolve: {
            frequency: 6,
            scroll: { x: 0.05, y: 0.1 },
            edgeWidth: 0.2,
            edgeColor: { r: 1, g: 0.6, b: 0.2, a: 0.8 },
          },
        }),
      ],
    });
  }

  it("validates (only unimplemented / authoring warnings, no errors)", () => {
    const r = validateParticle(maximalDoc());
    expect(r.ok).toBe(true);
  });

  it("round-trips byte-stably and deep-equal", () => {
    const doc = maximalDoc();
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc);
    expect(serializeParticle(back.doc!)).toBe(text);
  });

  it("emits the v4 fields in canonical order", () => {
    const text = serializeParticle(maximalDoc());
    // attractorInfluence directly after inheritVelocity; dissolve after render;
    // attractor after collision.
    expect(text.indexOf('"attractorInfluence"')).toBeGreaterThan(text.indexOf('"inheritVelocity"'));
    expect(text.indexOf('"dissolve"')).toBeGreaterThan(text.indexOf('"render"'));
    expect(text.indexOf('"attractor"')).toBeGreaterThan(text.indexOf('"collision"'));
    // mask blob last inside the shape.
    expect(text.indexOf('"data"')).toBeGreaterThan(text.indexOf('"threshold"'));
  });
});
