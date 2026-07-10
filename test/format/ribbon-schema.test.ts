import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  Effect,
  TRAIL_MODES,
  type ParticleDoc,
  type Layer,
  type TrailConfig,
  type SubEmitterRef,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// RIBBON_INHERIT_PLAN (schemaVersion 9, §M0): the connect-ribbon trail `mode` +
// the three sub-emitter inheritance flags. ZERO runtime behavior this milestone —
// nothing reads mode or the flags, so a v8 doc migrates to v9 bit-inert (a non-null
// trail gains mode:"perParticle", each subEmitter entry gains three false flags).

// --- fixtures --------------------------------------------------------------
const perParticleTrail = (): TrailConfig => ({
  mode: "perParticle",
  maxPoints: 8,
  minVertexDistance: 3,
  width: { mode: "constant", value: 4 },
  color: null,
});

// A sub-emitter parent (death-triggers a sibling) with all-false inherit flags.
const ref = (over: Partial<SubEmitterRef> = {}): SubEmitterRef => ({
  trigger: "death",
  layerId: "child",
  count: 5,
  probability: 1,
  inheritVelocity: 0,
  inheritColor: false,
  inheritSize: false,
  inheritRotation: false,
  ...over,
});

const parentLayer = (over: Partial<SubEmitterRef> = {}): Layer =>
  makeLayer({ id: "parent", trail: perParticleTrail(), subEmitters: [ref(over)] });

const childLayer = (): Layer => {
  const l = makeLayer({ id: "child" });
  l.emission.rateOverTime = { mode: "constant", value: 0 }; // children emit only on trigger
  return l;
};

const ribbonDoc = (over: Partial<SubEmitterRef> = {}): ParticleDoc =>
  makeDoc({ layers: [parentLayer(over), childLayer()] });

// A v8-shaped doc reconstructed from a current v9 doc by stripping the v9 additions
// (mode off every non-null trail, the three flags off every subEmitter entry) — the
// pre-migration input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toV8(v9: ParticleDoc): any {
  const d = clone(v9) as any;
  d.schemaVersion = 8;
  for (const l of d.layers) {
    if (l.trail && typeof l.trail === "object") delete l.trail.mode;
    if (Array.isArray(l.subEmitters))
      for (const s of l.subEmitters) {
        delete s.inheritColor;
        delete s.inheritSize;
        delete s.inheritRotation;
      }
  }
  return d;
}

function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}

// ---------------------------------------------------------------------------
describe("v8 -> v9 migration (connect ribbon mode + inherit flags)", () => {
  it("injects mode:perParticle on a non-null trail and three false flags on each subEmitter entry, bumps to 9", () => {
    const v9 = ribbonDoc();
    const v8 = toV8(v9);
    // sanity: the lowered input carries none of the v9 additions.
    expect(v8.layers[0].trail.mode).toBeUndefined();
    expect(v8.layers[0].subEmitters[0].inheritColor).toBeUndefined();
    const m = migrateToCurrent(v8);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(9);
    expect(doc.layers[0]!.trail!.mode).toBe("perParticle");
    const s = doc.layers[0]!.subEmitters![0]!;
    expect(s.inheritColor).toBe(false);
    expect(s.inheritSize).toBe(false);
    expect(s.inheritRotation).toBe(false);
    // The captured floats untouched by the walk survive verbatim.
    expect(s.inheritVelocity).toBe(0);
  });

  it("leaves a null trail and null subEmitters untouched (no object materialized)", () => {
    const v8 = toV8(makeDoc()); // default makeLayer: trail null, subEmitters null
    const m = migrateToCurrent(v8);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const l = (m.doc as ParticleDoc).layers[0]!;
    expect(l.trail).toBe(null);
    expect(l.subEmitters).toBe(null);
  });

  it("spread-first never clobbers a pre-existing mode:connect or a true flag", () => {
    const v8 = toV8(ribbonDoc());
    v8.layers[0].trail.mode = "connect"; // author already chose connect
    v8.layers[0].subEmitters[0].inheritColor = true; // author already opted in
    const m = migrateToCurrent(v8);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.layers[0]!.trail!.mode).toBe("connect");
    expect(doc.layers[0]!.subEmitters![0]!.inheritColor).toBe(true);
    // The other two flags still default to false.
    expect(doc.layers[0]!.subEmitters![0]!.inheritSize).toBe(false);
    expect(doc.layers[0]!.subEmitters![0]!.inheritRotation).toBe(false);
  });

  it("chains a v1 document all the way to v9 (mode + flags appear)", () => {
    // A minimal v1 layer with a trail + a sub-emitter, stripped of every field added
    // in v2..v9 so the full chain has to inject them and land on 9.
    const p = clone(ribbonDoc().layers[0]!) as Record<string, unknown>;
    const c = clone(ribbonDoc().layers[1]!) as Record<string, unknown>;
    for (const l of [p, c]) {
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
    }
    // Strip the v9 additions off the trail/sub-emitter too.
    delete (p.trail as Record<string, unknown>).mode;
    for (const s of p.subEmitters as Record<string, unknown>[]) {
      delete s.inheritColor; delete s.inheritSize; delete s.inheritRotation;
    }

    const v1: Record<string, unknown> = { ...makeDoc(), schemaVersion: 1, layers: [p, c] };
    delete v1.params;

    const m = migrateToCurrent(v1);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(9);
    expect(doc.layers[0]!.space).toBe("local"); // v1->v2 still applied
    expect(doc.layers[0]!.trail!.mode).toBe("perParticle"); // v8->v9
    expect(doc.layers[0]!.subEmitters![0]!.inheritSize).toBe(false); // v8->v9
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("migration is bit-inert: stateHash of a migrated v8 doc == the hand-built v9 doc", () => {
    const v9 = ribbonDoc();
    const migrated = migrateToCurrent(toV8(v9));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    // Nothing reads mode or the flags in M0, so the migrated doc simulates identically.
    expect(runHash(migrated.doc as ParticleDoc)).toBe(runHash(v9));
  });
});

// ---------------------------------------------------------------------------
describe("validator — trail mode (schemaVersion 9)", () => {
  it("TRAIL_MODES exposes exactly the two modes", () => {
    expect([...TRAIL_MODES]).toEqual(["perParticle", "connect"]);
  });

  it("accepts both perParticle and connect", () => {
    for (const mode of ["perParticle", "connect"] as const) {
      const l = makeLayer({ trail: { ...perParticleTrail(), mode } });
      expect(validateParticle(makeDoc({ layers: [l] })).ok).toBe(true);
    }
  });

  it("rejects a junk trail mode", () => {
    const l = clone(makeLayer({ trail: perParticleTrail() })) as Record<string, unknown>;
    (l.trail as Record<string, unknown>).mode = "ribbon";
    const r = validateParticle(makeDoc({ layers: [l as never] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "layers[0].trail.mode")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validator — E35 sub-emitter inherit flags", () => {
  it("accepts valid boolean flags (including all true)", () => {
    const doc = ribbonDoc({ inheritColor: true, inheritSize: true, inheritRotation: true });
    expect(validateParticle(doc).ok).toBe(true);
  });

  it("rejects a non-boolean flag (E35)", () => {
    for (const flag of ["inheritColor", "inheritSize", "inheritRotation"] as const) {
      const doc = ribbonDoc();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (doc.layers[0]!.subEmitters![0] as any)[flag] = "yes";
      const r = validateParticle(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.errors.find((x) => x.path === `layers[0].subEmitters[0].${flag}`);
        expect(e).toBeDefined();
        expect(e!.message).toContain("(E35)");
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("round-trip — connect trail + a sub-emitter with all three flags true", () => {
  function fullDoc(): ParticleDoc {
    const parent = makeLayer({
      id: "parent",
      trail: { ...perParticleTrail(), mode: "connect" },
      subEmitters: [ref({ inheritColor: true, inheritSize: true, inheritRotation: true })],
    });
    return makeDoc({ layers: [parent, childLayer()] });
  }

  it("validates with no errors", () => {
    expect(validateParticle(fullDoc()).ok).toBe(true);
  });

  it("survives serialize -> parse deep-equal and byte-stable re-serialize", () => {
    const doc = fullDoc();
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc);
    expect(back.doc!.layers[0]!.trail!.mode).toBe("connect");
    expect(serializeParticle(back.doc!)).toBe(text);
  });

  it("emits mode as the first trail key and the flags directly after inheritVelocity", () => {
    const text = serializeParticle(fullDoc());
    // mode precedes maxPoints inside the trail object.
    const modeIdx = text.indexOf('"mode": "connect"');
    const maxPointsIdx = text.indexOf('"maxPoints"');
    expect(modeIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeLessThan(maxPointsIdx);
    // The three flags follow inheritVelocity, in canonical order.
    const iv = text.indexOf('"inheritVelocity"');
    const ic = text.indexOf('"inheritColor"');
    const is = text.indexOf('"inheritSize"');
    const ir = text.indexOf('"inheritRotation"');
    expect(iv).toBeGreaterThan(-1);
    expect(iv).toBeLessThan(ic);
    expect(ic).toBeLessThan(is);
    expect(is).toBeLessThan(ir);
  });
});
