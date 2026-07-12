// normalizeNullables: canonicalize absent nullable fields to explicit `null`
// (CORRECTNESS_REMEDIATION_PLAN R3, findings C2/C4). The format's normative
// convention is explicit-`null` for every "off" module, and the runtime core
// trusts it — its guards are strict `!== null` then dereference. A document that
// OMITS a nullable field (an npm consumer building a doc by hand, or a pre-spec
// export) is `undefined` there, and `undefined !== null` is `true`, so it walks
// straight into a crash (C2) or — for the velocity sub-tracks — silently draws an
// extra per-particle PRNG uniform and diverges every subsequent frame (C4).
//
// This runs in `parseParticle` BETWEEN migrateToCurrent and validateParticle, so
// every document that comes through the front door is canonical before the sim or
// the validator ever sees it. Runtime guards STAY strict `!== null`: the
// convention is enforced here at the gate, never weakened at the sim.
//
// Mutation is IN PLACE. parse.ts owns the migrated object: a string input is
// freshly JSON.parsed and an OBJECT input is structuredClone'd up front (so a
// current-version doc that migrateToCurrent passes through by reference is
// parse's clone, never the caller's object) — there is no second observer of
// this doc to surprise, and in-place keeps the R4 no-op proof trivial: for a
// valid explicit-null doc EVERY field is already present, so nothing is written
// and the object is byte-identical.
//
// COMPILE-TIME EXHAUSTIVENESS (the POLAR_ENV_KEYS precedent, api/_lib/polar.ts):
// each key list below is `Object.keys({...} satisfies Record<NullableKeys<T>,
// true>)`. `NullableKeys<T>` is the union of keys of T whose declared type
// INCLUDES `null` (see the mapped type). `satisfies Record<NullableKeys<T>, true>`
// forces the literal to name EXACTLY those keys: add a `X | null` field to a type
// and its list fails to compile (missing key); make a nullable field non-nullable
// and it fails (excess key). Fields that are optional-but-not-nullable (e.g.
// `SubEmitterRef.inheritColor: boolean`, `ParticleDoc.textures?`) are excluded
// automatically — `null` does not extend `boolean` or `Record<…> | undefined`.

import type {
  ParticleDoc,
  Layer,
  Emission,
  InitialProps,
  Velocity,
  OverLifetime,
  TextureRef,
  Flipbook,
  WindConfig,
  BySpeedConfig,
  ByEmitterSpeedConfig,
  AttractorConfig,
  DissolveConfig,
  TrailConfig,
  CollisionConfig,
  SubEmitterRef,
} from "./types.js";

/**
 * The union of keys of `T` whose declared type includes `null`. `-?` strips the
 * optional modifier so a `field?: X` (which is `X | undefined`) is judged on `X`
 * alone — we only want keys the type author wrote `| null` on, not `?`-optional
 * ones.
 */
type NullableKeys<T> = {
  [K in keyof T]-?: null extends T[K] ? K : never;
}[keyof T];

// One helper, called at each walk site: set every listed key that is currently
// absent/undefined to explicit `null`. A key already present (including an
// explicit `null`) is left untouched — so a canonical doc is never rewritten.
function fillNulls(obj: unknown, keys: readonly string[]): void {
  if (obj === null || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] === undefined) o[k] = null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// --- pinned key lists (compile-time-exhaustive against types.ts) ------------

const DOC_NULLABLE_KEYS = Object.keys({
  // ParticleDoc has NO `| null` fields (schemaVersion/meta/duration/looping/seed/
  // params/layers are all required-non-null; `textures?` is optional-not-nullable).
  // The empty pin still fires if a nullable doc field is ever added.
} satisfies Record<NullableKeys<ParticleDoc>, true>) as readonly (keyof ParticleDoc)[];

const LAYER_NULLABLE_KEYS = Object.keys({
  limitVelocity: true,
  noise: true,
  wind: true,
  bySpeed: true,
  byEmitterSpeed: true,
  startColor: true,
  randomFlip: true,
  tintParam: true,
  opacityParam: true,
  render: true,
  dissolve: true,
  collision: true,
  killZones: true,
  attractor: true,
  subEmitters: true,
  trail: true,
} satisfies Record<NullableKeys<Layer>, true>) as readonly (keyof Layer)[];

const EMISSION_NULLABLE_KEYS = Object.keys({
  rateOverTimeParam: true,
  rateOverDistance: true,
  rateOverDistanceParam: true,
} satisfies Record<NullableKeys<Emission>, true>) as readonly (keyof Emission)[];

const INITIAL_NULLABLE_KEYS = Object.keys({
  lifeParam: true,
  speedParam: true,
  sizeParam: true,
} satisfies Record<NullableKeys<InitialProps>, true>) as readonly (keyof InitialProps)[];

const VELOCITY_NULLABLE_KEYS = Object.keys({
  gravityParam: true,
  drag: true,
  speedMultiplier: true,
  x: true,
  y: true,
  orbital: true,
  radial: true,
} satisfies Record<NullableKeys<Velocity>, true>) as readonly (keyof Velocity)[];

const OVERLIFETIME_NULLABLE_KEYS = Object.keys({
  size: true,
  rotation: true,
} satisfies Record<NullableKeys<OverLifetime>, true>) as readonly (keyof OverLifetime)[];

const TEXTURE_NULLABLE_KEYS = Object.keys({
  frames: true,
} satisfies Record<NullableKeys<TextureRef>, true>) as readonly (keyof TextureRef)[];

const FLIPBOOK_NULLABLE_KEYS = Object.keys({
  frameOverLife: true,
} satisfies Record<NullableKeys<Flipbook>, true>) as readonly (keyof Flipbook)[];

const WIND_NULLABLE_KEYS = Object.keys({
  windStrengthParam: true,
  windDirectionParam: true,
} satisfies Record<NullableKeys<WindConfig>, true>) as readonly (keyof WindConfig)[];

const BYSPEED_NULLABLE_KEYS = Object.keys({
  size: true,
  color: true,
  rotation: true,
} satisfies Record<NullableKeys<BySpeedConfig>, true>) as readonly (keyof BySpeedConfig)[];

const BYEMITTERSPEED_NULLABLE_KEYS = Object.keys({
  size: true,
  speed: true,
  life: true,
} satisfies Record<NullableKeys<ByEmitterSpeedConfig>, true>) as readonly (keyof ByEmitterSpeedConfig)[];

const ATTRACTOR_NULLABLE_KEYS = Object.keys({
  tangential: true,
} satisfies Record<NullableKeys<AttractorConfig>, true>) as readonly (keyof AttractorConfig)[];

const DISSOLVE_NULLABLE_KEYS = Object.keys({
  edgeColor: true,
} satisfies Record<NullableKeys<DissolveConfig>, true>) as readonly (keyof DissolveConfig)[];

const TRAIL_NULLABLE_KEYS = Object.keys({
  color: true,
} satisfies Record<NullableKeys<TrailConfig>, true>) as readonly (keyof TrailConfig)[];

const COLLISION_NULLABLE_KEYS = Object.keys({
  // CollisionConfig has NO `| null` fields (shape is a non-null union; the rest are
  // number/boolean). Empty pin — fires if one is ever added.
} satisfies Record<NullableKeys<CollisionConfig>, true>) as readonly (keyof CollisionConfig)[];

const SUBEMITTER_NULLABLE_KEYS = Object.keys({
  // SubEmitterRef has NO `| null` fields — the three inherit flags are `boolean`
  // (optional-in-wire, injected `false` by migration), NOT nullable. Empty pin.
} satisfies Record<NullableKeys<SubEmitterRef>, true>) as readonly (keyof SubEmitterRef)[];

// --- the walker -------------------------------------------------------------

/**
 * Canonicalize a MIGRATED doc's absent nullable fields to explicit `null`, in
 * place. Returns the same (now-canonical) reference for chaining. Tolerant of any
 * shape — walks only what is object-typed, so a structurally-broken doc simply
 * reaches the validator (which reports it) untouched where it isn't an object.
 */
export function normalizeNullables(doc: unknown): unknown {
  if (!isObj(doc)) return doc;
  fillNulls(doc, DOC_NULLABLE_KEYS);

  const layers = doc.layers;
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      if (!isObj(layer)) continue;
      fillNulls(layer, LAYER_NULLABLE_KEYS);

      fillNulls(layer.emission, EMISSION_NULLABLE_KEYS);
      fillNulls(layer.initial, INITIAL_NULLABLE_KEYS);

      const texture = layer.texture;
      if (isObj(texture)) {
        fillNulls(texture, TEXTURE_NULLABLE_KEYS);
        fillNulls(texture.frames, FLIPBOOK_NULLABLE_KEYS);
      }

      const ol = layer.overLifetime;
      if (isObj(ol)) {
        fillNulls(ol, OVERLIFETIME_NULLABLE_KEYS);
        fillNulls(ol.velocity, VELOCITY_NULLABLE_KEYS);
      }

      // Nested configs: only reachable when the owning module is a present object
      // (a `null` module has no sub-fields to canonicalize). fillNulls no-ops on
      // null/non-object, so these are safe to call unconditionally.
      fillNulls(layer.wind, WIND_NULLABLE_KEYS);
      fillNulls(layer.bySpeed, BYSPEED_NULLABLE_KEYS);
      fillNulls(layer.byEmitterSpeed, BYEMITTERSPEED_NULLABLE_KEYS);
      fillNulls(layer.attractor, ATTRACTOR_NULLABLE_KEYS);
      fillNulls(layer.dissolve, DISSOLVE_NULLABLE_KEYS);
      fillNulls(layer.trail, TRAIL_NULLABLE_KEYS);
      fillNulls(layer.collision, COLLISION_NULLABLE_KEYS);

      const subEmitters = layer.subEmitters;
      if (Array.isArray(subEmitters)) {
        for (const ref of subEmitters) fillNulls(ref, SUBEMITTER_NULLABLE_KEYS);
      }
    }
  }

  return doc;
}
