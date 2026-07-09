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
};

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
    // Modules off by default; `subEmitters`/`trail` were already null in v2.
    noise: null,
    bySpeed: null,
    startColor: null,
    randomFlip: null,
    render: null,
    collision: null,
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
