import { describe, it, expect } from "vitest";
import { Effect, type ParticleDoc, type Layer, type ColorParamDef, type ScalarParamDef, type RGBAColor } from "../../src/index.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

// COLOR params (schemaVersion 8, COLOR_PARAM_PLAN) — the runtime color store +
// typed setters + the layer-level tint render site. Load-bearing invariants:
// tint is a RENDER-only multiply on the finished color chain (never a PRNG draw,
// never a pool column, never in the statehash — C4); an unbound tint takes the
// untouched pre-v8 path; a tint at {1,1,1,1} multiplies by IEEE-exact 1.0.
//
// f32 caveat (mirrors the A9 size test): buf.{r,g,b,a} are Float32Array. A
// channel comparison "bound == unbound × factor" is bitwise ONLY when the factor
// is a power of two (0.5/0.25/1 …) — rounding is invariant under scaling by a
// power of two, so we use those factors wherever bitwise equality is asserted.

const CP = (over: Partial<ColorParamDef> = {}): ColorParamDef => ({
  kind: "color",
  name: "tint",
  default: { r: 1, g: 1, b: 1, a: 1 },
  ...over,
});
const SP = (over: Partial<ScalarParamDef> = {}): ScalarParamDef => ({ kind: "scalar", name: "op", default: 1, min: 0, max: 4, ...over });

// A stable local layer: a t=0 burst (spawns on the first step), long life + no
// gravity (pool indices never reorder), and a non-trivial over-life color
// gradient so the tint multiply is observable on every channel. `tint` = the
// color-param name to wire into `tintParam`, or null for the unbound control.
function tintLayer(tint: string | null): Layer {
  return makeLayer({
    space: "local",
    emission: {
      rateOverTime: { mode: "constant", value: 0 },
      rateOverTimeParam: null,
      rateOverDistance: null,
      rateOverDistanceParam: null,
      bursts: [{ time: 0, count: 20, spread: 0, cycles: 1, interval: 0, probability: 1 }],
      delay: 0,
      prewarm: false,
      maxParticles: 256,
    },
    initial: {
      life: { mode: "constant", value: 100 },
      lifeParam: null,
      speed: { mode: "constant", value: 30 },
      speedParam: null,
      size: { mode: "constant", value: 8 },
      sizeParam: null,
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: { mode: "curve", keys: [{ t: 0, v: 1 }, { t: 1, v: 0.5 }] },
      color: { keys: [{ t: 0, r: 0.8, g: 0.6, b: 0.4, a: 1 }, { t: 1, r: 0.5, g: 0.3, b: 0.2, a: 0.6 }] },
      rotation: null,
      velocity: { gravity: { x: 0, y: 0 }, gravityParam: null, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
    tintParam: tint,
  });
}

function tintDoc(tint: string | null, params: (ColorParamDef | ScalarParamDef)[]): ParticleDoc {
  return makeDoc({ layers: [tintLayer(tint)], params, looping: false, duration: 100 });
}

function renderChannels(fx: Effect): { size: number; r: number; g: number; b: number; a: number }[] {
  const out: { size: number; r: number; g: number; b: number; a: number }[] = [];
  for (const ls of fx.layers) {
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    for (let i = 0; i < ls.count; i++) out.push({ size: buf.size[i]!, r: buf.r[i]!, g: buf.g[i]!, b: buf.b[i]!, a: buf.a[i]! });
  }
  return out;
}

describe("COLOR — no-op law (bitwise gate)", () => {
  it("color param default white bound to tintParam, never touched ≡ unbound (stateHash AND render)", () => {
    const a = new Effect(tintDoc("tint", [CP()]), { seed: 7 });
    const b = new Effect(tintDoc(null, []), { seed: 7 });
    for (let i = 0; i < 10; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(a.particleCount).toBeGreaterThan(0);
    expect(stateHash(a)).toBe(stateHash(b)); // tint is render-only ⇒ digests trivially equal
    expect(renderChannels(a)).toEqual(renderChannels(b)); // white × 1.0 ⇒ byte-identical
  });
});

describe("COLOR — default honored from construction", () => {
  it("non-white default {0.5,0.25,1,0.5} ⇒ first render channels equal unbound × default (f32-exact)", () => {
    const def: RGBAColor = { r: 0.5, g: 0.25, b: 1, a: 0.5 };
    const bound = new Effect(tintDoc("tint", [CP({ default: def })]), { seed: 7 });
    const unbound = new Effect(tintDoc(null, []), { seed: 7 });
    bound.step(1 / 60);
    unbound.step(1 / 60);
    const bc = renderChannels(bound);
    const uc = renderChannels(unbound);
    expect(bc.length).toBeGreaterThan(0);
    expect(bc.length).toBe(uc.length);
    for (let i = 0; i < bc.length; i++) {
      expect(bc[i]!.size).toBe(uc[i]!.size); // tint never touches size
      expect(bc[i]!.r).toBe(uc[i]!.r * def.r);
      expect(bc[i]!.g).toBe(uc[i]!.g * def.g);
      expect(bc[i]!.b).toBe(uc[i]!.b * def.b);
      expect(bc[i]!.a).toBe(uc[i]!.a * def.a);
    }
  });
});

describe("COLOR — render equivalence", () => {
  it("setColorParam(0.5,1,0.25,1) ⇒ each buf channel equals unbound × channel (f32-exact)", () => {
    const bound = new Effect(tintDoc("tint", [CP()]), { seed: 7 });
    const unbound = new Effect(tintDoc(null, []), { seed: 7 });
    bound.setColorParam("tint", 0.5, 1, 0.25, 1);
    bound.step(1 / 60);
    unbound.step(1 / 60);
    const bc = renderChannels(bound);
    const uc = renderChannels(unbound);
    expect(bc.length).toBeGreaterThan(0);
    for (let i = 0; i < bc.length; i++) {
      expect(bc[i]!.r).toBe(uc[i]!.r * 0.5);
      expect(bc[i]!.g).toBe(uc[i]!.g * 1);
      expect(bc[i]!.b).toBe(uc[i]!.b * 0.25);
      expect(bc[i]!.a).toBe(uc[i]!.a * 1);
    }
  });
});

describe("COLOR — order pin (tint × opacity compose)", () => {
  it("tint AND opacity both bound ⇒ buf.a equals unbound × tintA × opacity", () => {
    const l = tintLayer("tint");
    l.opacityParam = "op";
    const bound = new Effect(makeDoc({ layers: [l], params: [CP(), SP()], looping: false, duration: 100 }), { seed: 7 });
    const unbound = new Effect(tintDoc(null, []), { seed: 7 });
    bound.setColorParam("tint", 1, 1, 1, 0.5); // tintA = 0.5
    bound.setParam("op", 0.25); // opacity = 0.25
    bound.step(1 / 60);
    unbound.step(1 / 60);
    const bc = renderChannels(bound);
    const uc = renderChannels(unbound);
    expect(bc.length).toBeGreaterThan(0);
    for (let i = 0; i < bc.length; i++) {
      // Both multiplies are powers of two ⇒ the composition is bitwise-exact.
      expect(bc[i]!.a).toBe(uc[i]!.a * 0.5 * 0.25);
    }
  });
});

describe("COLOR — frame-live while frozen", () => {
  it("setColorParam during timeScale=0 is visible in the next render with NO step", () => {
    const fx = new Effect(tintDoc("tint", [CP()]), { seed: 2 });
    for (let i = 0; i < 5; i++) fx.step(1 / 60); // build live particles under the white default
    const ls = fx.layers[0]!;
    expect(ls.count).toBeGreaterThan(0);
    const buf0 = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf0);
    fx.timeScale = 0;
    fx.step(1 / 60); // frozen (E2 path) — no push could hide behind a real step here
    fx.setColorParam("tint", 0.5, 0.5, 0.5, 0.5);
    // NO further step: render directly (the paused-preview idiom).
    const buf1 = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf1);
    for (let i = 0; i < ls.count; i++) {
      // Particles are frozen ⇒ the over-life color is identical; only the tint moved.
      expect(buf1.r[i]).toBe(buf0.r[i]! * 0.5);
      expect(buf1.g[i]).toBe(buf0.g[i]! * 0.5);
      expect(buf1.b[i]).toBe(buf0.b[i]! * 0.5);
      expect(buf1.a[i]).toBe(buf0.a[i]! * 0.5);
    }
  });
});

describe("COLOR — digest immunity (tint is render-only)", () => {
  it("setColorParam mid-run ⇒ stateHash identical to never touching it", () => {
    const a = new Effect(tintDoc("tint", [CP()]), { seed: 7 });
    const b = new Effect(tintDoc("tint", [CP()]), { seed: 7 });
    const seq = dtSequence(11, 40);
    seq.forEach((dt, i) => {
      // Drive `a`'s tint all over the place; `b` never touches it.
      a.setColorParam("tint", (i % 5) / 4, (i % 3) / 2, 0.5, (i % 7) / 6);
      a.step(dt);
      b.step(dt);
      expect(stateHash(a)).toBe(stateHash(b));
    });
  });
});

describe("COLOR — API contract", () => {
  it("clamps each channel to [0,1]", () => {
    const fx = new Effect(tintDoc("tint", [CP()]), { seed: 1 });
    fx.setColorParam("tint", 2, -1, 0.5, 5);
    expect(fx.getColorParam("tint")).toEqual({ r: 1, g: 0, b: 0.5, a: 1 });
  });

  it("any non-finite channel rejects the WHOLE call (no partial write)", () => {
    const fx = new Effect(tintDoc("tint", [CP()]), { seed: 1 });
    fx.setColorParam("tint", 0.2, 0.3, 0.4, 0.5);
    const before = fx.getColorParam("tint");
    fx.setColorParam("tint", 0.9, NaN, 0.9, 0.9);
    expect(fx.getColorParam("tint")).toEqual(before); // NaN in g ⇒ nothing changed
    fx.setColorParam("tint", 0.9, 0.9, Infinity, 0.9);
    expect(fx.getColorParam("tint")).toEqual(before);
    fx.setColorParam("tint", -Infinity, 0.9, 0.9, 0.9);
    expect(fx.getColorParam("tint")).toEqual(before);
  });

  it("unknown name: setter is a silent no-op, getter returns null", () => {
    const fx = new Effect(tintDoc("tint", [CP()]), { seed: 1 });
    expect(() => fx.setColorParam("nope", 0.5, 0.5, 0.5, 0.5)).not.toThrow();
    expect(fx.getColorParam("nope")).toBeNull();
  });

  it("kind-mismatch tolerance both directions (scalar setters vs color param, and vice versa)", () => {
    // A doc carrying BOTH kinds (distinct names) so each mismatch is reachable.
    const l = tintLayer("c");
    const fx = new Effect(makeDoc({ layers: [l], params: [SP({ name: "s" }), CP({ name: "c" })], looping: false, duration: 100 }), { seed: 1 });
    // setParam on a color name: no-op; getParam on it: NaN.
    expect(() => fx.setParam("c", 5)).not.toThrow();
    expect(fx.getParam("c")).toBeNaN();
    expect(fx.getColorParam("c")).toEqual({ r: 1, g: 1, b: 1, a: 1 }); // color store untouched
    // setColorParam on a scalar name: no-op; getColorParam on it: null.
    expect(() => fx.setColorParam("s", 0.5, 0.5, 0.5, 0.5)).not.toThrow();
    expect(fx.getColorParam("s")).toBeNull();
    expect(fx.getParam("s")).toBe(1); // scalar store untouched
  });

  it("getColorParam returns a copy (mutating it does not affect the effect)", () => {
    const fx = new Effect(tintDoc("tint", [CP({ default: { r: 0.5, g: 0.5, b: 0.5, a: 0.5 } })]), { seed: 1 });
    const got = fx.getColorParam("tint")!;
    got.r = 0;
    got.a = 0;
    expect(fx.getColorParam("tint")).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 0.5 });
  });

  it("color value persists across reset(seed)", () => {
    const fx = new Effect(tintDoc("tint", [CP()]), { seed: 7 });
    fx.setColorParam("tint", 0.25, 0.5, 0.75, 1);
    fx.reset(7);
    expect(fx.getColorParam("tint")).toEqual({ r: 0.25, g: 0.5, b: 0.75, a: 1 });
  });

  it("duplicate names across kinds (validator rejects via E33/E34): independent stores, each accessor wins its own", () => {
    // Constructed directly (bypassing the validator) to pin the documented ruling:
    // the scalar and color namespaces are independent — neither shadows the other.
    const doc = makeDoc({
      layers: [tintLayer("k")],
      params: [SP({ name: "k", default: 2, min: 0, max: 4 }), CP({ name: "k", default: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 } })],
      looping: false,
      duration: 100,
    });
    const fx = new Effect(doc, { seed: 1 });
    expect(fx.getParam("k")).toBe(2); // scalar accessor → scalar store
    expect(fx.getColorParam("k")).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 0.4 }); // color accessor → color store
  });
});

describe("COLOR — dangling / kind-mismatch binding at runtime", () => {
  it("tintParam naming a scalar param ⇒ null mul, untouched render path (byte-identical to unbound)", () => {
    // Validator-invalid (E34) but constructible: tintParam names a scalar param.
    const l = tintLayer("s");
    const a = new Effect(makeDoc({ layers: [l], params: [SP({ name: "s" })], looping: false, duration: 100 }), { seed: 7 });
    const b = new Effect(tintDoc(null, []), { seed: 7 });
    a.step(1 / 60);
    b.step(1 / 60);
    expect(a.layers[0]!.tintParamMul).toBeNull(); // scalar name never resolves to a color mul
    expect(b.layers[0]!.tintParamMul).toBeNull(); // unbound control
    expect(a.particleCount).toBeGreaterThan(0);
    expect(renderChannels(a)).toEqual(renderChannels(b));
  });
});
