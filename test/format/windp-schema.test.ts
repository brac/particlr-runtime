import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  Effect,
  type ParticleDoc,
  type WindConfig,
  type ScalarParamDef,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// WIND_PARAMS_PLAN W-M0 (schemaVersion 11): the format surface for the two wind
// host-param bindings — windStrengthParam (multiplier, identity 1) and
// windDirectionParam (degree OFFSET, identity 0). ZERO runtime behavior this
// milestone: nothing reads the fields, so a v10 doc with a non-null wind migrates to
// v11 bit-inert (both fields injected null; identity no-ops), and an unbound /
// identity-null doc renders byte-identically.

// A WindConfig with the two binding fields (defaults null = unbound).
const wind = (over: Partial<WindConfig> = {}): WindConfig => ({
  direction: 30,
  strength: { mode: "constant", value: 120 },
  gustFrequency: 0.5,
  gustAmount: 0.4,
  windStrengthParam: null,
  windDirectionParam: null,
  ...over,
});

const scalarParam = (name: string, def = 1): ScalarParamDef => ({ kind: "scalar", name, default: def, min: 0, max: 4 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docWith = (over: Record<string, any>, params: ScalarParamDef[] = []) =>
  makeDoc({ params, layers: [makeLayer(over as never)] });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = (over: Record<string, any>, params: ScalarParamDef[] = []) => validateParticle(docWith(over, params));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const errPaths = (over: Record<string, any>, params: ScalarParamDef[] = []): string[] => {
  const r = res(over, params);
  return r.ok ? [] : r.errors.map((e) => e.path);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const errMsgs = (over: Record<string, any>, params: ScalarParamDef[] = []): string[] => {
  const r = res(over, params);
  return r.ok ? [] : r.errors.map((e) => e.message);
};

// A v10-shaped doc reconstructed from a current v11 doc by stripping the WINDP
// additions (the two wind…Param fields off every non-null wind) — the pre-migration
// input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toV10(v11: ParticleDoc): any {
  const d = clone(v11) as any;
  d.schemaVersion = 10;
  for (const l of d.layers) {
    if (l.wind && typeof l.wind === "object") {
      delete l.wind.windStrengthParam;
      delete l.wind.windDirectionParam;
    }
  }
  return d;
}

function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}

// A doc whose single layer carries a non-null wind (so the migration wind-walk has
// something to inject into).
const windDoc = (): ParticleDoc => makeDoc({ layers: [makeLayer({ wind: wind() })] });

// ---------------------------------------------------------------------------
describe("v10 -> v11 migration (wind strength/direction param bindings)", () => {
  it("injects windStrengthParam/windDirectionParam null into a non-null wind and bumps to 11", () => {
    const v10 = toV10(windDoc());
    expect(v10.layers[0].wind.windStrengthParam).toBeUndefined();
    const m = migrateToCurrent(v10);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(12);
    expect(doc.layers[0]!.wind!.windStrengthParam).toBe(null);
    expect(doc.layers[0]!.wind!.windDirectionParam).toBe(null);
    // Pre-existing wind fields survive verbatim.
    expect(doc.layers[0]!.wind!.direction).toBe(30);
    expect(doc.layers[0]!.wind!.gustAmount).toBe(0.4);
  });

  it("leaves a null wind untouched (no object materialized)", () => {
    const v10 = toV10(makeDoc()); // default makeLayer: wind null
    const m = migrateToCurrent(v10);
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).layers[0]!.wind).toBe(null);
  });

  it("spread-first never clobbers a present binding", () => {
    // A v10-labelled doc that ALREADY carries the WINDP fields (hand-authored /
    // forward-written); migration must not overwrite them.
    const v10 = clone(makeDoc({ params: [scalarParam("gust")], layers: [makeLayer({ wind: wind({ windStrengthParam: "gust" }) })] })) as ParticleDoc;
    v10.schemaVersion = 10 as 11;
    const m = migrateToCurrent(v10);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect((m.doc as ParticleDoc).layers[0]!.wind!.windStrengthParam).toBe("gust");
    expect((m.doc as ParticleDoc).layers[0]!.wind!.windDirectionParam).toBe(null);
  });

  it("migration is bit-inert: stateHash of a migrated v10 doc == the hand-built v11 doc", () => {
    // Non-null wind so the wind-walk runs; nothing reads the new fields in W-M0, so
    // the migrated doc simulates identically (identity ×1 / +0 no-ops).
    const v11 = windDoc();
    const migrated = migrateToCurrent(toV10(v11));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(runHash(migrated.doc as ParticleDoc)).toBe(runHash(v11));
  });

  it("refuses a v13 document (E11 — newer than supported)", () => {
    expect(migrateToCurrent({ schemaVersion: 13 }).ok).toBe(false);
    const r = parseParticle({ ...makeDoc(), schemaVersion: 13 as 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("newer-version");
  });
});

// ---------------------------------------------------------------------------
describe("validator — E41 wind param bindings", () => {
  it("accepts null (unbound) and a valid bound name for both fields", () => {
    expect(res({ wind: wind() }).ok).toBe(true);
    expect(res({ wind: wind({ windStrengthParam: "gust" }) }, [scalarParam("gust")]).ok).toBe(true);
    expect(res({ wind: wind({ windDirectionParam: "swing" }) }, [scalarParam("swing")]).ok).toBe(true);
    expect(
      res({ wind: wind({ windStrengthParam: "gust", windDirectionParam: "swing" }) }, [scalarParam("gust"), scalarParam("swing")]).ok,
    ).toBe(true);
  });

  it("rejects a non-string binding with the E41 shape check", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rStrength = res({ wind: wind({ windStrengthParam: 5 as any }) });
    expect(rStrength.ok).toBe(false);
    if (!rStrength.ok) {
      expect(rStrength.errors.some((e) => e.path === "layers[0].wind.windStrengthParam" && e.message.includes("E41"))).toBe(true);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(errPaths({ wind: wind({ windDirectionParam: "" as any }) })).toContain("layers[0].wind.windDirectionParam");
    expect(errMsgs({ wind: wind({ windDirectionParam: "" }) }).some((m) => m.includes("E41"))).toBe(true);
  });

  it("an unknown param name fires the EXISTING cross-check (E32, not a new code)", () => {
    const r = res({ wind: wind({ windStrengthParam: "missing" }) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((x) => x.path === "layers[0].wind.windStrengthParam");
      expect(e?.message).toContain("unknown param");
      expect(e?.message).toContain("E32"); // the existing declared-name check, NOT E41
    }
  });

  it("a scalar binding naming a COLOR param is the existing kind mismatch (E34)", () => {
    const doc = makeDoc({
      params: [{ kind: "color", name: "tint", default: { r: 1, g: 1, b: 1, a: 1 } }],
      layers: [makeLayer({ wind: wind({ windStrengthParam: "tint" }) })],
    });
    const r = validateParticle(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes("E34"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("serializer — v11 round-trip + canonical order", () => {
  function boundDoc(): ParticleDoc {
    return makeDoc({
      params: [scalarParam("gust"), scalarParam("swing", 0)],
      layers: [makeLayer({ wind: wind({ windStrengthParam: "gust", windDirectionParam: "swing" }) })],
    });
  }

  it("validates with no errors", () => {
    expect(validateParticle(boundDoc()).ok).toBe(true);
  });

  it("survives serialize -> parse deep-equal and byte-stable re-serialize (both fields bound)", () => {
    const doc = boundDoc();
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc);
    expect(serializeParticle(back.doc!)).toBe(text);
  });

  it("emits the two binding fields directly after gustAmount (canonical order)", () => {
    const text = serializeParticle(boundDoc());
    const idx = (s: string) => text.indexOf(s);
    expect(idx('"gustAmount"')).toBeLessThan(idx('"windStrengthParam"'));
    expect(idx('"windStrengthParam"')).toBeLessThan(idx('"windDirectionParam"'));
  });
});
