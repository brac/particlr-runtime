// Structural + semantic validation of a raw parsed object against the .prt v1
// schema (plan §2.12/§2.13). Never throws on bad data — it collects every issue
// with a JSON-path so the editor can surface them all at once. Unknown fields
// are ignored here (preserved elsewhere, plan §2.10).

import {
  ARC_MODES,
  ATTRACTOR_FALLOFFS,
  BLEND_MODES,
  BUILTIN_TEXTURE_IDS,
  CURRENT_SCHEMA_VERSION,
  EASES,
  EMIT_FROM,
  FLIPBOOK_MODES,
  POLYLINE_DIRECTIONS,
  SIM_SPACES,
  SUB_TRIGGERS,
  TRAIL_MODES,
  type ParticleDoc,
} from "./types.js";
import { decodeBase64, IMAGE_DATA_URL_RE } from "./base64.js";

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
  // Cross-layer state for sub-emitter reference checks (schemaVersion 3),
  // built in a first pass before any layer is validated.
  layerIds: Set<string>;
  layerSubEmittersNull: Map<string, boolean>; // id -> subEmitters === null
  layerContinuous: Map<string, boolean>; // id -> emits continuously (rate not constant-0)
  // Declared `params` names (schemaVersion 6, A9), collected before layers so the
  // per-knob binding checks (E32) can resolve `…Param` references.
  paramNames: Set<string>;
  // Declared `params` kinds by name (schemaVersion 8, COLOR_PARAM_PLAN C6), so the
  // binding checks can assert kind agreement (E34): scalar `…Param` bindings must
  // name a scalar param; `tintParam` must name a color param.
  paramKinds: Map<string, "scalar" | "color">;
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

// R3 (C2/C4): gate a nullable field, emitting a NON-BLOCKING warning when it is
// ABSENT (undefined) rather than explicit `null`. The format's normative
// convention is explicit-null for every "off" field, and the runtime core trusts
// it — its guards are strict `!== null` then dereference, so an absent field would
// crash the sim (C2) or silently shift the per-particle PRNG stream (C4).
// parseParticle normalizes absent→null BEFORE this validator runs (normalize.ts),
// so a parsed doc never triggers this — only a DIRECT validateParticle caller
// (hand-built test docs, npm consumers building docs programmatically) does, and
// they are told that explicit null is canonical. Returns whether the field is
// PRESENT-AND-NON-NULL, i.e. whether there is a value to validate; `null` or absent
// both return false (skip the sub-check). Never an error — hand-built docs must
// keep validating.
function presentNullable(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): boolean {
  const v = obj[key];
  if (v === undefined) {
    warn(ctx, `${path}.${key}`, `${key} is absent; treated as null (explicit null is canonical) (E43)`, "absent-nullable");
    return false;
  }
  return v !== null;
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

// `perParticle` (schemaVersion 5): only the eight per-particle over-lifetime
// tracks that own a reserved PRNG uniform (§0.2) may use the `randomBetweenCurves`
// mode; emitter-level tracks (emission.rateOverTime) reject it (E28).
function checkScalarTrack(ctx: Ctx, v: unknown, path: string, perParticle = false): void {
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
  } else if (v.mode === "randomBetweenCurves") {
    // A5 (E28): valid ONLY on the eight per-particle over-lifetime tracks. Its
    // `a`/`b` are validated exactly like `curve` keys.
    if (!perParticle) {
      err(ctx, `${path}.mode`, "randomBetweenCurves is per-particle only; it is not valid on this emitter-level track (E28)");
      return;
    }
    checkCurveKeys(ctx, v.a, `${path}.a`);
    checkCurveKeys(ctx, v.b, `${path}.b`);
  } else {
    err(
      ctx,
      `${path}.mode`,
      perParticle
        ? 'must be "constant", "range", "curve", or "randomBetweenCurves"'
        : 'must be "constant", "range", or "curve"',
    );
  }
}

function checkScalarTrackOrNull(ctx: Ctx, v: unknown, path: string, perParticle = false): void {
  if (v === null) return;
  checkScalarTrack(ctx, v, path, perParticle);
}

// A ScalarTrack that forbids per-particle "range" mode: some schemaVersion-3
// modules (noise.strength, bySpeed.*, trail.width) reserve no per-particle PRNG
// draw, so only constant/curve are expressible (TIER1_PLAN §0.4). schemaVersion 5
// extends the ban to `randomBetweenCurves` (also per-particle only) so A4's
// limitVelocity and every deterministic track stay constant/curve (E28).
function checkScalarTrackNoRange(ctx: Ctx, v: unknown, path: string): void {
  if (isObject(v) && (v.mode === "range" || v.mode === "randomBetweenCurves")) {
    err(ctx, `${path}.mode`, `${v.mode} mode is not supported here; use constant or curve`);
    return;
  }
  checkScalarTrack(ctx, v, path);
}

// A number in [0,1] (bounce, dampen, lifetimeLoss, probability, flip chance).
function checkUnit(ctx: Ctx, v: unknown, path: string): void {
  if (checkNumber(ctx, v, path) && ((v as number) < 0 || (v as number) > 1))
    err(ctx, path, "must be in [0, 1]");
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

// Arc mode + speed (schemaVersion 3), shared by circle and cone. Validated when
// present (migration injects them; a bare v2-style shape simply has no arc sweep).
function checkArcModeSpeed(ctx: Ctx, v: Record<string, unknown>, path: string): void {
  if (v.arcMode !== undefined) checkEnum(ctx, v.arcMode, ARC_MODES, `${path}.arcMode`);
  if (v.arcSpeed !== undefined && checkNumber(ctx, v.arcSpeed, `${path}.arcSpeed`) && (v.arcSpeed as number) < 0)
    err(ctx, `${path}.arcSpeed`, "arcSpeed must be >= 0");
}

// Circle donut + arc span (schemaVersion 3), plus the shared arc mode/speed.
function checkArc(ctx: Ctx, v: Record<string, unknown>, path: string, radius: number): void {
  if (v.innerRadius !== undefined && checkNumber(ctx, v.innerRadius, `${path}.innerRadius`)) {
    const inner = v.innerRadius as number;
    if (inner < 0) err(ctx, `${path}.innerRadius`, "innerRadius must be >= 0");
    else if (inner > radius) err(ctx, `${path}.innerRadius`, "innerRadius must be <= radius");
  }
  if (v.arc !== undefined && checkNumber(ctx, v.arc, `${path}.arc`)) {
    const arc = v.arc as number;
    if (arc <= 0 || arc > 360) err(ctx, `${path}.arc`, "arc must be in (0, 360]");
  }
  checkArcModeSpeed(ctx, v, path);
}

// Emit-from-texture mask (schemaVersion 4). Structural problems (missing object,
// non-integer / out-of-range dims, non-string data) are ERRORS. Semantic
// corruption (undecodable base64, decoded length ≠ width·height, or zero pixels
// passing the threshold) is a non-blocking WARNING (E23, code "bad-mask"): the
// layer degrades to point-shape spawning at runtime, and the document data is
// preserved untouched. `threshold` is the (already-validated) shape threshold.
function checkMask(ctx: Ctx, v: unknown, path: string, threshold: unknown): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a MaskData object");
    return;
  }
  const okW = isInt(v.width) && (v.width as number) >= 1 && (v.width as number) <= 128;
  const okH = isInt(v.height) && (v.height as number) >= 1 && (v.height as number) <= 128;
  if (!okW) err(ctx, `${path}.width`, "mask width must be an integer in [1, 128]");
  if (!okH) err(ctx, `${path}.height`, "mask height must be an integer in [1, 128]");
  if (!isStr(v.data)) {
    err(ctx, `${path}.data`, "mask data must be a base64 string");
    return;
  }
  if (!okW || !okH) return; // can't check length/coverage without sound dims
  // All E23 conditions share one message tail (the runtime degrades identically).
  const badMask = (reason: string): void =>
    warn(ctx, path, `mask ${reason}; the layer will emit from a point (E23)`, "bad-mask");
  const bytes = decodeBase64(v.data);
  if (bytes === null) return badMask("data is not valid base64");
  const expected = (v.width as number) * (v.height as number);
  if (bytes.length !== expected) return badMask(`data length ${bytes.length} does not match width·height (${expected})`);
  // Zero passing pixels: with the threshold gate, no pixel carries weight (a
  // pixel emits iff alpha > 0 and alpha/255 >= threshold — 0.3a).
  const gate = (isNum(threshold) ? Math.max(0, Math.min(1, threshold as number)) : 0) * 255;
  let anyPass = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i]! > 0 && bytes[i]! >= gate) {
      anyPass = true;
      break;
    }
  }
  if (!anyPass) badMask("has no pixels passing the threshold");
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
      checkArc(ctx, v, path, isNum(v.radius) ? (v.radius as number) : Infinity);
      break;
    case "cone":
      checkNumber(ctx, v.direction, `${path}.direction`);
      checkNumber(ctx, v.spread, `${path}.spread`);
      checkNumber(ctx, v.radius, `${path}.radius`);
      checkArcModeSpeed(ctx, v, path);
      break;
    case "rect":
      checkNumber(ctx, v.width, `${path}.width`);
      checkNumber(ctx, v.height, `${path}.height`);
      break;
    case "edge":
      checkNumber(ctx, v.length, `${path}.length`);
      break;
    case "polyline":
      checkPolyline(ctx, v, path);
      break;
    case "texture":
      if (checkNumber(ctx, v.width, `${path}.width`) && (v.width as number) <= 0)
        err(ctx, `${path}.width`, "width must be > 0");
      if (checkNumber(ctx, v.height, `${path}.height`) && (v.height as number) <= 0)
        err(ctx, `${path}.height`, "height must be > 0");
      if (checkNumber(ctx, v.threshold, `${path}.threshold`) && ((v.threshold as number) < 0 || (v.threshold as number) > 1))
        err(ctx, `${path}.threshold`, "threshold must be in [0, 1]");
      checkMask(ctx, v.mask, `${path}.mask`, v.threshold);
      // E26: surface emission has no effect on a texture shape (treated as volume).
      if (v.emitFrom === "surface")
        warn(ctx, `${path}.emitFrom`, 'emitFrom "surface" has no effect on a texture shape (treated as volume) (E26)');
      // emit-from-texture behaves as of M1 — no "unimplemented" warning (the E23
      // bad-mask and E26 surface hints above still apply).
      break;
    default:
      err(ctx, `${path}.kind`, "must be one of: point, circle, cone, rect, edge, polyline, texture");
  }
}

// Polyline spawn shape (schemaVersion 10, B1). Structural problems (points not an
// array of 2..64 finite {x,y}, non-boolean closed, bad direction enum) are ERRORS.
// A DEGENERATE polyline (all points coincident ⇒ zero total arc length) is a
// non-blocking WARNING (E37, code "bad-polyline"): the layer degrades to
// point-shape spawning at the layer origin, exactly the E23 bad-mask pattern.
// schemaVersion 12 (CURVES) adds `smoothing` (E42, checked below). The degeneracy
// test still keys on the STRAIGHT-point total length: a curve through
// near-coincident points is itself near-zero (both totals vanish only when all
// points coincide), so the E37 predicate stays a conservative, boundary-exact proxy
// for the flattened-chain length the sampler measures (research trap 4).
function checkPolyline(ctx: Ctx, v: Record<string, unknown>, path: string): void {
  if (!Array.isArray(v.points)) {
    err(ctx, `${path}.points`, "points must be an array");
    return;
  }
  if (v.points.length < 2 || v.points.length > 64) {
    err(ctx, `${path}.points`, "points must have 2..64 entries");
  }
  let allFinite = true;
  v.points.forEach((p, i) => {
    const pp = `${path}.points[${i}]`;
    if (!isObject(p)) {
      err(ctx, pp, "point must be an {x,y} object");
      allFinite = false;
      return;
    }
    if (!checkNumber(ctx, p.x, `${pp}.x`)) allFinite = false;
    if (!checkNumber(ctx, p.y, `${pp}.y`)) allFinite = false;
  });
  if (v.closed !== undefined && !isBool(v.closed)) err(ctx, `${path}.closed`, "closed must be a boolean");
  // E42 (schemaVersion 12, CURVES): Catmull-Rom smoothing, finite ∈ [0,1]. Tolerant
  // of absent (like `closed` above) — a legacy/hand-built polyline without smoothing
  // is treated as `0` (the migration/authoring default and the sampler's `> 0`
  // short-circuit both key on the same zero), so it stays valid AND bit-identical.
  // A PRESENT value must be finite and in range; non-finite hits checkNumber's
  // generic message, out-of-range is the E42 message (the minKillSpeed/E38 pattern).
  if (
    v.smoothing !== undefined &&
    checkNumber(ctx, v.smoothing, `${path}.smoothing`) &&
    ((v.smoothing as number) < 0 || (v.smoothing as number) > 1)
  )
    err(ctx, `${path}.smoothing`, "smoothing must be in [0, 1] (E42)");
  checkEnum(ctx, v.direction, POLYLINE_DIRECTIONS, `${path}.direction`);
  // E37 degenerate check: with sound, finite points, warn (do not reject) when the
  // total arc length is ~zero — the runtime spawns from a point (position (0,0),
  // random direction). Only checked when every point parsed cleanly.
  if (allFinite && Array.isArray(v.points) && v.points.length >= 2) {
    let total = 0;
    for (let i = 1; i < v.points.length; i++) {
      const a = v.points[i - 1] as { x: number; y: number };
      const b = v.points[i] as { x: number; y: number };
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (v.closed === true && v.points.length >= 2) {
      const a = v.points[v.points.length - 1] as { x: number; y: number };
      const b = v.points[0] as { x: number; y: number };
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (total < 1e-6)
      warn(ctx, path, "polyline has zero total length; the layer will emit from a point (E37)", "bad-polyline");
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
  // A7 (schemaVersion 5): randomStartFrame (bool, required) + frameOverLife
  // (null or a deterministic constant/curve track — no range/randomBetweenCurves).
  if (!isBool(v.randomStartFrame)) err(ctx, `${path}.randomStartFrame`, "randomStartFrame must be a boolean");
  if (presentNullable(ctx, v, "frameOverLife", path))
    checkScalarTrackNoRange(ctx, v.frameOverLife, `${path}.frameOverLife`);
  // A7 flipbook upgrades behave as of M4 (render.ts flipbookFrame, E30
  // precedence), so randomStartFrame / frameOverLife no longer draw the temporary
  // "unimplemented" warning.
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
  if (presentNullable(ctx, v, "rateOverDistance", path)) {
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
      // Burst cycles / interval / probability (schemaVersion 3), validated when
      // present (migration injects cycles:1, interval:0, probability:1).
      let cycles = 1;
      if (b.cycles !== undefined) {
        if (!isInt(b.cycles) || (b.cycles as number) < 1)
          err(ctx, `${bp}.cycles`, "cycles must be an integer >= 1");
        else cycles = b.cycles as number;
      }
      if (b.interval !== undefined) {
        if (!isNum(b.interval) || (b.interval as number) < 0)
          err(ctx, `${bp}.interval`, "interval must be a number >= 0");
        else if (cycles > 1 && (b.interval as number) <= 0)
          err(ctx, `${bp}.interval`, "interval must be > 0 when cycles > 1");
      }
      if (b.probability !== undefined)
        checkUnit(ctx, b.probability, `${bp}.probability`);
      // Authoring-trap warnings: a burst whose (spread) window exceeds the
      // per-cycle emission window silently loses sub-events. (P2.2 / P2.3)
      // Extended to the LAST cycle (schemaVersion 3, M4): a cycle whose window
      // opens past the emission window never fires (same wrap semantics as a
      // single burst past the window).
      if (ctx.duration > 0 && isNum(b.time) && isNum(b.spread)) {
        const delay = isNum(v.delay) ? v.delay : 0;
        const windowEnd = ctx.duration - delay;
        const interval = isNum(b.interval) ? b.interval : 0;
        const lastCycleTime = b.time + (cycles - 1) * interval;
        if (lastCycleTime > windowEnd) {
          warn(ctx, `${bp}.time`, "burst time is past the emission window (duration − delay); this burst will not fire");
        } else if (lastCycleTime + b.spread > windowEnd) {
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
  // A9 bindings (schemaVersion 6): rate-over-time / rate-over-distance (E32/E34).
  checkParamBinding(ctx, v.rateOverTimeParam, `${path}.rateOverTimeParam`, "scalar");
  checkParamBinding(ctx, v.rateOverDistanceParam, `${path}.rateOverDistanceParam`, "scalar");
}

function checkInitial(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be an InitialProps object");
    return;
  }
  for (const key of ["life", "speed", "size", "rotation", "angularVelocity"] as const) {
    checkScalarInit(ctx, v[key], `${path}.${key}`);
  }
  // A9 bindings (schemaVersion 6): initial speed/life/size may name a param (E32/E34).
  checkParamBinding(ctx, v.speedParam, `${path}.speedParam`, "scalar");
  checkParamBinding(ctx, v.lifeParam, `${path}.lifeParam`, "scalar");
  checkParamBinding(ctx, v.sizeParam, `${path}.sizeParam`, "scalar");
}

// Host-parameter binding (schemaVersion 6 E32; schemaVersion 8 E34): a `…Param`
// field is either `null`/absent (unbound = pre-binding behavior) or a non-empty
// string naming a declared `params` entry. A non-null value that is not a
// non-empty string, or that names a param absent from `params`, is an E32 error
// (A9_PLAN §0.4). `requiredKind` (schemaVersion 8, COLOR_PARAM_PLAN C6): the named
// param must be of that kind — a scalar `…Param` naming a color param, or
// `tintParam` naming a scalar param, is an E34 error. `shapeCode` (schemaVersion 11,
// WINDP) overrides the string-or-null shape-error code — the two wind bindings pass
// "E41" (their genuinely-new shape check) while STILL reusing this same declared-
// param-name cross-check (unknown name = the existing E32 error, kind = E34).
function checkParamBinding(ctx: Ctx, v: unknown, path: string, requiredKind: "scalar" | "color", shapeCode = "E32"): void {
  if (v === null || v === undefined) return;
  if (!isStr(v) || v.length === 0) {
    err(ctx, path, `param binding must be a non-empty string or null (${shapeCode})`);
    return;
  }
  if (!ctx.paramNames.has(v)) {
    err(ctx, path, `param binding names unknown param "${v}" (E32)`);
    return;
  }
  const actualKind = ctx.paramKinds.get(v);
  if (actualKind !== undefined && actualKind !== requiredKind) {
    err(ctx, path, `param binding requires a ${requiredKind} param but "${v}" is a ${actualKind} param (E34)`);
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
  // The eight per-particle over-lifetime tracks (§0.2) accept randomBetweenCurves
  // (schemaVersion 5): each owns a reserved spawn uniform, so the mode adds no new
  // draw. `perParticle = true` unlocks it here (and only here).
  checkScalarTrackOrNull(ctx, v.size, `${path}.size`, true);
  checkGradient(ctx, v.color, `${path}.color`);
  checkScalarTrackOrNull(ctx, v.rotation, `${path}.rotation`, true);
  if (!isObject(v.velocity)) {
    err(ctx, `${path}.velocity`, "must be a Velocity object");
  } else {
    checkVec2(ctx, v.velocity.gravity, `${path}.velocity.gravity`);
    // A9 binding (schemaVersion 6): gravity may name a param (E32/E34).
    checkParamBinding(ctx, v.velocity.gravityParam, `${path}.velocity.gravityParam`, "scalar");
    checkScalarTrackOrNull(ctx, v.velocity.drag, `${path}.velocity.drag`, true);
    checkScalarTrackOrNull(ctx, v.velocity.speedMultiplier, `${path}.velocity.speedMultiplier`, true);
    // Velocity over lifetime (schemaVersion 3): four optional additive tracks.
    // C4: absent here silently shifts the PRNG stream (an extra per-particle draw
    // vs an explicit-null track), so warn on absence (presentNullable) — parsed
    // docs are normalized so only direct callers see it.
    for (const key of ["x", "y", "orbital", "radial"] as const) {
      if (presentNullable(ctx, v.velocity, key, `${path}.velocity`))
        checkScalarTrackOrNull(ctx, v.velocity[key], `${path}.velocity.${key}`, true);
    }
  }
}

// --- schemaVersion 3 feature modules ---------------------------------------
// Each is off when null; validated structurally when present. Until the owning
// milestone lands, a present module also draws a temporary "unimplemented"
// warning (removed in that milestone) — the field is accepted but inert.

function checkNoise(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a NoiseConfig object or null");
    return;
  }
  checkScalarTrackNoRange(ctx, v.strength, `${path}.strength`);
  if (checkNumber(ctx, v.frequency, `${path}.frequency`) && (v.frequency as number) <= 0)
    err(ctx, `${path}.frequency`, "frequency must be > 0");
  checkNumber(ctx, v.scrollSpeed, `${path}.scrollSpeed`);
  if (!isInt(v.octaves) || (v.octaves as number) < 1 || (v.octaves as number) > 3)
    err(ctx, `${path}.octaves`, "octaves must be an integer in [1, 3]");
}

function checkRender(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a RenderConfig object or null");
    return;
  }
  checkEnum(ctx, v.align, ["none", "velocity"] as const, `${path}.align`);
  checkNumber(ctx, v.speedScale, `${path}.speedScale`);
  const okMin = checkNumber(ctx, v.minStretch, `${path}.minStretch`);
  const okMax = checkNumber(ctx, v.maxStretch, `${path}.maxStretch`);
  if (okMin && okMax && (v.minStretch as number) > (v.maxStretch as number))
    err(ctx, path, "minStretch must be <= maxStretch");
}

function checkBySpeed(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a BySpeedConfig object or null");
    return;
  }
  if (!isObject(v.range)) {
    err(ctx, `${path}.range`, "must be a {min,max} object");
  } else {
    const okMin = checkNumber(ctx, v.range.min, `${path}.range.min`);
    const okMax = checkNumber(ctx, v.range.max, `${path}.range.max`);
    if (okMin && okMax && (v.range.min as number) > (v.range.max as number))
      err(ctx, `${path}.range`, "range min must be <= max");
  }
  if (v.size !== null) checkScalarTrackNoRange(ctx, v.size, `${path}.size`);
  if (v.color !== null) checkGradient(ctx, v.color, `${path}.color`);
  if (v.rotation !== null) checkScalarTrackNoRange(ctx, v.rotation, `${path}.rotation`);
}

function checkStartColor(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a StartColor object or null");
    return;
  }
  if (v.mode === "gradients") {
    checkGradient(ctx, v.a, `${path}.a`);
    checkGradient(ctx, v.b, `${path}.b`);
  } else if (v.mode === "palette") {
    if (!Array.isArray(v.colors) || v.colors.length < 1 || v.colors.length > 16) {
      err(ctx, `${path}.colors`, "colors must be an array of 1..16 RGBA colors");
    } else {
      v.colors.forEach((c, i) => {
        const cp = `${path}.colors[${i}]`;
        if (!isObject(c)) {
          err(ctx, cp, "color must be an {r,g,b,a} object");
          return;
        }
        for (const ch of ["r", "g", "b", "a"] as const) {
          if (checkNumber(ctx, c[ch], `${cp}.${ch}`) && ((c[ch] as number) < 0 || (c[ch] as number) > 1))
            err(ctx, `${cp}.${ch}`, `${ch} must be in [0,1]`);
        }
      });
    }
  } else if (v.mode === "hueJitter") {
    // A6 (schemaVersion 5): degrees finite ∈ [0, 180]. Mutually exclusive with
    // gradients/palette (a distinct mode arm). Behaves as of M3 (the render-time
    // per-particle hue rotation), so it no longer draws an "unimplemented" warning.
    if (checkNumber(ctx, v.degrees, `${path}.degrees`) && ((v.degrees as number) < 0 || (v.degrees as number) > 180))
      err(ctx, `${path}.degrees`, "degrees must be in [0, 180]");
  } else {
    err(ctx, `${path}.mode`, 'must be "gradients", "palette", or "hueJitter"');
  }
}

function checkRandomFlip(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a RandomFlip object or null");
    return;
  }
  checkUnit(ctx, v.x, `${path}.x`);
  checkUnit(ctx, v.y, `${path}.y`);
}

function checkCollision(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a CollisionConfig object or null");
    return;
  }
  if (!isObject(v.shape)) {
    err(ctx, `${path}.shape`, "must be a collision shape object");
  } else if (v.shape.kind === "floor") {
    checkNumber(ctx, v.shape.y, `${path}.shape.y`);
  } else if (v.shape.kind === "rect") {
    checkNumber(ctx, v.shape.x, `${path}.shape.x`);
    checkNumber(ctx, v.shape.y, `${path}.shape.y`);
    checkNumber(ctx, v.shape.width, `${path}.shape.width`);
    checkNumber(ctx, v.shape.height, `${path}.shape.height`);
  } else {
    err(ctx, `${path}.shape.kind`, 'must be "floor" or "rect"');
  }
  checkUnit(ctx, v.bounce, `${path}.bounce`);
  checkUnit(ctx, v.dampen, `${path}.dampen`);
  checkUnit(ctx, v.lifetimeLoss, `${path}.lifetimeLoss`);
  // Kill-on-collide + min-kill-speed (schemaVersion 10, E38), validated WHEN
  // PRESENT (migration injects killOnCollide:false, minKillSpeed:0). killOnCollide
  // a boolean; minKillSpeed a finite number >= 0.
  if (v.killOnCollide !== undefined && !isBool(v.killOnCollide))
    err(ctx, `${path}.killOnCollide`, "killOnCollide must be a boolean (E38)");
  if (v.minKillSpeed !== undefined && checkNumber(ctx, v.minKillSpeed, `${path}.minKillSpeed`) && (v.minKillSpeed as number) < 0)
    err(ctx, `${path}.minKillSpeed`, "minKillSpeed must be >= 0 (E38)");
}

// Kill zones (schemaVersion 10, B3, E38): a layer-level `Rect[] | null`. At most 8
// rects; each a finite `{x,y,width,height}` with width/height > 0. A particle whose
// integrated position lands inside any rect dies (ageLoss += lifetime).
function checkKillZones(ctx: Ctx, v: unknown, path: string): void {
  if (!Array.isArray(v)) {
    err(ctx, path, "killZones must be an array or null (E38)");
    return;
  }
  if (v.length > 8) err(ctx, path, "killZones may have at most 8 rects (E38)");
  v.forEach((z, i) => {
    const zp = `${path}[${i}]`;
    if (!isObject(z)) {
      err(ctx, zp, "kill zone must be an {x,y,width,height} object (E38)");
      return;
    }
    checkNumber(ctx, z.x, `${zp}.x`);
    checkNumber(ctx, z.y, `${zp}.y`);
    if (checkNumber(ctx, z.width, `${zp}.width`) && (z.width as number) <= 0)
      err(ctx, `${zp}.width`, "width must be > 0 (E38)");
    if (checkNumber(ctx, z.height, `${zp}.height`) && (z.height as number) <= 0)
      err(ctx, `${zp}.height`, "height must be > 0 (E38)");
  });
}

// By-emitter-speed (schemaVersion 10, B5, E39): a `{range:{min,max}, size, speed,
// life}` module. Mirrors checkBySpeed's range rule; each of size/speed/life is null
// or a checkScalarTrackNoRange track (constant/curve only — the value is per-
// spawn-step, so no per-particle range mode, zero draws).
function checkByEmitterSpeed(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a ByEmitterSpeedConfig object or null");
    return;
  }
  if (!isObject(v.range)) {
    err(ctx, `${path}.range`, "must be a {min,max} object");
  } else {
    const okMin = checkNumber(ctx, v.range.min, `${path}.range.min`);
    const okMax = checkNumber(ctx, v.range.max, `${path}.range.max`);
    if (okMin && okMax && (v.range.min as number) > (v.range.max as number))
      err(ctx, `${path}.range`, "range min must be <= max");
  }
  for (const key of ["size", "speed", "life"] as const) {
    if (presentNullable(ctx, v, key, path)) checkScalarTrackNoRange(ctx, v[key], `${path}.${key}`);
  }
}

// Wind (schemaVersion 10, B6, E40): `{direction, strength, gustFrequency,
// gustAmount}`. direction finite; strength constant/curve only
// (checkScalarTrackNoRange — zero draws, the noise.strength ruling); gustFrequency
// finite >= 0; gustAmount a unit [0,1]. schemaVersion 11 (WINDP, E41): the two
// `wind…Param` scalar bindings, checked at the end.
function checkWind(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a WindConfig object or null");
    return;
  }
  checkNumber(ctx, v.direction, `${path}.direction`);
  checkScalarTrackNoRange(ctx, v.strength, `${path}.strength`);
  if (checkNumber(ctx, v.gustFrequency, `${path}.gustFrequency`) && (v.gustFrequency as number) < 0)
    err(ctx, `${path}.gustFrequency`, "gustFrequency must be >= 0");
  checkUnit(ctx, v.gustAmount, `${path}.gustAmount`);
  // WINDP bindings (schemaVersion 11): strength/direction may name a scalar param.
  // E41 is the genuinely-new string-or-null shape check; the declared-name cross-
  // check reuses the existing machinery (unknown name = E32, kind mismatch = E34),
  // exactly like sizeParam et al.
  checkParamBinding(ctx, v.windStrengthParam, `${path}.windStrengthParam`, "scalar", "E41");
  checkParamBinding(ctx, v.windDirectionParam, `${path}.windDirectionParam`, "scalar", "E41");
}

function checkTrail(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a TrailConfig object or null");
    return;
  }
  // Trail topology (schemaVersion 9, RIBBON_INHERIT_PLAN R1): one of the two modes
  // when present (migration injects "perParticle"). In "connect" mode maxPoints /
  // minVertexDistance are documented-ignored but still range-checked below.
  if (v.mode !== undefined) checkEnum(ctx, v.mode, TRAIL_MODES, `${path}.mode`);
  if (!isInt(v.maxPoints) || (v.maxPoints as number) < 2 || (v.maxPoints as number) > 32)
    err(ctx, `${path}.maxPoints`, "maxPoints must be an integer in [2, 32]");
  if (!isNum(v.minVertexDistance) || (v.minVertexDistance as number) <= 0)
    err(ctx, `${path}.minVertexDistance`, "minVertexDistance must be > 0");
  checkScalarTrackNoRange(ctx, v.width, `${path}.width`);
  if (v.color !== null) checkGradient(ctx, v.color, `${path}.color`);
}

// Point attractor / vortex (schemaVersion 4). strength/tangential are
// constant/curve only (checkScalarTrackNoRange — no per-particle range mode, so
// no reserved PRNG draw, same ruling as noise.strength). radius > 0; killRadius
// in [0, radius] (0 = off). The E24 local-frame hint is emitted by checkLayer.
function checkAttractor(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be an AttractorConfig object or null");
    return;
  }
  checkNumber(ctx, v.x, `${path}.x`);
  checkNumber(ctx, v.y, `${path}.y`);
  checkScalarTrackNoRange(ctx, v.strength, `${path}.strength`);
  if (v.tangential !== null) checkScalarTrackNoRange(ctx, v.tangential, `${path}.tangential`);
  checkEnum(ctx, v.falloff, ATTRACTOR_FALLOFFS, `${path}.falloff`);
  const okR = checkNumber(ctx, v.radius, `${path}.radius`);
  if (okR && (v.radius as number) <= 0) err(ctx, `${path}.radius`, "radius must be > 0");
  if (checkNumber(ctx, v.killRadius, `${path}.killRadius`)) {
    const kr = v.killRadius as number;
    if (kr < 0) err(ctx, `${path}.killRadius`, "killRadius must be >= 0");
    else if (okR && kr > (v.radius as number)) err(ctx, `${path}.killRadius`, "killRadius must be <= radius");
  }
}

// Alpha-erosion dissolve (schemaVersion 4). Renderer-only; the E25 trail-conflict
// hint is emitted by checkLayer.
function checkDissolve(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    err(ctx, path, "must be a DissolveConfig object or null");
    return;
  }
  if (checkNumber(ctx, v.frequency, `${path}.frequency`) && ((v.frequency as number) <= 0 || (v.frequency as number) > 64))
    err(ctx, `${path}.frequency`, "frequency must be in (0, 64]");
  checkVec2(ctx, v.scroll, `${path}.scroll`);
  if (checkNumber(ctx, v.edgeWidth, `${path}.edgeWidth`) && ((v.edgeWidth as number) < 0 || (v.edgeWidth as number) > 1))
    err(ctx, `${path}.edgeWidth`, "edgeWidth must be in [0, 1]");
  if (v.edgeColor !== null) {
    if (!isObject(v.edgeColor)) {
      err(ctx, `${path}.edgeColor`, "edgeColor must be an {r,g,b,a} object or null");
    } else {
      for (const ch of ["r", "g", "b", "a"] as const) {
        if (checkNumber(ctx, v.edgeColor[ch], `${path}.edgeColor.${ch}`) && ((v.edgeColor[ch] as number) < 0 || (v.edgeColor[ch] as number) > 1))
          err(ctx, `${path}.edgeColor.${ch}`, `${ch} must be in [0,1]`);
      }
    }
  }
}

// Sub-emitter refs need cross-layer state, so this runs against the ctx registry
// built in validateParticle. `selfId` is the owning layer's id (self-ref is
// illegal; a referenced layer must itself have subEmitters === null — depth 1).
function checkSubEmitters(ctx: Ctx, v: unknown, path: string, selfId: string): void {
  if (!Array.isArray(v)) {
    err(ctx, path, "subEmitters must be an array or null");
    return;
  }
  v.forEach((s, i) => {
    const sp = `${path}[${i}]`;
    if (!isObject(s)) {
      err(ctx, sp, "sub-emitter ref must be an object");
      return;
    }
    checkEnum(ctx, s.trigger, SUB_TRIGGERS, `${sp}.trigger`);
    if (!isStr(s.layerId) || s.layerId.length === 0) {
      err(ctx, `${sp}.layerId`, "layerId must be a non-empty string");
    } else if (s.layerId === selfId) {
      err(ctx, `${sp}.layerId`, "a layer cannot sub-emit into itself");
    } else if (!ctx.layerIds.has(s.layerId)) {
      err(ctx, `${sp}.layerId`, `layerId "${s.layerId}" does not match any layer`);
    } else if (ctx.layerSubEmittersNull.get(s.layerId) === false) {
      err(ctx, `${sp}.layerId`, `sub-emitter target "${s.layerId}" itself has sub-emitters (depth 1 only)`);
    } else if (ctx.layerContinuous.get(s.layerId) === true) {
      warn(ctx, `${sp}.layerId`, `sub-emitter target "${s.layerId}" has a continuous emission rate; children usually emit only on the trigger`);
    }
    if (!isInt(s.count) || (s.count as number) < 1 || (s.count as number) > 100)
      err(ctx, `${sp}.count`, "count must be an integer in [1, 100]");
    checkUnit(ctx, s.probability, `${sp}.probability`);
    if (checkNumber(ctx, s.inheritVelocity, `${sp}.inheritVelocity`) && ((s.inheritVelocity as number) < -2 || (s.inheritVelocity as number) > 2))
      err(ctx, `${sp}.inheritVelocity`, "inheritVelocity must be in [-2, 2]");
    // E35 (schemaVersion 9, RIBBON_INHERIT_PLAN I5): the three inheritance flags
    // must be booleans WHEN PRESENT (migration injects false ×3). Dedicated inherit
    // columns sidestep the hueJitter-tint collision, so no cross-layer rule is needed.
    for (const flag of ["inheritColor", "inheritSize", "inheritRotation"] as const) {
      if (s[flag] !== undefined && !isBool(s[flag]))
        err(ctx, `${sp}.${flag}`, `${flag} must be a boolean (E35)`);
    }
  });
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
  // A9 binding (schemaVersion 6): layer-level opacity may name a scalar param (E32/E34).
  checkParamBinding(ctx, v.opacityParam, `${path}.opacityParam`, "scalar");
  // Color binding (schemaVersion 8, COLOR_PARAM_PLAN C6): tint must name a COLOR param.
  checkParamBinding(ctx, v.tintParam, `${path}.tintParam`, "color");

  // A4 limit-velocity (schemaVersion 5); null = off. A deterministic constant/curve
  // track (no range/randomBetweenCurves — checkScalarTrackNoRange, E27). Behaves as
  // of M1 (the sim velocity clamp), so it no longer draws an "unimplemented" warning.
  if (presentNullable(ctx, v, "limitVelocity", path)) {
    checkScalarTrackNoRange(ctx, v.limitVelocity, `${path}.limitVelocity`);
  }

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
  // Host-attractor influence (schemaVersion 4). Mirrors inheritVelocity: a plain
  // constant in [-2, 2], zero PRNG draws. Behaves as of M2 (the host setAttractor
  // hook), so it no longer draws the temporary "unimplemented" warning.
  if (v.attractorInfluence !== undefined) {
    if (!isNum(v.attractorInfluence)) {
      err(ctx, `${path}.attractorInfluence`, "must be a finite number");
    } else if ((v.attractorInfluence as number) < -2 || (v.attractorInfluence as number) > 2) {
      err(ctx, `${path}.attractorInfluence`, "attractorInfluence must be in [-2, 2]");
    }
  } else {
    err(ctx, `${path}.attractorInfluence`, "must be a finite number");
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

  // schemaVersion 3 feature modules (each null = off). Validated when present.
  // As of M9 (the final Tier-1 milestone) every module is implemented, so none
  // draws the temporary "unimplemented" warning any longer.
  const selfId = isStr(v.id) ? v.id : "";
  if (presentNullable(ctx, v, "noise", path)) {
    // noise behaves as of M2 — no "unimplemented" warning.
    checkNoise(ctx, v.noise, `${path}.noise`);
  }
  if (presentNullable(ctx, v, "bySpeed", path)) {
    // bySpeed behaves as of M6 — no "unimplemented" warning.
    checkBySpeed(ctx, v.bySpeed, `${path}.bySpeed`);
  }
  // schemaVersion 10 modules (each null = off). Validated when present.
  if (presentNullable(ctx, v, "wind", path)) checkWind(ctx, v.wind, `${path}.wind`);
  if (presentNullable(ctx, v, "byEmitterSpeed", path))
    checkByEmitterSpeed(ctx, v.byEmitterSpeed, `${path}.byEmitterSpeed`);
  if (presentNullable(ctx, v, "startColor", path)) {
    // startColor behaves as of M5 — no "unimplemented" warning.
    checkStartColor(ctx, v.startColor, `${path}.startColor`);
  }
  if (presentNullable(ctx, v, "randomFlip", path)) {
    // randomFlip behaves as of M5 — no "unimplemented" warning.
    checkRandomFlip(ctx, v.randomFlip, `${path}.randomFlip`);
  }
  if (presentNullable(ctx, v, "render", path)) {
    // render behaves as of M1 — no "unimplemented" warning (the align:"velocity"
    // rotation-override warning below still applies).
    checkRender(ctx, v.render, `${path}.render`);
  }
  if (presentNullable(ctx, v, "collision", path)) {
    // collision behaves as of M7 — no "unimplemented" warning (the E20 local-frame
    // hint below still applies).
    checkCollision(ctx, v.collision, `${path}.collision`);
    // E20 hint: in local space, collision planes ride the emitter (they live in
    // the layer's local sim frame, not world coordinates).
    if (spaceOk && v.space === "local")
      warn(ctx, `${path}.collision`, "collision planes are in the layer's local frame and ride the emitter (E20)");
  }
  // Kill zones (schemaVersion 10, E38); null = none. Death regions in the layer's
  // sim frame — local-space zones ride the emitter (E20 lineage).
  if (presentNullable(ctx, v, "killZones", path)) {
    checkKillZones(ctx, v.killZones, `${path}.killZones`);
    if (spaceOk && v.space === "local")
      warn(ctx, `${path}.killZones`, "kill zones are in the layer's local frame and ride the emitter (E20)");
  }
  if (presentNullable(ctx, v, "subEmitters", path)) {
    // subEmitters behave as of M8 — no "unimplemented" warning (the depth-1 /
    // self-ref / count / continuous-child checks in checkSubEmitters still apply).
    checkSubEmitters(ctx, v.subEmitters, `${path}.subEmitters`, selfId);
  }
  if (presentNullable(ctx, v, "trail", path)) {
    // trail behaves as of M9 — no "unimplemented" warning (the E18 flipbook hint
    // below still applies).
    checkTrail(ctx, v.trail, `${path}.trail`);
    // E18: a trail samples the texture as a ribbon; flipbook frames are ignored.
    if (isObject(v.texture) && v.texture.frames !== null && v.texture.frames !== undefined)
      warn(ctx, `${path}.trail`, "flipbook frames are ignored for trail ribbon sampling (E18)");
  }

  // schemaVersion 4 feature modules (each null = off). Validated when present.
  if (presentNullable(ctx, v, "dissolve", path)) {
    // dissolve behaves as of M3 — no "unimplemented" warning (the E25 trail
    // hint below still applies).
    checkDissolve(ctx, v.dissolve, `${path}.dissolve`);
    // E25: dissolve does not erode a trail ribbon (separate mesh shader).
    if (v.trail !== null && v.trail !== undefined)
      warn(ctx, `${path}.dissolve`, "dissolve does not erode trail ribbons; the trail renders un-eroded (E25)");
  }
  if (presentNullable(ctx, v, "attractor", path)) {
    // attractor behaves as of M2 — no "unimplemented" warning (the E24 local-frame
    // hint below still applies).
    checkAttractor(ctx, v.attractor, `${path}.attractor`);
    // E24: in local space the attractor point rides the emitter (its coordinates
    // are in the layer's local sim frame, not world coordinates).
    if (spaceOk && v.space === "local")
      warn(ctx, `${path}.attractor`, "attractor coordinates are in the layer's local frame and ride the emitter (E24)");
  }

  // Rendering-conflict warnings (schemaVersion 3).
  if (isObject(v.render) && v.render.align === "velocity") {
    const hasRot =
      (isObject(v.overLifetime) && v.overLifetime.rotation !== null && v.overLifetime.rotation !== undefined) ||
      (isObject(v.bySpeed) && v.bySpeed.rotation !== null && v.bySpeed.rotation !== undefined);
    if (hasRot)
      warn(ctx, `${path}.render.align`, "align:\"velocity\" overrides rotation from other modules");
  }
  // E21: burstSpread arc mode needs discrete bursts; with continuous emission it
  // falls back to random.
  if (isObject(v.shape) && v.shape.arcMode === "burstSpread" && ctx.layerContinuous.get(selfId) === true)
    warn(ctx, `${path}.shape.arcMode`, "burstSpread arc mode falls back to random for continuous emission (E21)");
}

// A layer emits continuously unless its rateOverTime is a constant 0.
function emitsContinuously(emission: unknown): boolean {
  if (!isObject(emission)) return false;
  const rot = emission.rateOverTime;
  if (!isObject(rot)) return false;
  if (rot.mode === "constant") return isNum(rot.value) && (rot.value as number) > 0;
  return true; // range/curve — treat as potentially emitting
}

export function validateParticle(input: unknown): ValidationResult {
  const ctx: Ctx = {
    errors: [],
    warnings: [],
    textureNames: new Set(),
    duration: 0,
    looping: false,
    layerIds: new Set(),
    layerSubEmittersNull: new Map(),
    layerContinuous: new Map(),
    paramNames: new Set(),
    paramKinds: new Map(),
  };

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
  // E44: each value must be an embedded base64 image data URL — a .prt file is
  // self-contained (FORMAT_SPEC "Texture handling") and the Pixi adapter decodes
  // the payload directly (no fetch), so a remote URL or any other string shape
  // could never load anyway; reject it here with a clear path instead.
  if (input.textures !== undefined) {
    if (!isObject(input.textures)) {
      err(ctx, "textures", "textures must be an object of name -> data URL");
    } else {
      for (const [name, url] of Object.entries(input.textures)) {
        ctx.textureNames.add(name);
        if (!isStr(url)) err(ctx, `textures.${name}`, "texture data must be a string");
        else if (!IMAGE_DATA_URL_RE.test(url))
          err(ctx, `textures.${name}`, "texture data must be a base64 image data URL (data:image/...;base64,...) (E44)");
      }
    }
  }

  // params (schemaVersion 6, A9; kind-discriminated in schemaVersion 8). Optional at
  // the wire level (migration injects `[]`; hand-built/pre-migration docs may omit
  // it — tolerated like other new fields). When present it must be an array of
  // `{ kind, name, ... }`. Names + kinds are collected into ctx BEFORE layers so
  // the per-knob binding checks (E32/E34) can resolve them.
  // E33 (schemaVersion 8, COLOR_PARAM_PLAN C6): `kind` present and ∈ {"scalar",
  //   "color"}. A scalar entry keeps the E31 numeric rules (finite default/min/max,
  //   min <= max, default in [min,max]). A color entry needs `default` an RGBA
  //   object with finite channels in [0,1] and must NOT carry min/max.
  // E31: name not a non-empty string; duplicate names; (scalar) non-finite
  //   default/min/max, min > max, default outside [min, max].
  if (input.params !== undefined) {
    if (!Array.isArray(input.params)) {
      err(ctx, "params", "params must be an array");
    } else {
      input.params.forEach((p, i) => {
        const pp = `params[${i}]`;
        if (!isObject(p)) {
          err(ctx, pp, "param must be an object");
          return;
        }
        if (!isStr(p.name) || p.name.length === 0) {
          err(ctx, `${pp}.name`, "param name must be a non-empty string (E31)");
        } else if (ctx.paramNames.has(p.name)) {
          err(ctx, `${pp}.name`, `duplicate param name "${p.name}" (E31)`);
        } else {
          ctx.paramNames.add(p.name);
          if (p.kind === "scalar" || p.kind === "color") ctx.paramKinds.set(p.name, p.kind);
        }
        // E33: kind discriminant.
        if (p.kind !== "scalar" && p.kind !== "color") {
          err(ctx, `${pp}.kind`, 'param kind must be "scalar" or "color" (E33)');
          return; // no sound way to check the value shape without a kind
        }
        if (p.kind === "color") {
          // Color: default an RGBA object with finite channels in [0,1]; no min/max.
          if (!isObject(p.default)) {
            err(ctx, `${pp}.default`, "color param default must be an {r,g,b,a} object (E33)");
          } else {
            for (const ch of ["r", "g", "b", "a"] as const) {
              if (checkNumber(ctx, p.default[ch], `${pp}.default.${ch}`) && ((p.default[ch] as number) < 0 || (p.default[ch] as number) > 1))
                err(ctx, `${pp}.default.${ch}`, `${ch} must be in [0,1] (E33)`);
            }
          }
          if (p.min !== undefined) err(ctx, `${pp}.min`, "color param must not carry min (channels are [0,1]) (E33)");
          if (p.max !== undefined) err(ctx, `${pp}.max`, "color param must not carry max (channels are [0,1]) (E33)");
        } else {
          // Scalar: the E31 numeric rules.
          const okDef = isNum(p.default);
          const okMin = isNum(p.min);
          const okMax = isNum(p.max);
          if (!okDef) err(ctx, `${pp}.default`, "param default must be a finite number (E31)");
          if (!okMin) err(ctx, `${pp}.min`, "param min must be a finite number (E31)");
          if (!okMax) err(ctx, `${pp}.max`, "param max must be a finite number (E31)");
          if (okMin && okMax && (p.min as number) > (p.max as number))
            err(ctx, pp, "param min must be <= max (E31)");
          if (okDef && okMin && okMax && ((p.default as number) < (p.min as number) || (p.default as number) > (p.max as number)))
            err(ctx, `${pp}.default`, "param default must be within [min, max] (E31)");
        }
      });
    }
  }

  // layers (E14: 0 is valid; max 8 — schemaVersion 3 raised the cap from 4 to
  // fit sub-emitter children). A first pass registers ids + sub-emitter/emission
  // status so cross-layer reference checks (checkSubEmitters) can resolve.
  if (!Array.isArray(input.layers)) {
    err(ctx, "layers", "layers must be an array");
  } else {
    if (input.layers.length > 8) err(ctx, "layers", "a document may have at most 8 layers");
    input.layers.forEach((l, i) => {
      if (isObject(l) && isStr(l.id)) {
        // Duplicate ids are rejected: sub-emitter references resolve by id, so a
        // collision would make the depth-1 check (and the runtime lookup) pick an
        // arbitrary layer.
        if (ctx.layerIds.has(l.id)) err(ctx, `layers[${i}].id`, `duplicate layer id "${l.id}"`);
        ctx.layerIds.add(l.id);
        ctx.layerSubEmittersNull.set(l.id, l.subEmitters === null || l.subEmitters === undefined);
        ctx.layerContinuous.set(l.id, emitsContinuously(l.emission));
      }
    });
    input.layers.forEach((l, i) => checkLayer(ctx, l, `layers[${i}]`));
  }

  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  return { ok: true, doc: input as unknown as ParticleDoc, warnings: ctx.warnings };
}
