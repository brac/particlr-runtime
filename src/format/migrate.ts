// Forward-only migrations (FORMAT_SPEC "Versioning & migration rules").
// Migrations are pure (docVn) => docVn+1, chained on import. v1 is the floor,
// so MIGRATIONS is currently empty; the runner exists so adding v2 later is a
// one-line change and E11 (refuse newer-than-current) is enforced in one place.

import { CURRENT_SCHEMA_VERSION } from "./types.js";
import type { ValidationIssue } from "./validate.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MIGRATIONS: Record<number, (doc: any) => any> = {
  // v1 -> v2: emitter motion / simulation space (EMITTER_MOTION_PLAN).
  // Inject inert defaults so a migrated v1 document is bit-identical to its v1
  // behavior: local space, no inherited velocity, no rate-over-distance. Spread
  // the originals AFTER the defaults so a present value is never clobbered (the
  // validator then rules on whatever survives).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  1: (doc: any) => ({
    ...doc,
    schemaVersion: 2,
    layers: Array.isArray(doc.layers)
      ? doc.layers.map((l: any) => ({
          space: "local",
          inheritVelocity: 0,
          ...l,
          emission:
            l && typeof l.emission === "object" && l.emission !== null
              ? { rateOverDistance: null, ...l.emission }
              : l?.emission,
        }))
      : doc.layers,
  }),

  // v2 -> v3: Tier-1 feature surface (TIER1_PLAN §0.1). Inject inert defaults so
  // a migrated v2 document produces a byte-identical PRNG stream, pool state, and
  // golden frames as the v2 runtime (the "bit-identity invariant"): every module
  // defaults to null (zero conditional PRNG draws, no allocated pool buffers), and
  // the arc/donut/burst-cycle fields default to their v2-equivalent values (full
  // circle, single burst, random arc). Spread the originals AFTER each default
  // block so a present value is never clobbered and unknown fields survive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  2: (doc: any) => ({
    ...doc,
    schemaVersion: 3,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer2to3) : doc.layers,
  }),

  // v3 -> v4: Tier-2 feature surface (TIER2_PLAN §0.1). Inject the three inert
  // per-layer defaults so a migrated v3 document produces a byte-identical PRNG
  // stream, pool state, and golden frames as the v3 runtime (the "bit-identity
  // invariant"): `attractor`/`dissolve` null (no force / no shader) and
  // `attractorInfluence: 0` (the host `setAttractor` hook is a no-op). No shape,
  // emission, or velocity structures change this time (the texture shape is a new
  // Shape.kind — no existing document has one). Spread the originals AFTER the
  // defaults so a present value is never clobbered and unknown fields survive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  3: (doc: any) => ({
    ...doc,
    schemaVersion: 4,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer3to4) : doc.layers,
  }),

  // v4 -> v5: cheap-win companions (CHEAP_WINS_PLAN §0.1). Inject the ONE inert
  // structural default `limitVelocity: null` (A4) per layer, and — only for a
  // flipbook layer (`texture.frames !== null`) — the two new Flipbook fields
  // `randomStartFrame: false, frameOverLife: null` (A7) via a nested walk (mirror
  // migrateEmission2to3). A5 (new ScalarTrack mode) and A6 (new startColor mode)
  // are new enum values on existing nullable fields — no migration. Every default
  // is inert, so a migrated v4 document is bit-identical (PRNG stream, pool state,
  // stateHash, golden frames). Spread the originals AFTER the defaults so a present
  // value is never clobbered and unknown fields survive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  4: (doc: any) => ({
    ...doc,
    schemaVersion: 5,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer4to5) : doc.layers,
  }),

  // v5 -> v6: exposed runtime parameters (A9_PLAN §0.4, §0.3). Inject the inert
  // doc-root default `params: []` and the seven `…Param` binding fields as `null`
  // (unbound) — no params and no bindings ⇒ a migrated v5 document is bit-identical
  // (nothing reads these fields until M1). Spread the doc-root default FIRST so a
  // present `params` survives; per-layer/nested defaults spread-first inside their
  // walkers (mirror migrateLayer2to3 / migrateOverLifetime2to3). Pinned by the
  // migration-inertness test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  5: (doc: any) => ({
    params: [],
    ...doc,
    schemaVersion: 6,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer5to6) : doc.layers,
  }),

  // v6 -> v7: the `erase` blend mode (B8_PLAN §0.2). A pure enum extension on the
  // existing `Layer.blend` field — no new fields, no layer walk. A v6 document
  // has a valid v7 blend value already, so this is an IDENTITY restamp: spread
  // the original first, then bump the version. Bit-inert (blend is render-pipeline
  // only; nothing in the sim reads it), pinned by the migration-identity test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  6: (doc: any) => ({ ...doc, schemaVersion: 7 }),

  // v7 -> v8: the `color` param kind + layer-level `tintParam` (COLOR_PARAM_PLAN
  // C5). Two inert walks: every `params` entry gains `kind: "scalar"` (the v7
  // shape was implicitly scalar) and every layer gains `tintParam: null`
  // (unbound). Spread the original AFTER the default in each so a present `kind`
  // or a present `tintParam` is never clobbered (mirror the `5:` entry). A scalar
  // param at default and an unbound tint are both no-ops, so a migrated v7 document
  // is bit-identical (PRNG stream, pool state, stateHash, golden frames) — pinned
  // by the migration-inertness test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  7: (doc: any) => ({
    ...doc,
    schemaVersion: 8,
    params: Array.isArray(doc.params)
      ? doc.params.map((p: any) => (p && typeof p === "object" ? { kind: "scalar", ...p } : p))
      : doc.params,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer7to8) : doc.layers,
  }),

  // v8 -> v9: connect-ribbon trail mode + sub-emitter property inheritance
  // (RIBBON_INHERIT_PLAN §M0). Two nested walks per layer: a non-null `trail`
  // gains `mode: "perParticle"` (the pre-v9 topology) and every entry of a
  // non-null `subEmitters` array gains `inheritColor/inheritSize/inheritRotation:
  // false`. Both are spread-defaults-FIRST so a present value is never clobbered
  // (a hand-authored `mode: "connect"` or `true` flag survives). Every default is
  // inert (nothing reads mode or the flags in M0), so a migrated v8 document is
  // bit-identical — PRNG stream, pool state, stateHash, golden frames — pinned by
  // the migration-inertness test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  8: (doc: any) => ({
    ...doc,
    schemaVersion: 9,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer8to9) : doc.layers,
  }),

  // v9 -> v10: Tier-B remainder (TIERB_PLAN T9). Inject the inert per-layer
  // defaults so a migrated v9 document produces a byte-identical PRNG stream, pool
  // state, stateHash, and golden frames as the v9 runtime: `wind`,
  // `byEmitterSpeed`, `killZones` all null (no force / no spawn multiply / no death
  // region), and a non-null `collision` gains `killOnCollide: false,
  // minKillSpeed: 0` (never kills on contact). The polyline shape is a new
  // Shape.kind — no existing document has one, so no shape restamp. Spread the
  // originals AFTER each default so a present value is never clobbered and unknown
  // fields survive. Pinned by the migration-inertness test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  9: (doc: any) => ({
    ...doc,
    schemaVersion: 10,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer9to10) : doc.layers,
  }),

  // v10 -> v11: host-param bindable wind (WIND_PARAMS_PLAN P5). One nested walk per
  // layer: a NON-NULL `wind` gains `windStrengthParam: null` and
  // `windDirectionParam: null` (both unbound); a null wind is left untouched (no
  // object materialized). Spread-defaults-FIRST so a hand-authored / forward-written
  // binding survives (mirror the `9:` collision walk). Both identity values are
  // no-ops (×1 for strength, +0 for direction) and nothing reads them until W-M1, so
  // a migrated v10 document is bit-identical — PRNG stream, pool state, stateHash,
  // golden frames — pinned by the migration-inertness test. E11 now refuses v12.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  10: (doc: any) => ({
    ...doc,
    schemaVersion: 11,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer10to11) : doc.layers,
  }),

  // v11 -> v12: Catmull-Rom polyline smoothing (CURVES_PLAN C6). A SHAPE restamp
  // (the migrateShape2to3 precedent): every `polyline` shape gains `smoothing: 0`
  // (spread-default-FIRST so a hand-authored / forward-written smoothing survives).
  // `0` is honored EXACTLY by the sampler's `=== 0` short-circuit (build from the
  // authored points, pre-CURVES code path), so a migrated v11 document produces a
  // byte-identical PRNG stream, pool state, stateHash, frames, and render as v11 —
  // zero golden churn. Non-polyline shapes pass through untouched. E11 now refuses
  // v13. Pinned by the migration-inertness test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  11: (doc: any) => ({
    ...doc,
    schemaVersion: 12,
    layers: Array.isArray(doc.layers) ? doc.layers.map(migrateLayer11to12) : doc.layers,
  }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer11to12(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return { ...l, shape: migrateShape11to12(l.shape) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateShape11to12(s: any): any {
  if (s === null || typeof s !== "object") return s;
  // Only the polyline kind gains smoothing; spread-default-FIRST (mirror
  // migrateShape2to3's circle/cone restamp) so a present value is never clobbered.
  return s.kind === "polyline" ? { smoothing: 0, ...s } : s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer10to11(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return {
    ...l,
    // wind is `WindConfig | null`: only a non-null object gains the two binding
    // fields (spread-after so a present value survives).
    wind:
      l.wind && typeof l.wind === "object"
        ? { windStrengthParam: null, windDirectionParam: null, ...l.wind }
        : l.wind,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer9to10(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return {
    // wind / byEmitterSpeed / killZones are NEW per-layer modules (off by default).
    wind: null,
    byEmitterSpeed: null,
    killZones: null,
    ...l,
    // collision is `CollisionConfig | null`: only a non-null object gains the two
    // kill fields (spread-after so a present value survives).
    collision:
      l.collision && typeof l.collision === "object"
        ? { killOnCollide: false, minKillSpeed: 0, ...l.collision }
        : l.collision,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer8to9(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return {
    ...l,
    // trail is `TrailConfig | null`: only a non-null object gains a mode.
    trail:
      l.trail && typeof l.trail === "object" ? { mode: "perParticle", ...l.trail } : l.trail,
    // subEmitters is `SubEmitterRef[] | null`: walk each entry when it is an array.
    subEmitters: Array.isArray(l.subEmitters)
      ? l.subEmitters.map((s: any) =>
          s && typeof s === "object"
            ? { inheritColor: false, inheritSize: false, inheritRotation: false, ...s }
            : s,
        )
      : l.subEmitters,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer7to8(l: any): any {
  if (l === null || typeof l !== "object") return l;
  // tintParam is a NEW layer-level color binding (implicit base white); spread-
  // first so a present binding survives.
  return { tintParam: null, ...l };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer5to6(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return {
    // opacityParam is a NEW layer-level binding (alpha has no existing knob).
    opacityParam: null,
    ...l,
    emission: migrateEmission5to6(l.emission),
    initial: migrateInitial5to6(l.initial),
    overLifetime: migrateOverLifetime5to6(l.overLifetime),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateEmission5to6(e: any): any {
  if (e === null || typeof e !== "object") return e;
  return { rateOverTimeParam: null, rateOverDistanceParam: null, ...e };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateInitial5to6(init: any): any {
  if (init === null || typeof init !== "object") return init;
  return { lifeParam: null, speedParam: null, sizeParam: null, ...init };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateOverLifetime5to6(ol: any): any {
  if (ol === null || typeof ol !== "object") return ol;
  const vel = ol.velocity;
  if (vel === null || typeof vel !== "object") return ol;
  return { ...ol, velocity: { gravityParam: null, ...vel } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer3to4(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return { attractor: null, dissolve: null, attractorInfluence: 0, ...l };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer4to5(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return { limitVelocity: null, ...l, texture: migrateTexture4to5(l.texture) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateTexture4to5(t: any): any {
  if (t === null || typeof t !== "object") return t;
  const f = t.frames;
  if (f === null || f === undefined || typeof f !== "object") return t;
  return { ...t, frames: { randomStartFrame: false, frameOverLife: null, ...f } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateLayer2to3(l: any): any {
  if (l === null || typeof l !== "object") return l;
  return {
    // Every schemaVersion-3 module defaults to null (off). FORMAT_SPEC:78 promises
    // the v2→v3 migration writes ALL of these, including `subEmitters`/`trail` — the
    // v1/v2 documents that reserved those fields were spec-optional, so a doc that
    // omitted them must still migrate to explicit null (R5/C3), not `undefined`
    // (which the strict `!== null` runtime guards would dereference and crash on).
    noise: null,
    bySpeed: null,
    startColor: null,
    randomFlip: null,
    render: null,
    collision: null,
    subEmitters: null,
    trail: null,
    ...l,
    shape: migrateShape2to3(l.shape),
    emission: migrateEmission2to3(l.emission),
    overLifetime: migrateOverLifetime2to3(l.overLifetime),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateShape2to3(s: any): any {
  if (s === null || typeof s !== "object") return s;
  if (s.kind === "circle") return { innerRadius: 0, arc: 360, arcMode: "random", arcSpeed: 1, ...s };
  if (s.kind === "cone") return { arcMode: "random", arcSpeed: 1, ...s };
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateEmission2to3(e: any): any {
  if (e === null || typeof e !== "object") return e;
  return {
    ...e,
    bursts: Array.isArray(e.bursts)
      ? e.bursts.map((b: any) =>
          b && typeof b === "object" ? { cycles: 1, interval: 0, probability: 1, ...b } : b,
        )
      : e.bursts,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateOverLifetime2to3(ol: any): any {
  if (ol === null || typeof ol !== "object") return ol;
  const vel = ol.velocity;
  if (vel === null || typeof vel !== "object") return ol;
  return { ...ol, velocity: { x: null, y: null, orbital: null, radial: null, ...vel } };
}

export type MigrateResult =
  | { ok: true; doc: unknown }
  | { ok: false; issue: ValidationIssue };

export function migrateToCurrent(raw: unknown): MigrateResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, issue: { path: "", message: "document must be an object" } };
  }
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return {
      ok: false,
      issue: { path: "schemaVersion", message: "schemaVersion must be a positive integer", code: "invalid-version" },
    };
  }
  if (v > CURRENT_SCHEMA_VERSION) {
    // E11: never best-effort parse a newer document forward.
    return {
      ok: false,
      issue: {
        path: "schemaVersion",
        message: `document schemaVersion ${v} is newer than supported (${CURRENT_SCHEMA_VERSION})`,
        code: "newer-version",
      },
    };
  }
  let cur: unknown = raw;
  for (let ver = v; ver < CURRENT_SCHEMA_VERSION; ver++) {
    const migrate = MIGRATIONS[ver];
    if (!migrate) {
      return {
        ok: false,
        issue: { path: "schemaVersion", message: `no migration registered from v${ver}`, code: "no-migration" },
      };
    }
    cur = migrate(cur);
  }
  return { ok: true, doc: cur };
}
