import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { presetsDir, hasPresets } from "../_presets.js";
import { resolve } from "node:path";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  evalScalarTrack,
  evalCurve,
  Effect,
  type ParticleDoc,
  type ScalarTrack,
  type CurveKey,
  type ValidationIssue,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// A per-particle blend-between-two-curves track (A5, schemaVersion 5).
const rbc = (): ScalarTrack => ({
  mode: "randomBetweenCurves",
  a: [{ t: 0, v: 0 }, { t: 1, v: 1 }],
  b: [{ t: 0, v: 10 }, { t: 1, v: 20 }],
});
const rangeTrack = (): ScalarTrack => ({ mode: "range", min: 0, max: 1 });

// Validate a single-layer doc after mutating a cloned base layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateWith(mutate: (l: any) => void) {
  const l = clone(makeLayer());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutate(l as any);
  return validateParticle(makeDoc({ layers: [l] }));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const errPaths = (mutate: (l: any) => void): string[] => {
  const r = validateWith(mutate);
  return r.ok ? [] : r.errors.map((e) => e.path);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const okWith = (mutate: (l: any) => void): boolean => validateWith(mutate).ok;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const warnsWith = (mutate: (l: any) => void): ValidationIssue[] => {
  const r = validateWith(mutate);
  return r.warnings;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hasUnimpl = (mutate: (l: any) => void, path: string): boolean =>
  warnsWith(mutate).some((w) => w.code === "unimplemented" && w.path === path);

// ---------------------------------------------------------------------------
describe("v4 -> v5 migration", () => {
  it("injects the inert limitVelocity: null default per layer (spread-after) and bumps to 5", () => {
    const v4 = (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const l = clone(makeLayer()) as any;
      delete l.limitVelocity;
      return { ...makeDoc(), schemaVersion: 4, layers: [l] };
    })();
    const m = migrateToCurrent(v4);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(12); // migrateToCurrent chains to CURRENT (now 12)
    expect(doc.layers[0]!.limitVelocity).toBe(null);
  });

  it("never clobbers a present limitVelocity (defaults spread first)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l = clone(makeLayer()) as any;
    l.limitVelocity = { mode: "constant", value: 300 };
    const m = migrateToCurrent({ ...makeDoc(), schemaVersion: 4, layers: [l] });
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).layers[0]!.limitVelocity).toEqual({ mode: "constant", value: 300 });
  });

  it("walks a flipbook and injects randomStartFrame:false, frameOverLife:null when frames non-null", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l = clone(makeLayer()) as any;
    delete l.limitVelocity;
    l.texture = { ref: "spark", frames: { cols: 2, rows: 2, fps: 12, mode: "loop" } };
    const m = migrateToCurrent({ ...makeDoc(), schemaVersion: 4, layers: [l] });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const frames = (m.doc as ParticleDoc).layers[0]!.texture.frames!;
    expect(frames.randomStartFrame).toBe(false);
    expect(frames.frameOverLife).toBe(null);
    // Existing flipbook fields survive untouched.
    expect(frames.cols).toBe(2);
    expect(frames.mode).toBe("loop");
  });

  it("never clobbers present flipbook fields (spread-after)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l = clone(makeLayer()) as any;
    l.texture = { ref: "spark", frames: { cols: 2, rows: 2, fps: 12, mode: "loop", randomStartFrame: true, frameOverLife: { mode: "constant", value: 0.5 } } };
    const m = migrateToCurrent({ ...makeDoc(), schemaVersion: 4, layers: [l] });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const frames = (m.doc as ParticleDoc).layers[0]!.texture.frames!;
    expect(frames.randomStartFrame).toBe(true);
    expect(frames.frameOverLife).toEqual({ mode: "constant", value: 0.5 });
  });

  it("leaves a null flipbook (frames: null) untouched (no nested walk)", () => {
    const m = migrateToCurrent({ ...makeDoc(), schemaVersion: 4 });
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).layers[0]!.texture.frames).toBe(null);
  });

  it("is idempotent on an already-current v5 document (passes through by reference)", () => {
    const doc = makeDoc();
    const m = migrateToCurrent(doc);
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.doc).toBe(doc);
  });

  it("refuses a v13 document (E11)", () => {
    expect(migrateToCurrent({ schemaVersion: 13 }).ok).toBe(false);
    const r = parseParticle({ ...makeDoc(), schemaVersion: 13 as 12 });
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
          delete l.limitVelocity;
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
    expect(doc.schemaVersion).toBe(12); // migrateToCurrent chains to CURRENT (now 12)
    expect(doc.layers[0]!.space).toBe("local"); // v1->v2
    expect(doc.layers[0]!.noise).toBe(null); // v2->v3
    expect(doc.layers[0]!.attractor).toBe(null); // v3->v4
    expect(doc.layers[0]!.limitVelocity).toBe(null); // v4->v5
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("chains a v3 document to v5", () => {
    const v3 = {
      ...makeDoc(),
      schemaVersion: 3,
      layers: [
        (() => {
          const l = clone(makeDoc().layers[0]!) as Record<string, unknown>;
          delete l.attractor;
          delete l.dissolve;
          delete l.attractorInfluence;
          delete l.limitVelocity;
          return l;
        })(),
      ],
    };
    const m = migrateToCurrent(v3);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(12); // migrateToCurrent chains to CURRENT (now 12)
    expect(doc.layers[0]!.attractorInfluence).toBe(0); // v3->v4
    expect(doc.layers[0]!.limitVelocity).toBe(null); // v4->v5
  });
});

// ---------------------------------------------------------------------------
describe("validator — A5 randomBetweenCurves tier matrix (§0.2, E28)", () => {
  it("accepts randomBetweenCurves on all eight per-particle over-lifetime tracks", () => {
    expect(okWith((l) => (l.overLifetime.size = rbc()))).toBe(true);
    expect(okWith((l) => (l.overLifetime.rotation = rbc()))).toBe(true);
    for (const key of ["drag", "speedMultiplier", "x", "y", "orbital", "radial"] as const) {
      expect(okWith((l) => (l.overLifetime.velocity[key] = rbc())), key).toBe(true);
    }
  });

  it("fires NO unimplemented warning for randomBetweenCurves (evaluator is live from M0)", () => {
    expect(warnsWith((l) => (l.overLifetime.size = rbc())).some((w) => w.code === "unimplemented")).toBe(false);
  });

  it("rejects randomBetweenCurves on emission.rateOverTime (emitter-level, E28)", () => {
    expect(errPaths((l) => (l.emission.rateOverTime = rbc()))).toContain("layers[0].emission.rateOverTime.mode");
  });

  it("rejects randomBetweenCurves on every constant/curve-only (NoRange) track", () => {
    expect(errPaths((l) => (l.noise = { strength: rbc(), frequency: 0.5, scrollSpeed: 0, octaves: 1 }))).toContain("layers[0].noise.strength.mode");
    expect(errPaths((l) => (l.bySpeed = { range: { min: 0, max: 1 }, size: rbc(), color: null, rotation: null }))).toContain("layers[0].bySpeed.size.mode");
    expect(errPaths((l) => (l.bySpeed = { range: { min: 0, max: 1 }, size: null, color: null, rotation: rbc() }))).toContain("layers[0].bySpeed.rotation.mode");
    expect(errPaths((l) => (l.trail = { maxPoints: 8, minVertexDistance: 2, width: rbc(), color: null }))).toContain("layers[0].trail.width.mode");
    expect(errPaths((l) => (l.attractor = { x: 0, y: 0, strength: rbc(), tangential: null, radius: 100, falloff: "none", killRadius: 0 }))).toContain("layers[0].attractor.strength.mode");
    expect(errPaths((l) => (l.attractor = { x: 0, y: 0, strength: { mode: "constant", value: 1 }, tangential: rbc(), radius: 100, falloff: "none", killRadius: 0 }))).toContain("layers[0].attractor.tangential.mode");
  });

  it("rejects randomBetweenCurves AND range on A4 limitVelocity (NoRange track)", () => {
    expect(errPaths((l) => (l.limitVelocity = rbc()))).toContain("layers[0].limitVelocity.mode");
    expect(errPaths((l) => (l.limitVelocity = rangeTrack()))).toContain("layers[0].limitVelocity.mode");
  });

  it("still accepts constant/curve on limitVelocity", () => {
    expect(okWith((l) => (l.limitVelocity = { mode: "constant", value: 300 }))).toBe(true);
    expect(okWith((l) => (l.limitVelocity = { mode: "curve", keys: [{ t: 0, v: 500 }, { t: 1, v: 50 }] }))).toBe(true);
  });
});

describe("validator — A6 hueJitter", () => {
  it("accepts degrees in [0, 180]", () => {
    for (const d of [0, 90, 180]) {
      expect(okWith((l) => (l.startColor = { mode: "hueJitter", degrees: d })), String(d)).toBe(true);
    }
  });

  it("rejects degrees out of [0, 180] or non-finite", () => {
    expect(errPaths((l) => (l.startColor = { mode: "hueJitter", degrees: -1 }))).toContain("layers[0].startColor.degrees");
    expect(errPaths((l) => (l.startColor = { mode: "hueJitter", degrees: 181 }))).toContain("layers[0].startColor.degrees");
    expect(errPaths((l) => (l.startColor = { mode: "hueJitter", degrees: Infinity }))).toContain("layers[0].startColor.degrees");
  });
});

describe("validator — A7 flipbook fields", () => {
  const fb = (over: Record<string, unknown> = {}) => ({ ref: "spark", frames: { cols: 2, rows: 2, fps: 12, mode: "loop", randomStartFrame: false, frameOverLife: null, ...over } });

  it("accepts valid randomStartFrame + frameOverLife", () => {
    expect(okWith((l) => (l.texture = fb()))).toBe(true);
    expect(okWith((l) => (l.texture = fb({ randomStartFrame: true })))).toBe(true);
    expect(okWith((l) => (l.texture = fb({ frameOverLife: { mode: "curve", keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } })))).toBe(true);
  });

  it("requires randomStartFrame to be a boolean", () => {
    expect(errPaths((l) => (l.texture = fb({ randomStartFrame: "yes" })))).toContain("layers[0].texture.frames.randomStartFrame");
  });

  it("rejects range/randomBetweenCurves on frameOverLife (deterministic track)", () => {
    expect(errPaths((l) => (l.texture = fb({ frameOverLife: rangeTrack() })))).toContain("layers[0].texture.frames.frameOverLife.mode");
    expect(errPaths((l) => (l.texture = fb({ frameOverLife: rbc() })))).toContain("layers[0].texture.frames.frameOverLife.mode");
  });
});

describe("no unimplemented warnings remain (A4/A5/A6/A7 all live)", () => {
  // The entire v5 batch has landed (A4 M1, A5 M0 evaluator + M2 authoring, A6 M3,
  // A7 M4 render). No feature in the plan draws an "unimplemented" warning anymore.
  it("A4 limitVelocity (non-null) does NOT warn unimplemented (M1)", () => {
    expect(hasUnimpl((l) => (l.limitVelocity = { mode: "constant", value: 300 }), "layers[0].limitVelocity")).toBe(false);
  });
  it("A6 hueJitter does NOT warn unimplemented (M3)", () => {
    expect(hasUnimpl((l) => (l.startColor = { mode: "hueJitter", degrees: 30 }), "layers[0].startColor.mode")).toBe(false);
  });
  it("A7 flipbook randomStartFrame:true does NOT warn unimplemented (M4)", () => {
    expect(hasUnimpl((l) => (l.texture = { ref: "spark", frames: { cols: 2, rows: 2, fps: 12, mode: "loop", randomStartFrame: true, frameOverLife: null } }), "layers[0].texture.frames")).toBe(false);
  });
  it("A7 flipbook frameOverLife (non-null) does NOT warn unimplemented (M4)", () => {
    expect(hasUnimpl((l) => (l.texture = { ref: "spark", frames: { cols: 2, rows: 2, fps: 12, mode: "loop", randomStartFrame: false, frameOverLife: { mode: "constant", value: 0.5 } } }), "layers[0].texture.frames")).toBe(false);
  });
  it("A5 randomBetweenCurves does NOT warn unimplemented", () => {
    expect(warnsWith((l) => (l.overLifetime.size = rbc())).some((w) => w.code === "unimplemented")).toBe(false);
  });
  it("a layer touching all four v5 features fires NO unimplemented warning anywhere", () => {
    const warns = warnsWith((l) => {
      l.limitVelocity = { mode: "constant", value: 300 };
      l.overLifetime.size = rbc();
      l.startColor = { mode: "hueJitter", degrees: 30 };
      l.texture = { ref: "spark", frames: { cols: 2, rows: 2, fps: 12, mode: "loop", randomStartFrame: true, frameOverLife: { mode: "constant", value: 0.5 } } };
    });
    expect(warns.some((w) => w.code === "unimplemented")).toBe(false);
  });
  it("an inert v5 layer (all defaults) fires no unimplemented warnings", () => {
    expect(validateParticle(makeDoc()).ok).toBe(true);
    expect((validateParticle(makeDoc()) as { warnings: ValidationIssue[] }).warnings.some((w) => w.code === "unimplemented")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("evalScalarTrack — randomBetweenCurves (§0.3b)", () => {
  const a: CurveKey[] = [{ t: 0, v: 0 }, { t: 1, v: 10 }];
  const b: CurveKey[] = [{ t: 0, v: 100 }, { t: 1, v: 200 }];
  const track: ScalarTrack = { mode: "randomBetweenCurves", a, b };

  it("particleRand=0 returns curve a; =1 returns curve b; =0.5 the midpoint", () => {
    // At t=0: a=0, b=100.
    expect(evalScalarTrack(track, 0, 0)).toBe(0);
    expect(evalScalarTrack(track, 0, 1)).toBe(100);
    expect(evalScalarTrack(track, 0, 0.5)).toBe(50);
    // At t=1: a=10, b=200.
    expect(evalScalarTrack(track, 1, 0)).toBe(10);
    expect(evalScalarTrack(track, 1, 1)).toBe(200);
    expect(evalScalarTrack(track, 1, 0.5)).toBeCloseTo(105, 12);
  });

  it("respects curve eases (delegates to evalCurve for both a and b)", () => {
    const ea: CurveKey[] = [{ t: 0, v: 0, ease: "step" }, { t: 1, v: 10 }];
    const eb: CurveKey[] = [{ t: 0, v: 100, ease: "easeIn" }, { t: 1, v: 200 }];
    const t: ScalarTrack = { mode: "randomBetweenCurves", a: ea, b: eb };
    for (const [tt, rr] of [[0.3, 0.25], [0.5, 0.5], [0.8, 0.9]] as const) {
      const av = evalCurve(ea, tt);
      const bv = evalCurve(eb, tt);
      expect(evalScalarTrack(t, tt, rr)).toBeCloseTo(av + (bv - av) * rr, 12);
    }
  });
});

// ---------------------------------------------------------------------------
describe("maximal v5 document — byte-stable round-trip (all four features)", () => {
  function maximalV5(): ParticleDoc {
    return makeDoc({
      layers: [
        makeLayer({
          id: "v5",
          texture: {
            ref: "spark",
            frames: { cols: 4, rows: 1, fps: 20, mode: "once", randomStartFrame: true, frameOverLife: { mode: "curve", keys: [{ t: 0, v: 0, ease: "easeOut" }, { t: 1, v: 1 }] } },
          },
          // A4 limit-velocity (constant/curve only).
          limitVelocity: { mode: "curve", keys: [{ t: 0, v: 400, ease: "easeOut" }, { t: 1, v: 40 }] },
          // A5 randomBetweenCurves on a per-particle track.
          overLifetime: {
            size: { mode: "randomBetweenCurves", a: [{ t: 0, v: 1, ease: "easeOut" }, { t: 1, v: 0 }], b: [{ t: 0, v: 0.5 }, { t: 1, v: 2 }] },
            color: { keys: [{ t: 0, r: 1, g: 0.8, b: 0.3, a: 1 }, { t: 1, r: 1, g: 0.1, b: 0, a: 0 }] },
            rotation: null,
            velocity: { gravity: { x: 0, y: 30 }, gravityParam: null, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
          },
          // A6 hueJitter startColor.
          startColor: { mode: "hueJitter", degrees: 45 },
        }),
      ],
    });
  }

  it("validates (only the M0 unimplemented / authoring warnings, no errors)", () => {
    const r = validateParticle(maximalV5());
    expect(r.ok).toBe(true);
  });

  it("round-trips byte-stably and deep-equal", () => {
    const doc = maximalV5();
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc);
    expect(serializeParticle(back.doc!)).toBe(text);
  });

  it("emits the v5 fields in canonical order", () => {
    const text = serializeParticle(maximalV5());
    // limitVelocity directly after overLifetime, before noise.
    expect(text.indexOf('"limitVelocity"')).toBeGreaterThan(text.indexOf('"overLifetime"'));
    expect(text.indexOf('"limitVelocity"')).toBeLessThan(text.indexOf('"noise"'));
    // flipbook randomStartFrame + frameOverLife after mode.
    expect(text.indexOf('"randomStartFrame"')).toBeGreaterThan(text.indexOf('"mode"'));
    expect(text.indexOf('"frameOverLife"')).toBeGreaterThan(text.indexOf('"randomStartFrame"'));
    // randomBetweenCurves arm orders mode, a, b.
    expect(text.indexOf('"randomBetweenCurves"')).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// Every committed preset: the v4->v5 migration is bit-inert. Simulating the
// migrated-from-v4 form yields the SAME stateHash as the committed v5 preset.
// No snapshot / no `-u`: a direct equality against the reconstructed digest.
function loadPreset(name: string): ParticleDoc {
  const r = parseParticle(readFileSync(resolve(presetsDir, name), "utf8"));
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.errors)}`);
  return r.doc!;
}
function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}
const presetNames = hasPresets ? readdirSync(presetsDir).filter((f) => f.endsWith(".prt")).sort() : [];

describe.skipIf(!hasPresets)("migrated-preset stateHash pin (v4 -> v5 is bit-inert)", () => {
  for (const name of presetNames) {
    it(`${name}`, () => {
      const v5 = loadPreset(name); // committed form (already v5)
      // Reconstruct the pre-bump v4 shape and migrate it forward.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v4 = clone(v5) as any;
      v4.schemaVersion = 4;
      // Reconstruct the pre-bump v4 shape: strip only the INERT migration default
      // (limitVelocity === null). A preset that intentionally uses A4's limitVelocity
      // (a v5-native feature) keeps it — the migration spreads defaults-first and
      // never clobbers a present value, so the migrated hash still matches the
      // committed v5 (the pin proves migration adds inert defaults, not that it
      // erases authored v5 features).
      for (const l of v4.layers) if (l.limitVelocity === null) delete l.limitVelocity;
      const m = migrateToCurrent(v4);
      expect(m.ok).toBe(true);
      if (!m.ok) return;
      expect(runHash(m.doc as ParticleDoc)).toBe(runHash(v5));
    });
  }
});
