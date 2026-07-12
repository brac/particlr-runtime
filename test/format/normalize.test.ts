import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseParticle,
  validateParticle,
  migrateToCurrent,
  normalizeNullables,
  serializeParticle,
  type ParticleDoc,
} from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { stateHash, dtSequence } from "../core/_statehash.js";
import { presetsDir, hasPresets } from "../_presets.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// M2 (CORRECTNESS_REMEDIATION_PLAN R3/R5, findings C2/C3/C4): parseParticle
// normalizes absent nullable fields to explicit `null` between migrate and
// validate, so a "valid" doc that omits an optional module no longer crashes the
// strict `!== null` runtime guards (C2) or silently shifts the PRNG stream (C4);
// and migrateLayer2to3 now injects subEmitters/trail null (C3).

// --- C2: absent optional modules no longer crash the sim -------------------
describe("C2 — parseParticle normalizes absent modules; Effect does not crash", () => {
  // The five modules the audit repro'd crashing `new Effect()/step()` when absent.
  for (const field of ["noise", "collision", "bySpeed", "attractor", "wind"] as const) {
    it(`a current-schema doc omitting '${field}' parses ok and steps without throwing`, () => {
      const layer = makeLayer();
      delete (layer as Record<string, unknown>)[field];
      const doc = makeDoc({ layers: [layer] });

      const parsed = parseParticle(doc);
      expect(parsed.ok).toBe(true);
      expect(parsed.doc).not.toBeNull();
      // The normalized field is explicit null.
      expect((parsed.doc!.layers[0] as Record<string, unknown>)[field]).toBe(null);

      const fx = new Effect(parsed.doc!, { seed: 1337 });
      expect(() => fx.step(1 / 60)).not.toThrow();
    });
  }

  it("a doc omitting ALL nullable layer modules at once still parses + steps", () => {
    const layer = makeLayer();
    for (const k of [
      "limitVelocity", "noise", "wind", "bySpeed", "byEmitterSpeed", "startColor",
      "randomFlip", "tintParam", "opacityParam", "render", "dissolve", "collision",
      "killZones", "attractor", "subEmitters", "trail",
    ]) {
      delete (layer as Record<string, unknown>)[k];
    }
    const parsed = parseParticle(makeDoc({ layers: [layer] }));
    expect(parsed.ok).toBe(true);
    const fx = new Effect(parsed.doc!, { seed: 7 });
    expect(() => { for (let i = 0; i < 5; i++) fx.step(1 / 60); }).not.toThrow();
  });
});

// --- C3: v2 doc omitting subEmitters/trail migrates to explicit null -------
describe("C3 — migrateLayer2to3 injects subEmitters/trail null", () => {
  // A schemaVersion-2-shaped layer that omits the sub-emitter / trail fields (and
  // the other v3+ fields a real v2 doc never had). Migrations spread-defaults-first
  // so leaving unrelated v4+ fields present is harmless; the point is the OMISSION.
  const v2doc = () => {
    const l = clone(makeLayer()) as Record<string, unknown>;
    for (const k of ["noise", "bySpeed", "startColor", "randomFlip", "render", "collision", "subEmitters", "trail"]) {
      delete l[k];
    }
    return { ...makeDoc(), schemaVersion: 2, layers: [l] };
  };

  it("migrateToCurrent yields subEmitters:null and trail:null (not undefined)", () => {
    const r = migrateToCurrent(v2doc());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const layer = (r.doc as { layers: Array<Record<string, unknown>> }).layers[0]!;
    // Explicit null from the migration itself — independent of the downstream
    // normalizer (R5: migration output must be well-formed on its own).
    expect(layer.subEmitters).toBe(null);
    expect(layer.trail).toBe(null);
  });

  it("parses ok and constructs + steps an Effect", () => {
    const parsed = parseParticle(v2doc());
    expect(parsed.ok).toBe(true);
    expect(parsed.doc!.schemaVersion).toBe(12);
    const fx = new Effect(parsed.doc!, { seed: 99 });
    expect(() => { for (let i = 0; i < 5; i++) fx.step(1 / 60); }).not.toThrow();
  });
});

// --- C4: absent vs explicit-null velocity sub-track hash-identical ---------
describe("C4 — absent velocity.radial is canonicalized to null (no PRNG drift)", () => {
  it("radial ABSENT and radial:null produce IDENTICAL stateHash over 60 steps", () => {
    const nullLayer = makeLayer(); // radial: null present
    const absentLayer = clone(makeLayer());
    delete (absentLayer.overLifetime.velocity as Record<string, unknown>).radial;

    const parsedNull = parseParticle(makeDoc({ layers: [nullLayer] }));
    const parsedAbsent = parseParticle(makeDoc({ layers: [absentLayer] }));
    expect(parsedNull.ok && parsedAbsent.ok).toBe(true);
    // Normalization equalizes them: both radial === null.
    expect(parsedAbsent.doc!.layers[0]!.overLifetime.velocity.radial).toBe(null);

    const a = new Effect(parsedNull.doc!, { seed: 24680 });
    const b = new Effect(parsedAbsent.doc!, { seed: 24680 });
    const dts = dtSequence(11, 60);
    for (let i = 0; i < 60; i++) {
      a.step(dts[i]!);
      b.step(dts[i]!);
    }
    expect(stateHash(a)).toBe(stateHash(b));
  });
});

// --- parseParticle never mutates nor aliases its input ----------------------
describe("parseParticle input isolation (object inputs are cloned)", () => {
  it("a current-version object missing a nullable module: input untouched, doc not aliased", () => {
    const layer = clone(makeLayer());
    delete (layer as Record<string, unknown>).noise;
    const input = makeDoc({ layers: [layer] });
    const pristine = structuredClone(input);

    const r = parseParticle(input);
    expect(r.ok).toBe(true);
    // No mutation: the caller's object is deep-equal to its pre-call copy — in
    // particular, `noise` is STILL absent there (normalization happened on
    // parse's clone, not the input).
    expect(input).toEqual(pristine);
    expect("noise" in input.layers[0]!).toBe(false);
    // No aliasing: the returned doc is parse-owned, never the input reference.
    expect(r.doc).not.toBe(input);
    expect(r.doc!.layers[0]!.noise).toBe(null);
  });

  it("an INVALID object with a missing nullable field: parse fails AND input untouched", () => {
    const layer = clone(makeLayer());
    delete (layer as Record<string, unknown>).noise;
    const input = makeDoc({ layers: [layer], duration: 0 }); // duration floor → error
    const pristine = structuredClone(input);

    const r = parseParticle(input);
    expect(r.ok).toBe(false);
    expect(r.doc).toBeNull();
    // A failed parse must not leave a half-canonicalized caller object behind.
    expect(input).toEqual(pristine);
    expect("noise" in input.layers[0]!).toBe(false);
  });
});

// --- Validator warnings for direct callers (R3) ----------------------------
describe("validator warns on absent nullable fields (direct callers only)", () => {
  it("validateParticle warns 'absent-nullable' when a module is omitted", () => {
    const layer = clone(makeLayer());
    delete (layer as Record<string, unknown>).noise;
    const r = validateParticle(makeDoc({ layers: [layer] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.code === "absent-nullable" && w.path === "layers[0].noise")).toBe(true);
  });

  it("parseParticle does NOT surface absent-nullable warnings (normalized first)", () => {
    const layer = clone(makeLayer());
    delete (layer as Record<string, unknown>).noise;
    const r = parseParticle(makeDoc({ layers: [layer] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "absent-nullable")).toBe(false);
  });
});

// --- normalizeNullables walker sanity (the pin is wired to the walker) -----
describe("normalizeNullables", () => {
  it("fills a deleted Layer module field with explicit null", () => {
    const doc = makeDoc();
    delete (doc.layers[0] as Record<string, unknown>).collision;
    delete (doc.layers[0] as Record<string, unknown>).attractor;
    delete (doc.layers[0]!.overLifetime.velocity as Record<string, unknown>).orbital;
    normalizeNullables(doc);
    expect(doc.layers[0]!.collision).toBe(null);
    expect(doc.layers[0]!.attractor).toBe(null);
    expect(doc.layers[0]!.overLifetime.velocity.orbital).toBe(null);
  });

  it("leaves an explicit-null field untouched (=== null, not rewritten)", () => {
    const doc = makeDoc();
    normalizeNullables(doc);
    expect(doc.layers[0]!.noise).toBe(null);
  });
});

// --- R4: normalization is a no-op for every valid preset -------------------
describe.skipIf(!hasPresets)("R4 — normalizeNullables is a no-op on all presets", () => {
  const presetFiles = hasPresets ? readdirSync(presetsDir).filter((f) => f.endsWith(".prt")) : [];

  it(`covers all preset files (${presetFiles.length})`, () => {
    expect(presetFiles.length).toBeGreaterThan(0);
  });

  for (const name of presetFiles) {
    it(`${name}: migrate→normalize changes nothing; serialize is byte-identical`, () => {
      const text = readFileSync(resolve(presetsDir, name), "utf8");

      // No-op proof: migrate WITHOUT normalize, clone, then normalize the clone —
      // a valid, fully-populated preset has no absent nullable field, so normalize
      // writes nothing (deep-equal before/after).
      const migrated = migrateToCurrent(JSON.parse(text));
      expect(migrated.ok).toBe(true);
      if (!migrated.ok) return;
      const before = structuredClone(migrated.doc);
      normalizeNullables(migrated.doc);
      expect(migrated.doc).toEqual(before);

      // Byte-stability through the full pipeline (parse normalizes): identical bytes.
      const doc = parseParticle(text).doc as ParticleDoc;
      expect(serializeParticle(doc)).toBe(text);
    });
  }
});
