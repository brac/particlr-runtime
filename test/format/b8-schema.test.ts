import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  Effect,
  BLEND_MODES,
  type ParticleDoc,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// B8 (schemaVersion 7, B8_PLAN §0.2): the `erase` blend mode. A pure enum
// extension on Layer.blend, so the v6->v7 migration is an IDENTITY restamp (no
// new fields, no layer walk) and blend never reaches the sim (render-pipeline
// state only — zero PRNG draws, zero pool columns).

// A v6-shaped doc reconstructed from a current v7 doc by lowering the version —
// the migration input. Nothing else changes because v6->v7 injected no fields.
function toV6(v7: ParticleDoc): Record<string, unknown> {
  const d = clone(v7) as Record<string, unknown>;
  d.schemaVersion = 6;
  return d;
}

function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}

// ---------------------------------------------------------------------------
describe("v6 -> v7 migration (B8) is an identity restamp", () => {
  it("bumps only schemaVersion; every other field is byte-for-byte unchanged", () => {
    const v7 = makeDoc();
    const v6 = toV6(v7);
    const m = migrateToCurrent(v6);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const migrated = m.doc as ParticleDoc;
    expect(migrated.schemaVersion).toBe(12);
    // Deep-equal everything except the version stamp.
    expect({ ...migrated, schemaVersion: 6 }).toEqual(v6);
  });

  it("is idempotent on an already-current v7 document (passes by reference)", () => {
    const doc = makeDoc();
    const m = migrateToCurrent(doc);
    expect(m.ok).toBe(true);
    if (m.ok) expect(m.doc).toBe(doc);
  });

  it("chains a v1 document all the way to v7", () => {
    // A minimal v1 layer: strip every field added in v2..v6 so the full chain
    // (v1->v2->...->v7) has to inject them and land on 7.
    const l = clone(makeDoc().layers[0]!) as Record<string, unknown>;
    for (const k of [
      "space", "inheritVelocity", "attractor", "dissolve", "attractorInfluence",
      "limitVelocity", "noise", "bySpeed", "startColor", "randomFlip", "render",
      "collision", "opacityParam",
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
    expect(doc.schemaVersion).toBe(12);
    expect(doc.layers[0]!.space).toBe("local"); // v1->v2
    expect(doc.layers[0]!.limitVelocity).toBe(null); // v4->v5
    expect(doc.params).toEqual([]); // v5->v6
    expect(parseParticle(doc).ok).toBe(true);
  });

  it("refuses a v13 document (E11 — newer than supported)", () => {
    expect(migrateToCurrent({ schemaVersion: 13 }).ok).toBe(false);
    const r = parseParticle({ ...makeDoc(), schemaVersion: 13 as 12 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("newer-version");
  });
});

// ---------------------------------------------------------------------------
describe("validator — erase blend mode", () => {
  it("BLEND_MODES exposes exactly the five modes, including erase", () => {
    expect([...BLEND_MODES]).toEqual(["normal", "add", "multiply", "screen", "erase"]);
  });

  it("accepts a layer with blend: erase", () => {
    const l = clone(makeLayer());
    l.blend = "erase";
    expect(validateParticle(makeDoc({ layers: [l] })).ok).toBe(true);
  });

  it("still rejects an unknown blend mode", () => {
    const l = clone(makeLayer()) as Record<string, unknown>;
    l.blend = "subtract";
    const r = validateParticle(makeDoc({ layers: [l as never] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path.endsWith(".blend"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("round-trip — blend: erase", () => {
  it("survives serialize -> parse deep-equal and byte-stable re-serialize", () => {
    const l = clone(makeLayer());
    l.blend = "erase";
    const doc = makeDoc({ layers: [l] });
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc);
    expect(back.doc!.layers[0]!.blend).toBe("erase");
    expect(serializeParticle(back.doc!)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
describe("blend is render-pipeline only — zero sim impact", () => {
  it("normal vs erase produce an IDENTICAL stateHash over a run", () => {
    const normal = clone(makeLayer());
    normal.blend = "normal";
    const erase = clone(makeLayer());
    erase.blend = "erase";
    const hNormal = runHash(makeDoc({ layers: [normal] }));
    const hErase = runHash(makeDoc({ layers: [erase] }));
    expect(hErase).toBe(hNormal);
  });
});
