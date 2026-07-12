import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  Effect,
  type ParticleDoc,
  type Shape,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// CURVES C-M1 (schemaVersion 12): the FORMAT surface for polyline smoothing — E42
// validation, the inert v11 → v12 shape-restamp (smoothing:0 injected, bit-identical),
// canonical serialize order, round-trip byte-stability, and refusal at v13.

type PolyShape = Extract<Shape, { kind: "polyline" }>;
const poly = (over: Partial<PolyShape> = {}): PolyShape => ({
  kind: "polyline",
  points: [{ x: -40, y: 0 }, { x: 0, y: -30 }, { x: 40, y: 0 }],
  closed: false,
  smoothing: 0,
  direction: "normal",
  emitFrom: "volume",
  ...over,
});
const res = (shape: PolyShape) => validateParticle(makeDoc({ layers: [makeLayer({ shape })] }));
const ok = (shape: PolyShape): boolean => res(shape).ok;
const errFor = (shape: PolyShape) => {
  const r = res(shape);
  return r.ok ? [] : r.errors;
};

function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}

// A v11-shaped doc: strip `smoothing` off every polyline shape and label it v11 — the
// pre-migration input the v11 → v12 walk restamps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toV11(v12: ParticleDoc): any {
  const d = clone(v12) as any;
  d.schemaVersion = 11;
  for (const l of d.layers) {
    if (l.shape && l.shape.kind === "polyline") delete l.shape.smoothing;
  }
  return d;
}

// ---------------------------------------------------------------------------
describe("validator — E42 polyline smoothing", () => {
  it("accepts smoothing at 0, mid, and 1", () => {
    expect(ok(poly({ smoothing: 0 }))).toBe(true);
    expect(ok(poly({ smoothing: 0.5 }))).toBe(true);
    expect(ok(poly({ smoothing: 1 }))).toBe(true);
  });

  it("rejects out-of-range and non-finite smoothing with an E42 message", () => {
    for (const bad of [2, -0.1, 1.0001]) {
      const errs = errFor(poly({ smoothing: bad }));
      expect(errs.some((e) => e.path === "layers[0].shape.smoothing")).toBe(true);
      expect(errs.some((e) => e.message.includes("E42"))).toBe(true);
    }
    for (const bad of [NaN, Infinity, -Infinity]) {
      const errs = errFor(poly({ smoothing: bad as number }));
      expect(errs.some((e) => e.path === "layers[0].shape.smoothing")).toBe(true);
    }
  });

  it("tolerates an ABSENT smoothing (legacy shape) — treated as 0, still valid", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacy = poly() as any;
    delete legacy.smoothing;
    expect(res(legacy).ok).toBe(true);
  });

  it("degeneracy (E37) still keys on straight-point length regardless of smoothing", () => {
    const dead = poly({ points: [{ x: 5, y: 5 }, { x: 5, y: 5 }], smoothing: 1 });
    const r = res(dead);
    expect(r.warnings.some((w) => w.code === "bad-polyline")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("v11 -> v12 migration (polyline smoothing shape restamp)", () => {
  const polyDoc = (smoothing = 0): ParticleDoc =>
    makeDoc({ layers: [makeLayer({ shape: poly({ smoothing }) })] });

  it("injects smoothing:0 into every polyline shape and bumps to 12", () => {
    const v11 = toV11(polyDoc(0));
    expect(v11.layers[0].shape.smoothing).toBeUndefined();
    const m = migrateToCurrent(v11);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(12);
    expect((doc.layers[0]!.shape as PolyShape).smoothing).toBe(0);
  });

  it("spread-first never clobbers a hand-authored smoothing", () => {
    const v11 = clone(polyDoc(0.7)) as ParticleDoc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v11 as any).schemaVersion = 11;
    const m = migrateToCurrent(v11);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(((m.doc as ParticleDoc).layers[0]!.shape as PolyShape).smoothing).toBe(0.7);
  });

  it("leaves non-polyline shapes untouched (no smoothing materialized)", () => {
    const v11 = toV11(makeDoc()); // default makeLayer: cone shape
    const m = migrateToCurrent(v11);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect((m.doc as ParticleDoc).layers[0]!.shape).not.toHaveProperty("smoothing");
  });

  it("is bit-inert: a migrated v11 polyline doc runs identically to the hand-built v12 doc", () => {
    const v12 = polyDoc(0);
    const migrated = migrateToCurrent(toV11(v12));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(runHash(migrated.doc as ParticleDoc)).toBe(runHash(v12));
  });

  it("refuses a v13 document (E11 — newer than supported)", () => {
    expect(migrateToCurrent({ schemaVersion: 13 }).ok).toBe(false);
    const r = parseParticle({ ...makeDoc(), schemaVersion: 13 as 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("newer-version");
  });
});

// ---------------------------------------------------------------------------
describe("serializer — polyline smoothing round-trip + canonical order", () => {
  it("emits smoothing directly after closed, before direction", () => {
    const text = serializeParticle(makeDoc({ layers: [makeLayer({ shape: poly({ smoothing: 0.8 }) })] }));
    const iClosed = text.indexOf('"closed"');
    const iSmooth = text.indexOf('"smoothing"');
    const iDir = text.indexOf('"direction"');
    expect(iClosed).toBeGreaterThan(-1);
    expect(iSmooth).toBeGreaterThan(iClosed);
    expect(iDir).toBeGreaterThan(iSmooth);
  });

  for (const smoothing of [0, 0.8]) {
    it(`survives serialize -> parse deep-equal and byte-stable re-serialize (smoothing:${smoothing})`, () => {
      const doc = makeDoc({ layers: [makeLayer({ shape: poly({ smoothing, closed: true, direction: "outward" }) })] });
      const text = serializeParticle(doc);
      const back = parseParticle(text);
      expect(back.ok).toBe(true);
      expect(back.doc).toEqual(doc);
      expect(serializeParticle(back.doc!)).toBe(text);
    });
  }
});
