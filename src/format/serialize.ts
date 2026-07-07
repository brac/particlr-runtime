// Canonical .prt serializer (plan §2.10). Emits JSON with:
//  - known keys in the order the TypeScript interfaces declare them,
//  - unknown/preserved keys appended after the known ones, in original order,
//  - 2-space indent, \n line endings, trailing newline.
// serializeParticle(parseParticle(text)) === text byte-for-byte for canonical inputs.

import type { ParticleDoc } from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Reorder an object's keys: `order` first (when present and not undefined),
// then any remaining (unknown) keys in their existing insertion order.
function orderKeys(obj: Obj, order: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of order) {
    if (k in obj && obj[k] !== undefined) out[k] = obj[k];
  }
  for (const k of Object.keys(obj)) {
    if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

const map = (v: unknown, f: (o: Obj) => Obj): unknown => (isObj(v) ? f(v) : v);

function cInit(v: unknown): unknown {
  return map(v, (o) =>
    o.mode === "range" ? orderKeys(o, ["mode", "min", "max"]) : orderKeys(o, ["mode", "value"]),
  );
}

function cTrack(v: unknown): unknown {
  return map(v, (o) => {
    if (o.mode === "range") return orderKeys(o, ["mode", "min", "max"]);
    if (o.mode === "curve") {
      const t = orderKeys(o, ["mode", "keys"]);
      if (Array.isArray(t.keys)) t.keys = t.keys.map((k) => map(k, (kk) => orderKeys(kk, ["t", "v", "ease"])));
      return t;
    }
    return orderKeys(o, ["mode", "value"]);
  });
}

const cTrackOrNull = (v: unknown): unknown => (v === null ? null : cTrack(v));

function cGradient(v: unknown): unknown {
  return map(v, (o) => {
    const g = orderKeys(o, ["keys"]);
    if (Array.isArray(g.keys)) g.keys = g.keys.map((k) => map(k, (kk) => orderKeys(kk, ["t", "r", "g", "b", "a"])));
    return g;
  });
}

const SHAPE_ORDER: Record<string, readonly string[]> = {
  point: ["kind", "emitFrom"],
  circle: ["kind", "radius", "emitFrom"],
  cone: ["kind", "direction", "spread", "radius", "emitFrom"],
  rect: ["kind", "width", "height", "emitFrom"],
  edge: ["kind", "length", "emitFrom"],
};

function cLayer(v: unknown): unknown {
  return map(v, (o) => {
    const l = orderKeys(o, [
      "id",
      "name",
      "enabled",
      "blend",
      "texture",
      "emission",
      "shape",
      "space",
      "inheritVelocity",
      "initial",
      "overLifetime",
      "subEmitters",
      "trail",
    ]);
    l.texture = map(l.texture, (t) => {
      const tx = orderKeys(t, ["ref", "frames"]);
      tx.frames = map(tx.frames, (f) => orderKeys(f, ["cols", "rows", "fps", "mode"]));
      return tx;
    });
    l.emission = map(l.emission, (e) => {
      const em = orderKeys(e, ["rateOverTime", "rateOverDistance", "bursts", "delay", "prewarm", "maxParticles"]);
      em.rateOverTime = cTrack(em.rateOverTime);
      em.rateOverDistance = cTrackOrNull(em.rateOverDistance);
      if (Array.isArray(em.bursts)) em.bursts = em.bursts.map((b) => map(b, (bb) => orderKeys(bb, ["time", "count", "spread"])));
      return em;
    });
    l.shape = map(l.shape, (s) => orderKeys(s, SHAPE_ORDER[String(s.kind)] ?? ["kind", "emitFrom"]));
    l.initial = map(l.initial, (init) => {
      const io = orderKeys(init, ["life", "speed", "size", "rotation", "angularVelocity"]);
      for (const key of ["life", "speed", "size", "rotation", "angularVelocity"]) {
        if (key in io) io[key] = cInit(io[key]);
      }
      return io;
    });
    l.overLifetime = map(l.overLifetime, (ol) => {
      const olo = orderKeys(ol, ["size", "color", "rotation", "velocity"]);
      olo.size = cTrackOrNull(olo.size);
      olo.color = cGradient(olo.color);
      olo.rotation = cTrackOrNull(olo.rotation);
      olo.velocity = map(olo.velocity, (vel) => {
        const vo = orderKeys(vel, ["gravity", "drag", "speedMultiplier"]);
        vo.gravity = map(vo.gravity, (g) => orderKeys(g, ["x", "y"]));
        vo.drag = cTrackOrNull(vo.drag);
        vo.speedMultiplier = cTrackOrNull(vo.speedMultiplier);
        return vo;
      });
      return olo;
    });
    return l;
  });
}

function canonicalize(doc: ParticleDoc): Obj {
  const d = orderKeys(doc as unknown as Obj, [
    "schemaVersion",
    "meta",
    "duration",
    "looping",
    "seed",
    "textures",
    "layers",
  ]);
  d.meta = map(d.meta, (m) => orderKeys(m, ["name", "createdWith", "notes"]));
  // `textures` is a dynamic name->dataURL map: leave its key order untouched.
  if (Array.isArray(d.layers)) d.layers = d.layers.map(cLayer);
  return d;
}

const IND = "  ";
const pad = (depth: number): string => IND.repeat(depth);

function emit(v: unknown, depth: number): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number" || t === "boolean" || t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = v.map((it) => pad(depth + 1) + emit(it, depth + 1));
    return "[\n" + items.join(",\n") + "\n" + pad(depth) + "]";
  }
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (keys.length === 0) return "{}";
    const parts = keys.map((k) => pad(depth + 1) + JSON.stringify(k) + ": " + emit(v[k], depth + 1));
    return "{\n" + parts.join(",\n") + "\n" + pad(depth) + "}";
  }
  // undefined / function / symbol — not representable; emit null defensively.
  return "null";
}

export function serializeParticle(doc: ParticleDoc): string {
  return emit(canonicalize(doc), 0) + "\n";
}
