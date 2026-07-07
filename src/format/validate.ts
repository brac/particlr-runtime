// Structural + semantic validation of a raw parsed object against the .prt v1
// schema (plan §2.12/§2.13). Never throws on bad data — it collects every issue
// with a JSON-path so the editor can surface them all at once. Unknown fields
// are ignored here (preserved elsewhere, plan §2.10).

import {
  BLEND_MODES,
  BUILTIN_TEXTURE_IDS,
  CURRENT_SCHEMA_VERSION,
  EASES,
  EMIT_FROM,
  FLIPBOOK_MODES,
  SIM_SPACES,
  type ParticleDoc,
} from "./types.js";

export interface ValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export type ValidationResult =
  | { ok: true; doc: ParticleDoc; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

interface Ctx {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  textureNames: Set<string>;
  duration: number; // for burst-timing warnings; 0 if the field is invalid
  looping: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function err(ctx: Ctx, path: string, message: string, code?: string): void {
  ctx.errors.push(code ? { path, message, code } : { path, message });
}
function warn(ctx: Ctx, path: string, message: string, code?: string): void {
  ctx.warnings.push(code ? { path, message, code } : { path, message });
}

function checkNumber(ctx: Ctx, v: unknown, path: string): boolean {
  if (!isNum(v)) {
    err(ctx, path, "must be a finite number");
    return false;
  }
  return true;
}

function checkEnum<T extends string>(
  ctx: Ctx,
  v: unknown,
  allowed: readonly T[],
  path: string,
): boolean {
  if (!isStr(v) || !allowed.includes(v as T)) {
    err(ctx, path, `must be one of: ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

function checkScalarInit(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a ScalarInit object");
    return;
  }
  if (v.mode === "constant") {
    checkNumber(ctx, v.value, `${path}.value`);
  } else if (v.mode === "range") {
    const okMin = checkNumber(ctx, v.min, `${path}.min`);
    const okMax = checkNumber(ctx, v.max, `${path}.max`);
    if (okMin && okMax && (v.min as number) > (v.max as number)) {
      err(ctx, path, "range min must be <= max");
    }
  } else {
    err(ctx, `${path}.mode`, 'must be "constant" or "range"');
  }
}

function checkCurveKeys(ctx: Ctx, keys: unknown, path: string): void {
  if (!Array.isArray(keys)) {
    err(ctx, path, "curve keys must be an array");
    return;
  }
  if (keys.length < 1) {
    err(ctx, path, "curve must have at least one key", "empty-curve"); // E4
    return;
  }
  let prevT = -Infinity;
  keys.forEach((k, i) => {
    const kp = `${path}[${i}]`;
    if (!isObject(k)) {
      err(ctx, kp, "curve key must be an object");
      return;
    }
    if (checkNumber(ctx, k.t, `${kp}.t`)) {
      const t = k.t as number;
      if (t < 0 || t > 1) err(ctx, `${kp}.t`, "t must be in [0,1]");
      if (t < prevT) err(ctx, `${kp}.t`, "curve keys must be sorted ascending by t"); // E12: dupes allowed
      prevT = t;
    }
    checkNumber(ctx, k.v, `${kp}.v`);
    if (k.ease !== undefined) checkEnum(ctx, k.ease, EASES, `${kp}.ease`);
  });
}

function checkScalarTrack(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a ScalarTrack object");
    return;
  }
  if (v.mode === "constant") {
    checkNumber(ctx, v.value, `${path}.value`);
  } else if (v.mode === "range") {
    const okMin = checkNumber(ctx, v.min, `${path}.min`);
    const okMax = checkNumber(ctx, v.max, `${path}.max`);
    if (okMin && okMax && (v.min as number) > (v.max as number)) {
      err(ctx, path, "range min must be <= max");
    }
  } else if (v.mode === "curve") {
    checkCurveKeys(ctx, v.keys, `${path}.keys`);
  } else {
    err(ctx, `${path}.mode`, 'must be "constant", "range", or "curve"');
  }
}

function checkScalarTrackOrNull(ctx: Ctx, v: unknown, path: string): void {
  if (v === null) return;
  checkScalarTrack(ctx, v, path);
}

// Emission rate is the one track that must be bounded above: an astronomical
// rate (e.g. 1e15) otherwise asks the sim to spawn trillions of particles in a
// single step. The pool caps actual spawns, but the ceiling keeps a document
// from *requesting* work that large. Applied only to rateOverTime. (P1.3)
const MAX_RATE = 100_000;
function checkRateCeiling(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) return; // shape errors already reported by checkScalarTrack
  const over = (n: unknown, p: string): void => {
    if (typeof n === "number" && Number.isFinite(n) && n > MAX_RATE)
      err(ctx, p, `rate must be <= ${MAX_RATE}`);
  };
  if (v.mode === "constant") over(v.value, `${path}.value`);
  else if (v.mode === "range") {
    over(v.min, `${path}.min`);
    over(v.max, `${path}.max`);
  } else if (v.mode === "curve" && Array.isArray(v.keys)) {
    v.keys.forEach((k, i) => {
      if (isObject(k)) over(k.v, `${path}.keys[${i}].v`);
    });
  }
}

function checkGradient(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v) || !Array.isArray(v.keys)) {
    err(ctx, path, "must be a GradientTrack with a keys array");
    return;
  }
  const keys = v.keys;
  if (keys.length < 1) {
    err(ctx, `${path}.keys`, "gradient must have at least one key", "empty-gradient");
    return;
  }
  let prevT = -Infinity;
  keys.forEach((k, i) => {
    const kp = `${path}.keys[${i}]`;
    if (!isObject(k)) {
      err(ctx, kp, "gradient key must be an object");
      return;
    }
    if (checkNumber(ctx, k.t, `${kp}.t`)) {
      const t = k.t as number;
      if (t < 0 || t > 1) err(ctx, `${kp}.t`, "t must be in [0,1]");
      if (t < prevT) err(ctx, `${kp}.t`, "gradient keys must be sorted ascending by t");
      prevT = t;
    }
    for (const ch of ["r", "g", "b", "a"] as const) {
      if (checkNumber(ctx, k[ch], `${kp}.${ch}`)) {
        const val = k[ch] as number;
        if (val < 0 || val > 1) err(ctx, `${kp}.${ch}`, `${ch} must be in [0,1]`);
      }
    }
  });
}

function checkShape(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a Shape object");
    return;
  }
  checkEnum(ctx, v.emitFrom, EMIT_FROM, `${path}.emitFrom`);
  switch (v.kind) {
    case "point":
      break;
    case "circle":
      checkNumber(ctx, v.radius, `${path}.radius`);
      break;
    case "cone":
      checkNumber(ctx, v.direction, `${path}.direction`);
      checkNumber(ctx, v.spread, `${path}.spread`);
      checkNumber(ctx, v.radius, `${path}.radius`);
      break;
    case "rect":
      checkNumber(ctx, v.width, `${path}.width`);
      checkNumber(ctx, v.height, `${path}.height`);
      break;
    case "edge":
      checkNumber(ctx, v.length, `${path}.length`);
      break;
    default:
      err(ctx, `${path}.kind`, "must be one of: point, circle, cone, rect, edge");
  }
}

function checkFlipbook(ctx: Ctx, v: unknown, path: string): void {
  if (v === null) return;
  if (!isObject(v)) {
    err(ctx, path, "frames must be a Flipbook object or null");
    return;
  }
  // Bound cols/rows: the core frame index is a Uint16Array, so cols*rows must
  // stay well under 65536; 64 per axis is far more than any real sprite sheet. (P2.3)
  if (!isInt(v.cols) || (v.cols as number) < 1 || (v.cols as number) > 64)
    err(ctx, `${path}.cols`, "cols must be an integer in [1,64]");
  if (!isInt(v.rows) || (v.rows as number) < 1 || (v.rows as number) > 64)
    err(ctx, `${path}.rows`, "rows must be an integer in [1,64]");
  if (!isNum(v.fps) || (v.fps as number) <= 0) err(ctx, `${path}.fps`, "fps must be a number > 0");
  checkEnum(ctx, v.mode, FLIPBOOK_MODES, `${path}.mode`);
}

function checkTexture(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a TextureRef object");
    return;
  }
  if (!isStr(v.ref)) {
    err(ctx, `${path}.ref`, "ref must be a string");
  } else {
    const ref = v.ref;
    if ((BUILTIN_TEXTURE_IDS as readonly string[]).includes(ref)) {
      // ok
    } else if (ref.startsWith("user:")) {
      const name = ref.slice("user:".length);
      if (!ctx.textureNames.has(name)) {
        // E10: missing entry is valid — warn, do not reject.
        warn(ctx, `${path}.ref`, `user texture "${name}" has no embedded data; a built-in will be substituted`, "missing-texture");
      }
    } else {
      err(ctx, `${path}.ref`, `unknown texture ref "${ref}" (must be a built-in id or "user:<name>")`);
    }
  }
  checkFlipbook(ctx, v.frames === undefined ? null : v.frames, `${path}.frames`);
}

function checkEmission(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be an Emission object");
    return;
  }
  checkScalarTrack(ctx, v.rateOverTime, `${path}.rateOverTime`);
  checkRateCeiling(ctx, v.rateOverTime, `${path}.rateOverTime`);
  // rateOverDistance (schemaVersion 2): optional track, same ceiling. The
  // world-space-only warning is emitted by checkLayer, which sees `space`.
  if (v.rateOverDistance !== null && v.rateOverDistance !== undefined) {
    checkScalarTrack(ctx, v.rateOverDistance, `${path}.rateOverDistance`);
    checkRateCeiling(ctx, v.rateOverDistance, `${path}.rateOverDistance`);
  }
  if (!Array.isArray(v.bursts)) {
    err(ctx, `${path}.bursts`, "bursts must be an array");
  } else {
    v.bursts.forEach((b, i) => {
      const bp = `${path}.bursts[${i}]`;
      if (!isObject(b)) {
        err(ctx, bp, "burst must be an object");
        return;
      }
      if (checkNumber(ctx, b.time, `${bp}.time`) && (b.time as number) < 0)
        err(ctx, `${bp}.time`, "time must be >= 0");
      if (!isInt(b.count) || (b.count as number) < 0 || (b.count as number) > 10000)
        err(ctx, `${bp}.count`, "count must be an integer in [0,10000]");
      if (checkNumber(ctx, b.spread, `${bp}.spread`) && (b.spread as number) < 0)
        err(ctx, `${bp}.spread`, "spread must be >= 0");
      // Authoring-trap warnings: a burst whose (spread) window exceeds the
      // per-cycle emission window silently loses sub-events. (P2.2 / P2.3)
      if (ctx.duration > 0 && isNum(b.time) && isNum(b.spread)) {
        const delay = isNum(v.delay) ? v.delay : 0;
        const windowEnd = ctx.duration - delay;
        if (b.time > windowEnd) {
          warn(ctx, `${bp}.time`, "burst time is past the emission window (duration − delay); this burst will not fire");
        } else if (b.time + b.spread > windowEnd) {
          warn(ctx, `${bp}`, "burst spread extends past the emission window; trailing sub-events will not fire");
        }
      }
    });
  }
  if (checkNumber(ctx, v.delay, `${path}.delay`) && (v.delay as number) < 0)
    err(ctx, `${path}.delay`, "delay must be >= 0");
  if (!isBool(v.prewarm)) err(ctx, `${path}.prewarm`, "prewarm must be a boolean");
  if (!isInt(v.maxParticles) || (v.maxParticles as number) < 1 || (v.maxParticles as number) > 10000)
    err(ctx, `${path}.maxParticles`, "maxParticles must be an integer in [1,10000]");
}

function checkInitial(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be an InitialProps object");
    return;
  }
  for (const key of ["life", "speed", "size", "rotation", "angularVelocity"] as const) {
    checkScalarInit(ctx, v[key], `${path}.${key}`);
  }
}

function checkVec2(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a {x,y} object");
    return;
  }
  checkNumber(ctx, v.x, `${path}.x`);
  checkNumber(ctx, v.y, `${path}.y`);
}

function checkOverLifetime(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be an OverLifetime object");
    return;
  }
  checkScalarTrackOrNull(ctx, v.size, `${path}.size`);
  checkGradient(ctx, v.color, `${path}.color`);
  checkScalarTrackOrNull(ctx, v.rotation, `${path}.rotation`);
  if (!isObject(v.velocity)) {
    err(ctx, `${path}.velocity`, "must be a Velocity object");
  } else {
    checkVec2(ctx, v.velocity.gravity, `${path}.velocity.gravity`);
    checkScalarTrackOrNull(ctx, v.velocity.drag, `${path}.velocity.drag`);
    checkScalarTrackOrNull(ctx, v.velocity.speedMultiplier, `${path}.velocity.speedMultiplier`);
  }
}

function checkLayer(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a Layer object");
    return;
  }
  if (!isStr(v.id) || v.id.length === 0) err(ctx, `${path}.id`, "id must be a non-empty string");
  if (!isStr(v.name)) err(ctx, `${path}.name`, "name must be a string");
  if (!isBool(v.enabled)) err(ctx, `${path}.enabled`, "enabled must be a boolean");
  checkEnum(ctx, v.blend, BLEND_MODES, `${path}.blend`);
  checkTexture(ctx, v.texture, `${path}.texture`);
  checkEmission(ctx, v.emission, `${path}.emission`);
  checkShape(ctx, v.shape, `${path}.shape`);
  checkInitial(ctx, v.initial, `${path}.initial`);
  checkOverLifetime(ctx, v.overLifetime, `${path}.overLifetime`);

  // Simulation space + inherited velocity (schemaVersion 2).
  const spaceOk = checkEnum(ctx, v.space, SIM_SPACES, `${path}.space`);
  if (v.inheritVelocity !== undefined) {
    if (!isNum(v.inheritVelocity)) {
      err(ctx, `${path}.inheritVelocity`, "must be a finite number");
    } else if ((v.inheritVelocity as number) < -2 || (v.inheritVelocity as number) > 2) {
      err(ctx, `${path}.inheritVelocity`, "inheritVelocity must be in [-2, 2]");
    }
  } else {
    err(ctx, `${path}.inheritVelocity`, "must be a finite number");
  }
  // Authoring-trap warnings: motion features are inert in local space.
  const isLocal = spaceOk && v.space === "local";
  if (isLocal && isNum(v.inheritVelocity) && v.inheritVelocity !== 0)
    warn(ctx, `${path}.inheritVelocity`, "inheritVelocity has no effect in local simulation space");
  const em = v.emission;
  if (isObject(em)) {
    if (isLocal && em.rateOverDistance !== null && em.rateOverDistance !== undefined)
      warn(ctx, `${path}.emission.rateOverDistance`, "rateOverDistance has no effect in local simulation space");
    // Prewarm runs at the initial emitter position with zero emitter velocity,
    // so a world-space layer's prewarmed particles pile at that point (E16).
    if (spaceOk && v.space === "world" && em.prewarm === true)
      warn(ctx, `${path}.emission.prewarm`, "prewarmed particles spawn at the initial emitter position in world space");
  }

  // Reserved fields (locked decision L8) must be null in v1.
  if (v.subEmitters !== null && v.subEmitters !== undefined)
    err(ctx, `${path}.subEmitters`, "subEmitters is reserved and must be null in v1", "reserved-field");
  if (v.trail !== null && v.trail !== undefined)
    err(ctx, `${path}.trail`, "trail is reserved and must be null in v1", "reserved-field");
}

export function validateParticle(input: unknown): ValidationResult {
  const ctx: Ctx = { errors: [], warnings: [], textureNames: new Set(), duration: 0, looping: false };

  if (!isObject(input)) {
    err(ctx, "", "document must be an object");
    return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  }
  if (isNum(input.duration)) ctx.duration = input.duration;
  if (isBool(input.looping)) ctx.looping = input.looping;

  // schemaVersion (E11): >1 is a hard refusal; <1 / non-int is invalid.
  const sv = input.schemaVersion;
  if (!isInt(sv) || (sv as number) < 1) {
    err(ctx, "schemaVersion", "schemaVersion must be a positive integer", "invalid-version");
  } else if ((sv as number) > CURRENT_SCHEMA_VERSION) {
    err(
      ctx,
      "schemaVersion",
      `document schemaVersion ${sv} is newer than supported (${CURRENT_SCHEMA_VERSION})`,
      "newer-version",
    );
  }

  // meta
  if (!isObject(input.meta)) {
    err(ctx, "meta", "must be a meta object");
  } else {
    if (!isStr(input.meta.name)) err(ctx, "meta.name", "name must be a string");
    if (!isStr(input.meta.createdWith)) err(ctx, "meta.createdWith", "createdWith must be a string");
    if (!isStr(input.meta.notes)) err(ctx, "meta.notes", "notes must be a string");
  }

  // duration (E13)
  if (checkNumber(ctx, input.duration, "duration") && (input.duration as number) < 0.05)
    err(ctx, "duration", "duration must be >= 0.05 seconds", "duration-floor");

  if (!isBool(input.looping)) err(ctx, "looping", "looping must be a boolean");
  // Seed must be an integer in [0, 2^32): the sim coerces with `>>> 0`, so a
  // fractional or negative seed would round-trip a value the sim never uses. (P2.3)
  if (!isInt(input.seed) || (input.seed as number) < 0 || (input.seed as number) >= 2 ** 32)
    err(ctx, "seed", "seed must be an integer in [0, 4294967296)");

  // textures (optional). Collect names first so texture refs can be checked.
  if (input.textures !== undefined) {
    if (!isObject(input.textures)) {
      err(ctx, "textures", "textures must be an object of name -> data URL");
    } else {
      for (const [name, url] of Object.entries(input.textures)) {
        ctx.textureNames.add(name);
        if (!isStr(url)) err(ctx, `textures.${name}`, "texture data must be a string");
      }
    }
  }

  // layers (E14: 0 is valid; max 4)
  if (!Array.isArray(input.layers)) {
    err(ctx, "layers", "layers must be an array");
  } else {
    if (input.layers.length > 4) err(ctx, "layers", "a document may have at most 4 layers");
    input.layers.forEach((l, i) => checkLayer(ctx, l, `layers[${i}]`));
  }

  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  return { ok: true, doc: input as unknown as ParticleDoc, warnings: ctx.warnings };
}
