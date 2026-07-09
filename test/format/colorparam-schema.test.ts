import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  Effect,
  type ParticleDoc,
  type ParamDef,
  type RGBAColor,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// COLOR_PARAM_PLAN (schemaVersion 8, §M0): the `color` param kind + the layer-level
// `tintParam` binding. ZERO runtime behavior this milestone — nothing reads a color
// param or tintParam, so a v7 doc migrates to v8 bit-inert (each param gains
// kind:"scalar", each layer gains tintParam:null).

const white = (): RGBAColor => ({ r: 1, g: 1, b: 1, a: 1 });

// A v7-shaped doc reconstructed from a current v8 doc by stripping the v8 additions
// (kind off every param, tintParam off every layer) — the pre-migration input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toV7(v8: ParticleDoc): any {
  const d = clone(v8) as any;
  d.schemaVersion = 7;
  if (Array.isArray(d.params)) for (const p of d.params) delete p.kind;
  for (const l of d.layers) delete l.tintParam;
  return d;
}

function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}

// ---------------------------------------------------------------------------
describe("v7 -> v8 migration (color param + tintParam)", () => {
  it("injects kind:scalar on every existing param and tintParam:null on every layer, bumps to 8", () => {
    const v8 = makeDoc({ params: [{ kind: "scalar", name: "intensity", default: 1, min: 0, max: 2 }] });
    const v7 = toV7(v8);
    // sanity: the lowered input carries neither addition.
    expect(v7.params[0].kind).toBeUndefined();
    expect(v7.layers[0].tintParam).toBeUndefined();
    const m = migrateToCurrent(v7);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(8);
    expect(doc.params[0]).toEqual({ kind: "scalar", name: "intensity", default: 1, min: 0, max: 2 });
    expect(doc.layers[0]!.tintParam).toBe(null);
  });

  it("leaves an empty params array empty (only the layer walk runs)", () => {
    const v7 = toV7(makeDoc());
    const m = migrateToCurrent(v7);
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).params).toEqual([]);
  });

  it("spread-first never clobbers a param that already carries a kind (incl. color)", () => {
    const v7 = toV7(makeDoc());
    // A v7 input that already carries an explicit color param — the migration must
    // NOT overwrite its kind to "scalar".
    v7.params = [{ kind: "color", name: "tint", default: white() }];
    const m = migrateToCurrent(v7);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect((m.doc as ParticleDoc).params[0]).toEqual({ kind: "color", name: "tint", default: white() });
  });

  it("spread-first never clobbers a layer that already carries a tintParam string", () => {
    const v7 = toV7(makeDoc());
    v7.params = [{ kind: "color", name: "tint", default: white() }];
    v7.layers[0].tintParam = "tint";
    const m = migrateToCurrent(v7);
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).layers[0]!.tintParam).toBe("tint");
  });

  it("chains a v1 document all the way to v8 (kind + tintParam appear)", () => {
    const l = clone(makeDoc().layers[0]!) as Record<string, unknown>;
    for (const k of [
      "space", "inheritVelocity", "attractor", "dissolve", "attractorInfluence",
      "limitVelocity", "noise", "bySpeed", "startColor", "randomFlip", "render",
      "collision", "opacityParam", "tintParam",
    ]) delete l[k];
    const em = l.emission as Record<string, unknown>;
    for (const k of ["rateOverDistance", "rateOverTimeParam", "rateOverDistanceParam"]) delete em[k];
    const init = l.initial as Record<string, unknown>;
    for (const k of ["speedParam", "lifeParam", "sizeParam"]) delete init[k];
    const ol = l.overLifetime as { velocity: Record<string, unknown> };
    for (const k of ["x", "y", "orbital", "radial", "gravityParam"]) delete ol.velocity[k];
    const shape = l.shape as Record<string, unknown>;
    for (const k of ["arcMode", "arcSpeed"]) delete shape[k];

    const v1: Record<string, unknown> = { ...makeDoc(), schemaVersion: 1, layers: [l] };
    delete v1.params;

    const m = migrateToCurrent(v1);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(8);
    expect(doc.layers[0]!.space).toBe("local"); // v1->v2 still applied
    expect(doc.params).toEqual([]); // v5->v6
    expect(doc.layers[0]!.tintParam).toBe(null); // v7->v8
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("migration is bit-inert: stateHash of a migrated v7 doc == the hand-built v8 doc", () => {
    const v8 = makeDoc({ params: [{ kind: "scalar", name: "intensity", default: 1, min: 0, max: 2 }] });
    const migrated = migrateToCurrent(toV7(v8));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    // Nothing reads kind/tintParam in M0, and a scalar param at default is a ×1,
    // so the migrated doc simulates identically to the hand-built v8 doc.
    expect(runHash(migrated.doc as ParticleDoc)).toBe(runHash(v8));
  });
});

// ---------------------------------------------------------------------------
describe("validator — E33 param kind", () => {
  it("accepts a valid scalar param and a valid color param", () => {
    expect(validateParticle(makeDoc({ params: [{ kind: "scalar", name: "i", default: 1, min: 0, max: 2 }] })).ok).toBe(true);
    expect(validateParticle(makeDoc({ params: [{ kind: "color", name: "tint", default: white() }] })).ok).toBe(true);
  });

  it("accepts a color default at the channel bounds", () => {
    expect(validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: { r: 0, g: 0, b: 0, a: 0 } }] })).ok).toBe(true);
    expect(validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: { r: 1, g: 1, b: 1, a: 1 } }] })).ok).toBe(true);
  });

  it("rejects a missing kind (E33)", () => {
    const r = validateParticle(makeDoc({ params: [{ name: "x", default: 1, min: 0, max: 2 } as unknown as ParamDef] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "params[0].kind")).toBe(true);
  });

  it("rejects a junk kind (E33)", () => {
    const r = validateParticle(makeDoc({ params: [{ kind: "vector", name: "x", default: 1 } as unknown as ParamDef] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "params[0].kind")).toBe(true);
  });

  it("rejects a color param carrying min or max (E33)", () => {
    const withMin = validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: white(), min: 0 } as unknown as ParamDef] }));
    expect(withMin.ok).toBe(false);
    if (!withMin.ok) expect(withMin.errors.some((e) => e.path === "params[0].min")).toBe(true);
    const withMax = validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: white(), max: 1 } as unknown as ParamDef] }));
    expect(withMax.ok).toBe(false);
    if (!withMax.ok) expect(withMax.errors.some((e) => e.path === "params[0].max")).toBe(true);
  });

  it("rejects a color default that is not an object (E33)", () => {
    const r = validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: 1 as unknown as RGBAColor }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "params[0].default")).toBe(true);
  });

  it("rejects a color default channel out of range (E33)", () => {
    const hi = validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: { r: 1.5, g: 0, b: 0, a: 1 } }] }));
    expect(hi.ok).toBe(false);
    if (!hi.ok) expect(hi.errors.some((e) => e.path === "params[0].default.r")).toBe(true);
    const lo = validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: { r: 0, g: -0.1, b: 0, a: 1 } }] }));
    expect(lo.ok).toBe(false);
    if (!lo.ok) expect(lo.errors.some((e) => e.path === "params[0].default.g")).toBe(true);
  });

  it("rejects a color default channel that is non-finite (E33)", () => {
    const r = validateParticle(makeDoc({ params: [{ kind: "color", name: "t", default: { r: NaN, g: 0, b: 0, a: 1 } }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "params[0].default.r")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validator — E34 binding kind mismatch", () => {
  it("rejects a scalar binding (opacityParam) that names a color param (E34)", () => {
    const l = clone(makeLayer());
    l.opacityParam = "tint";
    const r = validateParticle(makeDoc({ params: [{ kind: "color", name: "tint", default: white() }], layers: [l] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((x) => x.path === "layers[0].opacityParam");
      expect(e).toBeDefined();
      expect(e!.message).toContain("(E34)");
    }
  });

  it("rejects tintParam that names a scalar param (E34)", () => {
    const l = clone(makeLayer());
    l.tintParam = "intensity";
    const r = validateParticle(makeDoc({ params: [{ kind: "scalar", name: "intensity", default: 1, min: 0, max: 2 }], layers: [l] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((x) => x.path === "layers[0].tintParam");
      expect(e).toBeDefined();
      expect(e!.message).toContain("(E34)");
    }
  });

  it("accepts tintParam that names a color param, opacityParam that names a scalar param", () => {
    const l = clone(makeLayer());
    l.tintParam = "tint";
    l.opacityParam = "opacity";
    const r = validateParticle(makeDoc({
      params: [
        { kind: "color", name: "tint", default: white() },
        { kind: "scalar", name: "opacity", default: 1, min: 0, max: 1 },
      ],
      layers: [l],
    }));
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validator — E32 extended to tintParam", () => {
  it("rejects a tintParam naming an undeclared param (E32)", () => {
    const l = clone(makeLayer());
    l.tintParam = "nope";
    const r = validateParticle(makeDoc({ params: [{ kind: "color", name: "tint", default: white() }], layers: [l] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "layers[0].tintParam" && e.message.includes("(E32)"))).toBe(true);
  });

  it("rejects an empty-string tintParam (E32)", () => {
    const l = clone(makeLayer()) as Record<string, unknown>;
    l.tintParam = "";
    const r = validateParticle(makeDoc({ layers: [l as never] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "layers[0].tintParam")).toBe(true);
  });

  it("passes when tintParam is null (unbound)", () => {
    expect(validateParticle(makeDoc()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("round-trip — both param kinds + tintParam + all seven scalar bindings", () => {
  function boundDoc(): ParticleDoc {
    const l = clone(makeLayer({ id: "bound", space: "world" }));
    l.emission.rateOverDistance = { mode: "constant", value: 6 };
    l.emission.rateOverTimeParam = "intensity";
    l.emission.rateOverDistanceParam = "intensity";
    l.initial.speedParam = "intensity";
    l.initial.lifeParam = "intensity";
    l.initial.sizeParam = "intensity";
    l.overLifetime.velocity.gravityParam = "intensity";
    l.opacityParam = "intensity";
    l.tintParam = "tint";
    return makeDoc({
      params: [
        { kind: "scalar", name: "intensity", default: 1, min: 0, max: 2 },
        { kind: "color", name: "tint", default: { r: 0.5, g: 0.7, b: 0.9, a: 1 } },
      ],
      layers: [l],
    });
  }

  it("validates with no errors", () => {
    expect(validateParticle(boundDoc()).ok).toBe(true);
  });

  it("survives serialize -> parse deep-equal and byte-stable re-serialize", () => {
    const doc = boundDoc();
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc);
    expect(serializeParticle(back.doc!)).toBe(text);
  });

  it("emits params in canonical order (kind first) and tintParam before opacityParam", () => {
    const text = serializeParticle(boundDoc());
    // kind is the first key of a param object.
    const scalarKind = text.indexOf('"kind": "scalar"');
    const scalarName = text.indexOf('"name": "intensity"');
    expect(scalarKind).toBeGreaterThan(-1);
    expect(scalarKind).toBeLessThan(scalarName);
    const colorKind = text.indexOf('"kind": "color"');
    const colorName = text.indexOf('"name": "tint"');
    expect(colorKind).toBeLessThan(colorName);
    // The color default orders its channels r, g, b, a (match gradient keys).
    const rIdx = text.indexOf('"r": 0.5');
    const gIdx = text.indexOf('"g": 0.7');
    const bIdx = text.indexOf('"b": 0.9');
    expect(rIdx).toBeGreaterThan(-1);
    expect(rIdx).toBeLessThan(gIdx);
    expect(gIdx).toBeLessThan(bIdx);
    // tintParam sits directly before opacityParam in the layer body.
    expect(text.indexOf('"tintParam"')).toBeGreaterThan(-1);
    expect(text.indexOf('"tintParam"')).toBeLessThan(text.indexOf('"opacityParam"'));
  });

  it("a color param carries no min/max in the serialized form", () => {
    const text = serializeParticle(makeDoc({ params: [{ kind: "color", name: "tint", default: white() }] }));
    // Slice the single param object and confirm it has kind/name/default only.
    const start = text.indexOf('"params"');
    const chunk = text.slice(start, text.indexOf('"layers"'));
    expect(chunk).toContain('"kind": "color"');
    expect(chunk).not.toContain('"min"');
    expect(chunk).not.toContain('"max"');
  });
});
