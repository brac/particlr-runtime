import { describe, it, expect } from "vitest";
import { Effect, type ParticleDoc, type Layer, type ParamDef } from "../../src/index.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

// A9 (schemaVersion 6) — runtime host API (setParam/getParam) + the seven
// application sites. The load-bearing invariant is bit-identity: a doc that
// declares params + bindings but leaves every param at value 1 (or is never
// touched) is byte-identical to the same doc with no params and null bindings.

const P = (over: Partial<ParamDef> = {}): ParamDef => ({ name: "k", default: 1, min: 0, max: 4, ...over });

// ── Render-buffer capture ────────────────────────────────────────────────────
// stateHash folds ONLY pool columns (see _statehash.ts) — it never sees the
// render buffers, so `size`/`opacity` (both render-path) are invisible to it.
// These two helpers compare the render path directly, bitwise (toEqual on the
// raw Float32 values).
function renderVals(fx: Effect): number[] {
  const out: number[] = [];
  for (const ls of fx.layers) {
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    const c = ls.count;
    for (let i = 0; i < c; i++) out.push(buf.size[i]!, buf.r[i]!, buf.g[i]!, buf.b[i]!, buf.a[i]!);
  }
  return out;
}

// ── Docs ─────────────────────────────────────────────────────────────────────
// A world-space layer that exercises ALL seven sites: continuous rate,
// rate-over-distance (needs a moving emitter), bursts, initial speed/life/size,
// gravity (x and y), an over-life size curve, and an over-life color gradient.
// `bind` = the param name to wire into all seven binding fields, or null for the
// fully-unbound (v5) control.
function allSitesLayer(bind: string | null): Layer {
  return makeLayer({
    space: "world",
    emission: {
      rateOverTime: { mode: "constant", value: 40 },
      rateOverTimeParam: bind,
      rateOverDistance: { mode: "constant", value: 0.5 },
      rateOverDistanceParam: bind,
      bursts: [{ time: 0, count: 8, spread: 0.1, cycles: 1, interval: 0, probability: 1 }],
      delay: 0,
      prewarm: false,
      maxParticles: 4000,
    },
    initial: {
      life: { mode: "range", min: 0.5, max: 1.2 },
      lifeParam: bind,
      speed: { mode: "range", min: 30, max: 90 },
      speedParam: bind,
      size: { mode: "constant", value: 8 },
      sizeParam: bind,
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: { mode: "curve", keys: [{ t: 0, v: 1, ease: "easeOut" }, { t: 1, v: 0.2 }] },
      color: { keys: [{ t: 0, r: 1, g: 0.8, b: 0.3, a: 1 }, { t: 1, r: 1, g: 0.1, b: 0, a: 0.4 }] },
      rotation: null,
      velocity: {
        gravity: { x: 5, y: 40 },
        gravityParam: bind,
        drag: null,
        speedMultiplier: null,
        x: null,
        y: null,
        orbital: null,
        radial: null,
      },
    },
    opacityParam: bind,
  });
}
function allSitesDoc(bind: string | null, params: ParamDef[]): ParticleDoc {
  return makeDoc({ layers: [allSitesLayer(bind)], params, looping: false, duration: 30 });
}

// Drive an effect with a moving emitter (so world-space spawns + rate-over-
// distance are exercised) along a fixed, deterministic path.
function driveStep(fx: Effect, i: number, dt: number): void {
  fx.setEmitterPosition(10 + i * 4, i * 2);
  fx.step(dt);
}

describe("A9 — no-op law (bitwise gate)", () => {
  it("bound doc, all params at default 1, never touched ≡ unbound doc (stateHash AND render)", () => {
    const a = new Effect(allSitesDoc("k", [P()]), { seed: 7 });
    const b = new Effect(allSitesDoc(null, []), { seed: 7 });
    const seq = dtSequence(11, 70);
    const checkpoints = new Set([9, 29, 49, 69]);
    seq.forEach((dt, i) => {
      driveStep(a, i, dt);
      driveStep(b, i, dt);
      if (checkpoints.has(i)) {
        expect(stateHash(a)).toBe(stateHash(b));
        expect(renderVals(a)).toEqual(renderVals(b));
      }
    });
  });

  it("setParam to a non-1 value then back to exactly 1 in the same step ≡ unbound (last-call-wins = identity)", () => {
    const a = new Effect(allSitesDoc("k", [P()]), { seed: 7 });
    const b = new Effect(allSitesDoc(null, []), { seed: 7 });
    const seq = dtSequence(11, 70);
    const checkpoints = new Set([9, 29, 49, 69]);
    seq.forEach((dt, i) => {
      a.setParam("k", 2.5); // diverge…
      a.setParam("k", 1); // …then back to exactly 1 before the step (last wins)
      driveStep(a, i, dt);
      driveStep(b, i, dt);
      if (checkpoints.has(i)) {
        expect(stateHash(a)).toBe(stateHash(b));
        expect(renderVals(a)).toEqual(renderVals(b));
      }
    });
  });
});

describe("A9 — zero-draw proof (draw-heavy doc)", () => {
  it("bound-at-1 ≡ unbound across a run with bursts + noise + startColor (draw stream untouched)", () => {
    // noise (draw 14) + startColor gradients (draw 19) make the spawn stream
    // draw-heavy; identical stateHash proves the seven param sites perturb no draw.
    const heavy = (bind: string | null): Layer =>
      makeLayer({
        space: "world",
        noise: { strength: { mode: "constant", value: 30 }, frequency: 1.2, scrollSpeed: 0.6, octaves: 2 },
        startColor: {
          mode: "gradients",
          a: { keys: [{ t: 0, r: 1, g: 0.5, b: 0.2, a: 1 }, { t: 1, r: 0.9, g: 0.2, b: 0.1, a: 1 }] },
          b: { keys: [{ t: 0, r: 0.2, g: 0.5, b: 1, a: 1 }, { t: 1, r: 0.1, g: 0.2, b: 0.9, a: 1 }] },
        },
        emission: {
          rateOverTime: { mode: "constant", value: 50 },
          rateOverTimeParam: bind,
          rateOverDistance: { mode: "constant", value: 0.3 },
          rateOverDistanceParam: bind,
          bursts: [{ time: 0, count: 12, spread: 0.2, cycles: 1, interval: 0, probability: 1 }],
          delay: 0,
          prewarm: false,
          maxParticles: 4000,
        },
        initial: {
          life: { mode: "range", min: 0.6, max: 1.4 },
          lifeParam: bind,
          speed: { mode: "range", min: 40, max: 100 },
          speedParam: bind,
          size: { mode: "range", min: 6, max: 12 },
          sizeParam: bind,
          rotation: { mode: "constant", value: 0 },
          angularVelocity: { mode: "constant", value: 0 },
        },
        overLifetime: {
          size: { mode: "curve", keys: [{ t: 0, v: 1 }, { t: 1, v: 0.3 }] },
          color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }, { t: 1, r: 1, g: 1, b: 1, a: 0 }] },
          rotation: null,
          velocity: { gravity: { x: 8, y: 30 }, gravityParam: bind, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
        },
        opacityParam: bind,
      });
    const a = new Effect(makeDoc({ layers: [heavy("k")], params: [P()], looping: false, duration: 30 }), { seed: 21 });
    const b = new Effect(makeDoc({ layers: [heavy(null)], params: [], looping: false, duration: 30 }), { seed: 21 });
    const seq = dtSequence(3, 60);
    seq.forEach((dt, i) => {
      driveStep(a, i, dt);
      driveStep(b, i, dt);
      if (i % 15 === 14) expect(stateHash(a)).toBe(stateHash(b));
    });
  });
});

// ── Constant-mode equivalence (bitwise, per binding) ─────────────────────────
// A minimal local-space layer whose bindable knobs are ALL constant-mode, so
// `setParam(v)` is bitwise-equivalent to an edited doc whose constant is
// pre-multiplied by `v`.
function baseLayer(): Layer {
  return makeLayer({
    space: "local",
    emission: {
      rateOverTime: { mode: "constant", value: 30 },
      rateOverTimeParam: null,
      rateOverDistance: null,
      rateOverDistanceParam: null,
      bursts: [],
      delay: 0,
      prewarm: false,
      maxParticles: 6000,
    },
    initial: {
      life: { mode: "constant", value: 2 },
      lifeParam: null,
      speed: { mode: "constant", value: 50 },
      speedParam: null,
      size: { mode: "constant", value: 8 },
      sizeParam: null,
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: { mode: "curve", keys: [{ t: 0, v: 1 }, { t: 1, v: 0.5 }] },
      color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }, { t: 1, r: 1, g: 1, b: 1, a: 1 }] }, // flat alpha (for opacity)
      rotation: null,
      velocity: { gravity: { x: 3, y: 20 }, gravityParam: null, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
  });
}

describe("A9 — constant-mode equivalence (bitwise, per binding)", () => {
  const V = 1.7;
  const seq = dtSequence(44, 50);

  // Sim-path bindings (rate, speed, life, gravity) — compare stateHash.
  it("rateOverTime: setParam(v) ≡ pre-multiplied constant (stateHash)", () => {
    const bl = baseLayer();
    bl.emission.rateOverTimeParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P()], looping: false, duration: 60 }), { seed: 5 });
    bound.setParam("k", V);
    const el = baseLayer();
    el.emission.rateOverTime = { mode: "constant", value: 30 * V };
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 5 });
    seq.forEach((dt) => {
      bound.step(dt);
      edit.step(dt);
    });
    expect(stateHash(bound)).toBe(stateHash(edit));
  });

  it("rateOverDistance: setParam(v) ≡ pre-multiplied constant (stateHash)", () => {
    const bl = baseLayer();
    bl.space = "world";
    bl.emission.rateOverTime = { mode: "constant", value: 0 };
    bl.emission.rateOverDistance = { mode: "constant", value: 0.5 };
    bl.emission.rateOverDistanceParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P()], looping: false, duration: 60 }), { seed: 5 });
    bound.setParam("k", V);
    const el = baseLayer();
    el.space = "world";
    el.emission.rateOverTime = { mode: "constant", value: 0 };
    el.emission.rateOverDistance = { mode: "constant", value: 0.5 * V };
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 5 });
    seq.forEach((dt, i) => {
      driveStep(bound, i, dt);
      driveStep(edit, i, dt);
    });
    expect(stateHash(bound)).toBe(stateHash(edit));
  });

  it("speed: setParam(v) ≡ pre-multiplied constant (stateHash)", () => {
    const bl = baseLayer();
    bl.initial.speedParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P()], looping: false, duration: 60 }), { seed: 5 });
    bound.setParam("k", V);
    const el = baseLayer();
    el.initial.speed = { mode: "constant", value: 50 * V };
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 5 });
    seq.forEach((dt) => {
      bound.step(dt);
      edit.step(dt);
    });
    expect(stateHash(bound)).toBe(stateHash(edit));
  });

  it("life: setParam(v) ≡ pre-multiplied constant (stateHash)", () => {
    const bl = baseLayer();
    bl.initial.lifeParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P()], looping: false, duration: 60 }), { seed: 5 });
    bound.setParam("k", V);
    const el = baseLayer();
    el.initial.life = { mode: "constant", value: 2 * V };
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 5 });
    seq.forEach((dt) => {
      bound.step(dt);
      edit.step(dt);
    });
    expect(stateHash(bound)).toBe(stateHash(edit));
  });

  it("gravity: setParam(v) ≡ pre-multiplied constant (stateHash)", () => {
    const bl = baseLayer();
    bl.overLifetime.velocity.gravityParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P()], looping: false, duration: 60 }), { seed: 5 });
    bound.setParam("k", V);
    const el = baseLayer();
    el.overLifetime.velocity.gravity = { x: 3 * V, y: 20 * V };
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 5 });
    seq.forEach((dt) => {
      bound.step(dt);
      edit.step(dt);
    });
    expect(stateHash(bound)).toBe(stateHash(edit));
  });

  // Render-path bindings (size, opacity) — compare render buffers (invisible to
  // stateHash).
  it("size: setParam(v) ≡ pre-multiplied initial.size constant (render buffers)", () => {
    // `sizeInit` round-trips through a Float32Array, so the bound path (read f32
    // 8, ×v at render in f64) only matches the edited path (store 8·v as f32,
    // read back) BITWISE when 8·v is f32-exact. `v = 2` (⇒ 16, a power of two) is;
    // an arbitrary factor like 1.7 would round at a different point (an epsilon
    // difference, not a bug — the render multiply is f32-storage-bounded).
    const SV = 2;
    const bl = baseLayer();
    bl.initial.sizeParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P()], looping: false, duration: 60 }), { seed: 5 });
    bound.setParam("k", SV);
    const el = baseLayer();
    el.initial.size = { mode: "constant", value: 8 * SV };
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 5 });
    seq.forEach((dt) => {
      bound.step(dt);
      edit.step(dt);
    });
    expect(bound.particleCount).toBeGreaterThan(0);
    expect(renderVals(bound)).toEqual(renderVals(edit));
  });

  it("opacity: setParam(v) ≡ flat color-gradient alpha pre-multiplied (render buffers)", () => {
    const OV = 0.6;
    const bl = baseLayer();
    bl.opacityParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P()], looping: false, duration: 60 }), { seed: 5 });
    bound.setParam("k", OV);
    const el = baseLayer();
    // Flat alpha (both keys equal) ⇒ evalGradient returns the flat value bitwise,
    // so pre-multiplying it matches the final buf.a multiply exactly.
    el.overLifetime.color = { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 * OV }, { t: 1, r: 1, g: 1, b: 1, a: 1 * OV }] };
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 5 });
    seq.forEach((dt) => {
      bound.step(dt);
      edit.step(dt);
    });
    expect(bound.particleCount).toBeGreaterThan(0);
    expect(renderVals(bound)).toEqual(renderVals(edit));
  });
});

describe("A9 — non-constant epsilon law (curve-mode rate)", () => {
  it("setParam(0.5) on a curve rate ≈ (not bitwise) a doc with pre-scaled curve keys", () => {
    const curve = (scale: number) => ({
      mode: "curve" as const,
      keys: [
        { t: 0, v: 60 * scale },
        { t: 0.5, v: 20 * scale, ease: "easeInOut" as const },
        { t: 1, v: 45 * scale },
      ],
    });
    const bl = baseLayer();
    bl.emission.rateOverTime = curve(1);
    bl.emission.rateOverTimeParam = "k";
    const bound = new Effect(makeDoc({ layers: [bl], params: [P({ min: 0, max: 1 })], looping: false, duration: 60 }), { seed: 9 });
    bound.setParam("k", 0.5);
    const el = baseLayer();
    el.emission.rateOverTime = curve(0.5); // keys pre-scaled by 0.5
    const edit = new Effect(makeDoc({ layers: [el], params: [], looping: false, duration: 60 }), { seed: 9 });
    for (const dt of dtSequence(2, 80)) {
      bound.step(dt);
      edit.step(dt);
    }
    // Closeness, NOT bitwise: IEEE multiply does not distribute over evalCurve's
    // lerp, so the emitted counts track within a particle or two.
    expect(Math.abs(bound.particleCount - edit.particleCount)).toBeLessThanOrEqual(2);
    expect(bound.particleCount).toBeGreaterThan(20);
  });
});

describe("A9 — live vs future-spawn semantics", () => {
  // A no-continuous, no-force layer so an already-alive particle's velocity is
  // frozen after spawn (no gravity, no drag) and pool indices are stable (long
  // life ⇒ no deaths reorder the pool).
  function spawnOnceLayer(bind: string | null): Layer {
    const l = baseLayer();
    l.emission.rateOverTime = { mode: "constant", value: 200 };
    l.emission.rateOverTimeParam = null;
    l.initial.life = { mode: "constant", value: 100 };
    l.initial.speed = { mode: "constant", value: 50 };
    l.initial.speedParam = bind;
    l.initial.size = { mode: "constant", value: 8 };
    l.overLifetime.velocity.gravity = { x: 0, y: 0 };
    return l;
  }

  it("speed change affects only NEW spawns; already-alive particles keep their velocity", () => {
    const l = spawnOnceLayer("k");
    l.initial.speedParam = "k";
    const fx = new Effect(makeDoc({ layers: [l], params: [P({ max: 4 })], looping: false, duration: 100 }), { seed: 3 });
    for (let i = 0; i < 5; i++) fx.step(1 / 60); // populate
    const ls = fx.layers[0]!;
    const before = ls.count;
    const vx0 = Array.from(ls.pool.velX.slice(0, before));
    const vy0 = Array.from(ls.pool.velY.slice(0, before));
    fx.setParam("k", 2);
    fx.step(1 / 60);
    // Already-alive particles (indices [0, before)) are untouched…
    expect(Array.from(ls.pool.velX.slice(0, before))).toEqual(vx0);
    expect(Array.from(ls.pool.velY.slice(0, before))).toEqual(vy0);
    // …and the new spawns launched at 2× speed (√(vx²+vy²) ≈ 100, not 50).
    const speedNew = Math.hypot(ls.pool.velX[before]!, ls.pool.velY[before]!);
    expect(speedNew).toBeCloseTo(100, 4);
  });

  it("life change affects only NEW spawns; already-alive particles keep their lifetime", () => {
    const l = spawnOnceLayer(null);
    l.initial.lifeParam = "k";
    const fx = new Effect(makeDoc({ layers: [l], params: [P({ max: 4 })], looping: false, duration: 100 }), { seed: 3 });
    for (let i = 0; i < 5; i++) fx.step(1 / 60);
    const ls = fx.layers[0]!;
    const before = ls.count;
    const life0 = Array.from(ls.pool.lifetime.slice(0, before));
    fx.setParam("k", 3);
    fx.step(1 / 60);
    expect(Array.from(ls.pool.lifetime.slice(0, before))).toEqual(life0);
    expect(ls.pool.lifetime[before]!).toBeCloseTo(100 * 3, 4); // new spawn: tripled life
  });

  it("gravity change is LIVE: already-alive particles react on the next step", () => {
    const base = spawnOnceLayer(null);
    base.overLifetime.velocity.gravity = { x: 0, y: 30 };
    base.overLifetime.velocity.gravityParam = "k";
    const on = new Effect(makeDoc({ layers: [base], params: [P({ max: 4 })], looping: false, duration: 100 }), { seed: 3 });
    // Control: identical doc that never sets the param (gravity ×1).
    const off = new Effect(makeDoc({ layers: [base], params: [P({ max: 4 })], looping: false, duration: 100 }), { seed: 3 });
    for (let i = 0; i < 5; i++) {
      on.step(1 / 60);
      off.step(1 / 60);
    }
    on.setParam("k", 3); // triple gravity live
    on.step(1 / 60);
    off.step(1 / 60);
    // Already-alive particles felt the stronger gravity ⇒ larger downward velocity.
    expect(stateHash(on)).not.toBe(stateHash(off));
    expect(on.layers[0]!.pool.velY[0]!).toBeGreaterThan(off.layers[0]!.pool.velY[0]!);
  });

  it("size change is LIVE: already-alive particles re-render larger on the next render", () => {
    const l = spawnOnceLayer(null);
    l.initial.sizeParam = "k";
    const fx = new Effect(makeDoc({ layers: [l], params: [P({ max: 4 })], looping: false, duration: 100 }), { seed: 3 });
    for (let i = 0; i < 5; i++) fx.step(1 / 60);
    const ls = fx.layers[0]!;
    const buf0 = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf0);
    const size0 = buf0.size[0]!;
    fx.setParam("k", 2);
    fx.step(1 / 60); // Effect re-pushes the size mul this step
    const buf1 = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf1);
    // Same particle (index 0, alive throughout) renders ~2× the size (the over-
    // life sizeMul barely moved across one 1/60 step of a 100 s life).
    expect(buf1.size[0]! / size0).toBeCloseTo(2, 2);
  });

  it("opacity change is LIVE: already-alive particles re-render dimmer on the next render", () => {
    const l = spawnOnceLayer(null);
    l.opacityParam = "k";
    const fx = new Effect(makeDoc({ layers: [l], params: [P({ max: 4 })], looping: false, duration: 100 }), { seed: 3 });
    for (let i = 0; i < 5; i++) fx.step(1 / 60);
    const ls = fx.layers[0]!;
    const buf0 = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf0);
    const a0 = buf0.a[0]!;
    fx.setParam("k", 0.25);
    fx.step(1 / 60);
    const buf1 = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf1);
    expect(buf1.a[0]! / a0).toBeCloseTo(0.25, 3);
  });
});

describe("A9 — API contract", () => {
  const doc1 = () => allSitesDoc("k", [P({ default: 1, min: 0.5, max: 3 })]);

  it("default is honored before the first setParam", () => {
    const fx = new Effect(makeDoc({ layers: [allSitesLayer("k")], params: [P({ default: 1.5, min: 0, max: 3 })] }), { seed: 1 });
    expect(fx.getParam("k")).toBe(1.5);
  });

  it("setParam clamps into [min, max]", () => {
    const fx = new Effect(doc1(), { seed: 1 });
    fx.setParam("k", 100);
    expect(fx.getParam("k")).toBe(3); // clamped to max
    fx.setParam("k", -100);
    expect(fx.getParam("k")).toBe(0.5); // clamped to min
    fx.setParam("k", 2);
    expect(fx.getParam("k")).toBe(2); // in range, stored as-is
  });

  it("non-finite value is ignored (no-op)", () => {
    const fx = new Effect(doc1(), { seed: 1 });
    fx.setParam("k", 2);
    fx.setParam("k", NaN);
    expect(fx.getParam("k")).toBe(2);
    fx.setParam("k", Infinity);
    expect(fx.getParam("k")).toBe(2);
    fx.setParam("k", -Infinity);
    expect(fx.getParam("k")).toBe(2);
  });

  it("unknown name: setter is a silent no-op, getter returns NaN", () => {
    const fx = new Effect(doc1(), { seed: 1 });
    expect(() => fx.setParam("nope", 5)).not.toThrow();
    expect(fx.getParam("nope")).toBeNaN();
  });

  it("last-call-wins within a step", () => {
    const fx = new Effect(doc1(), { seed: 1 });
    fx.setParam("k", 2);
    fx.setParam("k", 3);
    expect(fx.getParam("k")).toBe(3);
  });

  it("param value persists across reset(seed) and the sim replays deterministically under it", () => {
    // Local-space layer bound on speed + gravity, no emitter movement — so the
    // replay depends only on (seed, dt sequence, param value) and reproduces
    // exactly. (A world-space doc would need the emitter re-teleported, since
    // reset() keeps the current position — the documented replay subtlety.)
    const bl = baseLayer();
    bl.initial.speedParam = "k";
    bl.overLifetime.velocity.gravityParam = "k";
    const fx = new Effect(makeDoc({ layers: [bl], params: [P({ max: 4 })], looping: false, duration: 60 }), { seed: 7 });
    fx.setParam("k", 2);
    const seq = dtSequence(31, 40);
    for (const dt of seq) fx.step(dt);
    const h1 = stateHash(fx);
    fx.reset(7);
    expect(fx.getParam("k")).toBe(2); // value survived reset
    for (const dt of seq) fx.step(dt);
    expect(stateHash(fx)).toBe(h1); // deterministic replay under the persisted param
  });

  it("duplicate param names (validator rejects via E31): runtime resolves last-wins", () => {
    // Constructed directly (bypassing the validator) to pin the documented ruling.
    const doc = allSitesDoc("k", [P({ default: 1, min: 0, max: 4 }), { name: "k", default: 3, min: 0, max: 5 }]);
    const fx = new Effect(doc, { seed: 1 });
    expect(fx.getParam("k")).toBe(3); // the later entry wins
  });

  it("reset() does NOT touch the param store (persistence, like timeScale)", () => {
    const fx = new Effect(doc1(), { seed: 1 });
    fx.setParam("k", 2.75);
    fx.reset();
    expect(fx.getParam("k")).toBe(2.75);
  });
});

describe("A9 — event-driven push (frame-live render knobs)", () => {
  // The multiplier push happens at construction and on every effective setParam —
  // NOT per step — so authored defaults are in force from the first frame and the
  // render-path knobs (size/opacity) are FRAME-live: visible in the very next
  // computeRenderState even while the effect is paused.

  it("authored default ≠ 1 is in force from construction, with no setParam ever called", () => {
    // opacity bound to a param whose authored default is 0.5; flat alpha-1
    // gradient (baseLayer), a t=0 burst so the first step spawns. The render must
    // show 0.5 × 1 = 0.5 without ANY setParam — the default IS the value.
    const bl = baseLayer();
    bl.opacityParam = "k";
    bl.emission.bursts = [{ time: 0, count: 5, spread: 0, cycles: 1, interval: 0, probability: 1 }];
    const fx = new Effect(
      makeDoc({ layers: [bl], params: [P({ default: 0.5, min: 0, max: 1 })], looping: false, duration: 60 }),
      { seed: 2 },
    );
    fx.step(1 / 60); // spawn only — never setParam
    const ls = fx.layers[0]!;
    expect(ls.count).toBeGreaterThan(0);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    for (let i = 0; i < ls.count; i++) expect(buf.a[i]).toBe(0.5); // 0.5 × flat alpha 1, exact
  });

  it("setParam during a timeScale = 0 hit-stop is FRAME-live: the next render reflects it, no step", () => {
    const bl = baseLayer();
    bl.opacityParam = "k";
    bl.emission.bursts = [{ time: 0, count: 5, spread: 0, cycles: 1, interval: 0, probability: 1 }];
    const fx = new Effect(makeDoc({ layers: [bl], params: [P({ min: 0, max: 1 })], looping: false, duration: 60 }), { seed: 2 });
    for (let i = 0; i < 5; i++) fx.step(1 / 60); // build live particles
    fx.timeScale = 0; // hit-stop: every subsequent step is a no-op
    fx.step(1 / 60); // proves frozen (E2 path) — no push could hide here
    fx.setParam("k", 0.2);
    // NO further step: render directly (the paused-preview / hit-stop-fade idiom).
    const ls = fx.layers[0]!;
    expect(ls.count).toBeGreaterThan(0);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    // 0.2 × flat alpha 1; buf.a is a Float32Array, so compare against the f32
    // representation of 0.2 (0.5 above is f32-exact; 0.2 is not).
    for (let i = 0; i < ls.count; i++) expect(buf.a[i]).toBe(Math.fround(0.2));
  });

  it("setParam before the first step (prewarm: false): the first step's spawns already use the new value", () => {
    const bl = baseLayer();
    bl.initial.speedParam = "k";
    bl.emission.bursts = [{ time: 0, count: 5, spread: 0, cycles: 1, interval: 0, probability: 1 }];
    const fx = new Effect(makeDoc({ layers: [bl], params: [P({ max: 4 })], looping: false, duration: 60 }), { seed: 2 });
    fx.setParam("k", 2); // before ANY step — the push happens at setParam, not at step
    fx.step(1 / 60);
    const ls = fx.layers[0]!;
    expect(ls.count).toBeGreaterThan(0);
    // Spawn velocity = (speed × 2) in the drawn direction; gravity has not been
    // applied to a spawn-step particle yet (update runs before emit), so the
    // magnitude is exactly 2 × 50 = 100.
    for (let i = 0; i < ls.count; i++) {
      expect(Math.hypot(ls.pool.velX[i]!, ls.pool.velY[i]!)).toBeCloseTo(100, 4);
    }
  });
});
