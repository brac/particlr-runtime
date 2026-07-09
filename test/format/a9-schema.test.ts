import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  Effect,
  type ParticleDoc,
  type ParamDef,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// A9 (schemaVersion 6, A9_PLAN §M0): the format/schema surface for exposed
// runtime parameters — a doc-level `params` array + seven per-knob `…Param`
// binding fields. ZERO runtime behavior this milestone: nothing reads the fields,
// so a v5 doc migrates to v6 bit-inert (params: [], all bindings null).

// The seven bindable knobs (A9_PLAN §0.3 D4), addressed by JSON path within a
// single-layer doc for the E32 binding checks.
const BINDING_PATHS = [
  "layers[0].emission.rateOverTimeParam",
  "layers[0].emission.rateOverDistanceParam",
  "layers[0].initial.speedParam",
  "layers[0].initial.lifeParam",
  "layers[0].initial.sizeParam",
  "layers[0].overLifetime.velocity.gravityParam",
  "layers[0].opacityParam",
] as const;

// Set a binding by its JSON path on a cloned layer object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setBinding(l: any, path: string, value: string | null): void {
  if (path.endsWith("rateOverTimeParam")) l.emission.rateOverTimeParam = value;
  else if (path.endsWith("rateOverDistanceParam")) l.emission.rateOverDistanceParam = value;
  else if (path.endsWith("speedParam")) l.initial.speedParam = value;
  else if (path.endsWith("lifeParam")) l.initial.lifeParam = value;
  else if (path.endsWith("sizeParam")) l.initial.sizeParam = value;
  else if (path.endsWith("gravityParam")) l.overLifetime.velocity.gravityParam = value;
  else if (path.endsWith("opacityParam")) l.opacityParam = value;
  else throw new Error(`unknown binding path ${path}`);
}

// Validate a doc built from a base makeDoc with `params` declared and a single
// mutated layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateWith(params: ParamDef[], mutate: (l: any) => void) {
  const l = clone(makeLayer());
  mutate(l);
  return validateParticle(makeDoc({ params, layers: [l] }));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const errPaths = (params: ParamDef[], mutate: (l: any) => void): string[] => {
  const r = validateWith(params, mutate);
  return r.ok ? [] : r.errors.map((e) => e.path);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const okWith = (params: ParamDef[], mutate: (l: any) => void): boolean => validateWith(params, mutate).ok;

// A v5-shaped doc (schemaVersion 5, no params, no `…Param` bindings) reconstructed
// from a current v6 doc by stripping the A9 additions — the pre-migration input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toV5(v6: ParticleDoc): any {
  const d = clone(v6) as any;
  d.schemaVersion = 5;
  delete d.params;
  for (const l of d.layers) {
    delete l.emission.rateOverTimeParam;
    delete l.emission.rateOverDistanceParam;
    delete l.initial.speedParam;
    delete l.initial.lifeParam;
    delete l.initial.sizeParam;
    delete l.overLifetime.velocity.gravityParam;
    delete l.opacityParam;
  }
  return d;
}

function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}

// ---------------------------------------------------------------------------
describe("v5 -> v6 migration (A9)", () => {
  it("injects params: [] and all seven bindings null, bumps to 6", () => {
    const v5 = toV5(makeDoc());
    const m = migrateToCurrent(v5);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(7);
    expect(doc.params).toEqual([]);
    const l = doc.layers[0]!;
    expect(l.emission.rateOverTimeParam).toBe(null);
    expect(l.emission.rateOverDistanceParam).toBe(null);
    expect(l.initial.speedParam).toBe(null);
    expect(l.initial.lifeParam).toBe(null);
    expect(l.initial.sizeParam).toBe(null);
    expect(l.overLifetime.velocity.gravityParam).toBe(null);
    expect(l.opacityParam).toBe(null);
  });

  it("never clobbers a present params array (defaults spread first)", () => {
    const v5 = toV5(makeDoc());
    v5.params = [{ name: "intensity", default: 1, min: 0, max: 2 }];
    const m = migrateToCurrent(v5);
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).params).toEqual([{ name: "intensity", default: 1, min: 0, max: 2 }]);
  });

  it("never clobbers a present binding field (spread-after)", () => {
    const v5 = toV5(makeDoc());
    v5.params = [{ name: "intensity", default: 1, min: 0, max: 2 }];
    v5.layers[0].initial.speedParam = "intensity";
    v5.layers[0].opacityParam = "intensity";
    const m = migrateToCurrent(v5);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const l = (m.doc as ParticleDoc).layers[0]!;
    expect(l.initial.speedParam).toBe("intensity");
    expect(l.opacityParam).toBe("intensity");
    // The untouched siblings still default to null.
    expect(l.initial.lifeParam).toBe(null);
    expect(l.overLifetime.velocity.gravityParam).toBe(null);
  });

  it("is idempotent on an already-current v6 document (passes through by reference)", () => {
    const doc = makeDoc();
    const m = migrateToCurrent(doc);
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.doc).toBe(doc);
  });

  it("chains a v1 document all the way to v6 (params + bindings appear)", () => {
    const v1 = {
      ...makeDoc(),
      schemaVersion: 1,
      params: undefined,
      layers: [
        (() => {
          const l = clone(makeDoc().layers[0]!) as Record<string, unknown>;
          delete l.space;
          delete l.inheritVelocity;
          delete l.attractor;
          delete l.dissolve;
          delete l.attractorInfluence;
          delete l.limitVelocity;
          delete l.opacityParam;
          for (const k of ["noise", "bySpeed", "startColor", "randomFlip", "render", "collision"]) delete l[k];
          const em = l.emission as Record<string, unknown>;
          delete em.rateOverDistance;
          delete em.rateOverTimeParam;
          delete em.rateOverDistanceParam;
          const init = l.initial as Record<string, unknown>;
          for (const k of ["speedParam", "lifeParam", "sizeParam"]) delete init[k];
          const ol = l.overLifetime as { velocity: Record<string, unknown> };
          for (const k of ["x", "y", "orbital", "radial", "gravityParam"]) delete ol.velocity[k];
          const shape = l.shape as Record<string, unknown>;
          for (const k of ["arcMode", "arcSpeed"]) delete shape[k];
          return l;
        })(),
      ],
    };
    // Remove the leftover undefined `params` so migration injects it fresh.
    delete (v1 as { params?: unknown }).params;
    const m = migrateToCurrent(v1);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(7);
    expect(doc.params).toEqual([]);
    expect(doc.layers[0]!.space).toBe("local"); // v1->v2 still applied
    expect(doc.layers[0]!.limitVelocity).toBe(null); // v4->v5 still applied
    expect(doc.layers[0]!.opacityParam).toBe(null); // v5->v6
    expect(doc.layers[0]!.initial.speedParam).toBe(null);
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("migration is bit-inert: stateHash of a migrated v5 doc == the v6 doc", () => {
    const v6 = makeDoc();
    const migrated = migrateToCurrent(toV5(v6));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    // Nothing reads params/bindings in M0, so the migrated doc simulates
    // identically to the hand-built v6 doc (zero new draws, zero new columns).
    expect(runHash(migrated.doc as ParticleDoc)).toBe(runHash(v6));
  });
});

// ---------------------------------------------------------------------------
describe("validator — E31 params array", () => {
  it("accepts a valid params array", () => {
    expect(validateParticle(makeDoc({ params: [{ name: "intensity", default: 1, min: 0, max: 2 }] })).ok).toBe(true);
  });

  it("tolerates a document with no params field at all", () => {
    const d = clone(makeDoc()) as Record<string, unknown>;
    delete d.params;
    expect(validateParticle(d).ok).toBe(true);
  });

  it("rejects a non-array params", () => {
    const d = clone(makeDoc()) as Record<string, unknown>;
    d.params = { name: "x" };
    const r = validateParticle(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain("params");
  });

  it("rejects a name that is not a non-empty string", () => {
    expect(validateParticle(makeDoc({ params: [{ name: "", default: 1, min: 0, max: 2 }] })).ok).toBe(false);
    expect(validateParticle(makeDoc({ params: [{ name: 5 as unknown as string, default: 1, min: 0, max: 2 }] })).ok).toBe(false);
  });

  it("rejects duplicate names", () => {
    const r = validateParticle(makeDoc({
      params: [
        { name: "a", default: 1, min: 0, max: 2 },
        { name: "a", default: 1, min: 0, max: 2 },
      ],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "params[1].name")).toBe(true);
  });

  it("rejects non-finite default/min/max", () => {
    expect(validateParticle(makeDoc({ params: [{ name: "a", default: NaN, min: 0, max: 2 }] })).ok).toBe(false);
    expect(validateParticle(makeDoc({ params: [{ name: "a", default: 1, min: Infinity, max: 2 }] })).ok).toBe(false);
    expect(validateParticle(makeDoc({ params: [{ name: "a", default: 1, min: 0, max: "x" as unknown as number }] })).ok).toBe(false);
  });

  it("rejects min > max", () => {
    const r = validateParticle(makeDoc({ params: [{ name: "a", default: 1, min: 3, max: 2 }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "params[0]")).toBe(true);
  });

  it("rejects a default outside [min, max]", () => {
    expect(validateParticle(makeDoc({ params: [{ name: "a", default: 5, min: 0, max: 2 }] })).ok).toBe(false);
    expect(validateParticle(makeDoc({ params: [{ name: "a", default: -1, min: 0, max: 2 }] })).ok).toBe(false);
  });

  it("accepts default exactly at the bounds", () => {
    expect(validateParticle(makeDoc({ params: [{ name: "lo", default: 0, min: 0, max: 2 }] })).ok).toBe(true);
    expect(validateParticle(makeDoc({ params: [{ name: "hi", default: 2, min: 0, max: 2 }] })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validator — E32 dangling / malformed bindings", () => {
  const params: ParamDef[] = [{ name: "intensity", default: 1, min: 0, max: 2 }];

  it("passes when every binding is null (the unbound v5 path)", () => {
    expect(okWith([], () => {})).toBe(true);
  });

  it("passes when each of the seven bindings names a declared param", () => {
    for (const path of BINDING_PATHS) {
      expect(okWith(params, (l) => setBinding(l, path, "intensity")), path).toBe(true);
    }
  });

  it("rejects each of the seven bindings when it names an undeclared param", () => {
    for (const path of BINDING_PATHS) {
      expect(errPaths(params, (l) => setBinding(l, path, "nope")), path).toContain(path);
    }
  });

  it("rejects a binding declared but with an empty params list", () => {
    for (const path of BINDING_PATHS) {
      expect(errPaths([], (l) => setBinding(l, path, "intensity")), path).toContain(path);
    }
  });

  it("rejects a non-null binding that is not a non-empty string", () => {
    // number
    expect(errPaths(params, (l) => setBinding(l, "layers[0].initial.speedParam", 3 as unknown as string)))
      .toContain("layers[0].initial.speedParam");
    // empty string
    expect(errPaths(params, (l) => setBinding(l, "layers[0].opacityParam", ""))).toContain("layers[0].opacityParam");
  });
});

// ---------------------------------------------------------------------------
describe("round-trip — params + all seven bindings populated", () => {
  function boundDoc(): ParticleDoc {
    const l = clone(makeLayer({ id: "bound", space: "world" }));
    // A real rate-over-distance knob so its binding drives an actual value.
    l.emission.rateOverDistance = { mode: "constant", value: 6 };
    l.emission.rateOverTimeParam = "intensity";
    l.emission.rateOverDistanceParam = "intensity";
    l.initial.speedParam = "intensity";
    l.initial.lifeParam = "intensity";
    l.initial.sizeParam = "intensity";
    l.overLifetime.velocity.gravityParam = "intensity";
    l.opacityParam = "opacity";
    return makeDoc({
      params: [
        { name: "intensity", default: 1, min: 0, max: 2 },
        { name: "opacity", default: 1, min: 0, max: 1 },
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

  it("emits the A9 fields in canonical order", () => {
    const text = serializeParticle(boundDoc());
    // doc-level params after seed, before layers.
    expect(text.indexOf('"params"')).toBeGreaterThan(text.indexOf('"seed"'));
    expect(text.indexOf('"params"')).toBeLessThan(text.indexOf('"layers"'));
    // each rate binding directly after its knob.
    expect(text.indexOf('"rateOverTimeParam"')).toBeGreaterThan(text.indexOf('"rateOverTime"'));
    expect(text.indexOf('"rateOverDistanceParam"')).toBeGreaterThan(text.indexOf('"rateOverDistance"'));
    // param object orders name, default, min, max.
    const nameIdx = text.indexOf('"name": "intensity"');
    const defIdx = text.indexOf('"default"');
    expect(defIdx).toBeGreaterThan(nameIdx);
  });
});
