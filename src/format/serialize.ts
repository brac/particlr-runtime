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
    // randomBetweenCurves (schemaVersion 5): two curve-key arrays a/b.
    if (o.mode === "randomBetweenCurves") {
      const t = orderKeys(o, ["mode", "a", "b"]);
      for (const key of ["a", "b"] as const) {
        if (Array.isArray(t[key])) t[key] = (t[key] as unknown[]).map((k) => map(k, (kk) => orderKeys(kk, ["t", "v", "ease"])));
      }
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
  circle: ["kind", "radius", "innerRadius", "arc", "arcMode", "arcSpeed", "emitFrom"],
  cone: ["kind", "direction", "spread", "radius", "arcMode", "arcSpeed", "emitFrom"],
  rect: ["kind", "width", "height", "emitFrom"],
  edge: ["kind", "length", "emitFrom"],
  // schemaVersion 10: points list first, then the closed/direction flags.
  polyline: ["kind", "points", "closed", "direction", "emitFrom"],
  // schemaVersion 4: mask blob last, human-legible header first.
  texture: ["kind", "width", "height", "threshold", "mask", "emitFrom"],
};

// --- schemaVersion 3 feature-module canonicalizers -------------------------
const cNoise = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        const n = orderKeys(o, ["strength", "frequency", "scrollSpeed", "octaves"]);
        n.strength = cTrack(n.strength);
        return n;
      });

const cRender = (v: unknown): unknown =>
  v === null ? null : map(v, (o) => orderKeys(o, ["align", "speedScale", "minStretch", "maxStretch"]));

const cBySpeed = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        const b = orderKeys(o, ["range", "size", "color", "rotation"]);
        b.range = map(b.range, (rg) => orderKeys(rg, ["min", "max"]));
        b.size = cTrackOrNull(b.size);
        b.color = b.color === null ? null : cGradient(b.color);
        b.rotation = cTrackOrNull(b.rotation);
        return b;
      });

const cStartColor = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        if (o.mode === "palette") {
          const s = orderKeys(o, ["mode", "colors"]);
          if (Array.isArray(s.colors)) s.colors = s.colors.map((c) => map(c, (cc) => orderKeys(cc, ["r", "g", "b", "a"])));
          return s;
        }
        // hueJitter (schemaVersion 5): a scalar degrees field, no nested objects.
        if (o.mode === "hueJitter") return orderKeys(o, ["mode", "degrees"]);
        const s = orderKeys(o, ["mode", "a", "b"]);
        s.a = cGradient(s.a);
        s.b = cGradient(s.b);
        return s;
      });

const cRandomFlip = (v: unknown): unknown => (v === null ? null : map(v, (o) => orderKeys(o, ["x", "y"])));

const COLLISION_SHAPE_ORDER: Record<string, readonly string[]> = {
  floor: ["kind", "y"],
  rect: ["kind", "x", "y", "width", "height"],
};
const cCollision = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        // schemaVersion 10: killOnCollide + minKillSpeed append after lifetimeLoss.
        const c = orderKeys(o, ["shape", "bounce", "dampen", "lifetimeLoss", "killOnCollide", "minKillSpeed"]);
        c.shape = map(c.shape, (s) => orderKeys(s, COLLISION_SHAPE_ORDER[String(s.kind)] ?? ["kind"]));
        return c;
      });

// --- schemaVersion 10 feature-module canonicalizers ------------------------
const cWind = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        // schemaVersion 11 (WINDP P1): the two binding fields append after gustAmount.
        const w = orderKeys(o, ["direction", "strength", "gustFrequency", "gustAmount", "windStrengthParam", "windDirectionParam"]);
        w.strength = cTrack(w.strength);
        return w;
      });

const cByEmitterSpeed = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        const b = orderKeys(o, ["range", "size", "speed", "life"]);
        b.range = map(b.range, (rg) => orderKeys(rg, ["min", "max"]));
        b.size = cTrackOrNull(b.size);
        b.speed = cTrackOrNull(b.speed);
        b.life = cTrackOrNull(b.life);
        return b;
      });

const cKillZones = (v: unknown): unknown =>
  v === null || !Array.isArray(v)
    ? v
    : // schemaVersion 10: each rect ordered x, y, width, height.
      v.map((z) => map(z, (o) => orderKeys(o, ["x", "y", "width", "height"])));

const cSubEmitters = (v: unknown): unknown =>
  v === null || !Array.isArray(v)
    ? v
    : // schemaVersion 9 (RIBBON_INHERIT_PLAN I1): the three inherit flags order
      // directly after inheritVelocity.
      v.map((s) =>
        map(s, (o) =>
          orderKeys(o, [
            "trigger",
            "layerId",
            "count",
            "probability",
            "inheritVelocity",
            "inheritColor",
            "inheritSize",
            "inheritRotation",
          ]),
        ),
      );

const cTrail = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        // schemaVersion 9 (RIBBON_INHERIT_PLAN R1): mode is the FIRST key in trail.
        const t = orderKeys(o, ["mode", "maxPoints", "minVertexDistance", "width", "color"]);
        t.width = cTrack(t.width);
        t.color = t.color === null ? null : cGradient(t.color);
        return t;
      });

// --- schemaVersion 4 feature-module canonicalizers -------------------------
const cAttractor = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        const a = orderKeys(o, ["x", "y", "strength", "tangential", "radius", "falloff", "killRadius"]);
        a.strength = cTrack(a.strength);
        a.tangential = cTrackOrNull(a.tangential);
        return a;
      });

const cDissolve = (v: unknown): unknown =>
  v === null
    ? null
    : map(v, (o) => {
        const d = orderKeys(o, ["frequency", "scroll", "edgeWidth", "edgeColor"]);
        d.scroll = map(d.scroll, (s) => orderKeys(s, ["x", "y"]));
        d.edgeColor = d.edgeColor === null ? null : map(d.edgeColor, (c) => orderKeys(c, ["r", "g", "b", "a"]));
        return d;
      });

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
      "attractorInfluence",
      "initial",
      "overLifetime",
      "limitVelocity",
      "noise",
      // schemaVersion 10: wind groups with noise (field forces); byEmitterSpeed
      // directly after bySpeed.
      "wind",
      "bySpeed",
      "byEmitterSpeed",
      "startColor",
      "randomFlip",
      // schemaVersion 8 (COLOR_PARAM_PLAN C2): layer-level tint binding, directly
      // before opacity (the normative render-chain order: tint then opacity).
      "tintParam",
      // A9 (schemaVersion 6): layer-level opacity binding, beside the render block.
      "opacityParam",
      "render",
      "dissolve",
      "collision",
      // schemaVersion 10: killZones directly after collision.
      "killZones",
      "attractor",
      "subEmitters",
      "trail",
    ]);
    l.texture = map(l.texture, (t) => {
      const tx = orderKeys(t, ["ref", "frames"]);
      // schemaVersion 5: randomStartFrame + frameOverLife after mode; frameOverLife
      // is a nullable ScalarTrack.
      tx.frames = map(tx.frames, (f) => {
        const fb = orderKeys(f, ["cols", "rows", "fps", "mode", "randomStartFrame", "frameOverLife"]);
        if ("frameOverLife" in fb) fb.frameOverLife = cTrackOrNull(fb.frameOverLife);
        return fb;
      });
      return tx;
    });
    l.emission = map(l.emission, (e) => {
      // A9 (schemaVersion 6): each rate binding sits directly after its knob.
      const em = orderKeys(e, ["rateOverTime", "rateOverTimeParam", "rateOverDistance", "rateOverDistanceParam", "bursts", "delay", "prewarm", "maxParticles"]);
      em.rateOverTime = cTrack(em.rateOverTime);
      em.rateOverDistance = cTrackOrNull(em.rateOverDistance);
      if (Array.isArray(em.bursts))
        em.bursts = em.bursts.map((b) => map(b, (bb) => orderKeys(bb, ["time", "count", "spread", "cycles", "interval", "probability"])));
      return em;
    });
    l.shape = map(l.shape, (s) => {
      const so = orderKeys(s, SHAPE_ORDER[String(s.kind)] ?? ["kind", "emitFrom"]);
      // schemaVersion 4: order the nested texture mask (blob last).
      if (so.kind === "texture") so.mask = map(so.mask, (m) => orderKeys(m, ["width", "height", "data"]));
      // schemaVersion 10: order each polyline point entry (x before y).
      if (so.kind === "polyline" && Array.isArray(so.points))
        so.points = so.points.map((p) => map(p, (pp) => orderKeys(pp, ["x", "y"])));
      return so;
    });
    l.initial = map(l.initial, (init) => {
      // A9 (schemaVersion 6): life/speed/size bindings sit directly after their knob.
      const io = orderKeys(init, ["life", "lifeParam", "speed", "speedParam", "size", "sizeParam", "rotation", "angularVelocity"]);
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
        // A9 (schemaVersion 6): gravity binding sits directly after gravity.
        const vo = orderKeys(vel, ["gravity", "gravityParam", "drag", "speedMultiplier", "x", "y", "orbital", "radial"]);
        vo.gravity = map(vo.gravity, (g) => orderKeys(g, ["x", "y"]));
        vo.drag = cTrackOrNull(vo.drag);
        vo.speedMultiplier = cTrackOrNull(vo.speedMultiplier);
        for (const key of ["x", "y", "orbital", "radial"]) {
          if (key in vo) vo[key] = cTrackOrNull(vo[key]);
        }
        return vo;
      });
      return olo;
    });
    // schemaVersion 5: A4 limit-velocity (nullable ScalarTrack), after overLifetime.
    l.limitVelocity = cTrackOrNull(l.limitVelocity);
    // schemaVersion 3 feature modules (each null = off).
    l.noise = cNoise(l.noise);
    // schemaVersion 10 field forces / spawn-multiply (each null = off).
    l.wind = cWind(l.wind);
    l.bySpeed = cBySpeed(l.bySpeed);
    l.byEmitterSpeed = cByEmitterSpeed(l.byEmitterSpeed);
    l.startColor = cStartColor(l.startColor);
    l.randomFlip = cRandomFlip(l.randomFlip);
    l.render = cRender(l.render);
    l.dissolve = cDissolve(l.dissolve);
    l.collision = cCollision(l.collision);
    // schemaVersion 10 death regions (null = none).
    l.killZones = cKillZones(l.killZones);
    l.attractor = cAttractor(l.attractor);
    l.subEmitters = cSubEmitters(l.subEmitters);
    l.trail = cTrail(l.trail);
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
    // A9 (schemaVersion 6): effect-scoped params, after seed (like duration/seed).
    "params",
    "textures",
    "layers",
  ]);
  d.meta = map(d.meta, (m) => orderKeys(m, ["name", "createdWith", "notes"]));
  // Each param object orders kind, name, default, min, max (schemaVersion 8;
  // min/max are simply absent on a color entry). A color `default` is an RGBA
  // object ordered r, g, b, a (match the gradient-key channel order); a scalar
  // `default` is a plain number, left untouched.
  if (Array.isArray(d.params))
    d.params = d.params.map((p) =>
      map(p, (o) => {
        const po = orderKeys(o, ["kind", "name", "default", "min", "max"]);
        if (po.kind === "color") po.default = map(po.default, (c) => orderKeys(c, ["r", "g", "b", "a"]));
        return po;
      }),
    );
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
