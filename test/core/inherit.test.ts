import { describe, it, expect } from "vitest";
import {
  Effect,
  makeRenderBuffers,
  computeRenderState,
  hueRotateRGB,
  type Layer,
  type SubEmitterRef,
  type RGBA,
} from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

// A SubEmitterRef with the v9 inherit flags (default false). Overriding `over`
// flips the flags / count / probability for a given case.
const sub = (
  trigger: SubEmitterRef["trigger"],
  layerId: string,
  over: Partial<SubEmitterRef> = {},
): SubEmitterRef => ({
  trigger,
  layerId,
  count: 1,
  probability: 1,
  inheritVelocity: 0,
  inheritColor: false,
  inheritSize: false,
  inheritRotation: false,
  ...over,
});

// Loose nested-object builders (test files are not tsc-checked; vitest runs them).
const emit = (over: Partial<Layer["emission"]> = {}): Layer["emission"] =>
  ({
    rateOverTime: { mode: "constant", value: 0 },
    rateOverDistance: null,
    bursts: [],
    delay: 0,
    prewarm: false,
    maxParticles: 200,
    ...over,
  }) as Layer["emission"];
const burst = (count: number, time = 0) => ({ time, count, spread: 0, cycles: 1, interval: 0, probability: 1 });
const init = (o: any = {}): Layer["initial"] =>
  ({
    life: o.life ?? { mode: "constant", value: 1 },
    speed: o.speed ?? { mode: "constant", value: 0 },
    size: o.size ?? { mode: "constant", value: 1 },
    rotation: o.rotation ?? { mode: "constant", value: 0 },
    angularVelocity: o.angVel ?? { mode: "constant", value: 0 },
  }) as Layer["initial"];
const olVel = (over: any = {}) => ({
  gravity: { x: 0, y: 0 },
  drag: null,
  speedMultiplier: null,
  x: null,
  y: null,
  orbital: null,
  radial: null,
  ...over,
});
const over = (o: any = {}): Layer["overLifetime"] =>
  ({
    size: o.size ?? null,
    color: o.color ?? { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
    rotation: null,
    velocity: olVel(o.vel),
  }) as Layer["overLifetime"];

// A point-shape child that emits ONLY via events (rateOverTime 0), so any
// particle it holds proves a trigger fired.
function child(id: string, o: any = {}): Layer {
  return makeLayer({
    id,
    name: id,
    shape: { kind: "point", emitFrom: "volume" },
    emission: emit({ maxParticles: 400 }),
    initial: init(o.init),
    overLifetime: o.over ?? over(),
    startColor: o.startColor ?? null,
    ...(o.layer ?? {}),
  });
}

function parent(id: string, subs: SubEmitterRef[], o: any = {}): Layer {
  return makeLayer({
    id,
    name: id,
    subEmitters: subs,
    shape: { kind: "point", emitFrom: "volume" },
    emission: emit(o.emission ?? { bursts: [burst(1)] }),
    initial: init(o.init),
    overLifetime: o.over ?? over(),
    startColor: o.startColor ?? null,
    bySpeed: o.bySpeed ?? null,
    collision: o.collision ?? null,
    ...(o.layer ?? {}),
  });
}

/** Render every layer of an effect into fresh buffers (for buffer-equality). */
function renderAll(fx: Effect) {
  return fx.layers.map((ls) => {
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    return buf;
  });
}

// ---------------------------------------------------------------------------
// No-op law: an all-flags-false sub-emitter-heavy doc is bit-identical to the
// same graph with the inherit flags ABSENT — the false path adds no state, no
// capture, no columns. (The global golden/determinism gates pin the tie to
// pre-M2 behavior; this is the unit-level structural pin.)
// ---------------------------------------------------------------------------
describe("inherit — no-op law (all flags false, M2)", () => {
  const heavyGraph = (withFlags: boolean) => {
    const flags = withFlags ? {} : undefined; // withFlags=false ⇒ omit flags entirely
    const mk = (t: SubEmitterRef["trigger"]): SubEmitterRef =>
      withFlags
        ? sub(t, "c", { inheritColor: false, inheritSize: false, inheritRotation: false })
        : // flags omitted entirely (the M8-era shape)
          ({ trigger: t, layerId: "c", count: 1, probability: 1, inheritVelocity: 0 } as SubEmitterRef);
    void flags;
    const p = parent("p", [mk("birth"), mk("death"), mk("collision")], {
      emission: emit({ rateOverTime: { mode: "constant", value: 40 }, maxParticles: 64 }),
      init: init({ life: { mode: "constant", value: 0.3 }, speed: { mode: "constant", value: 0 } }),
      over: over({ vel: { gravity: { x: 0, y: 400 } } }),
      collision: { shape: { kind: "floor", y: 50 }, bounce: 0.5, dampen: 0, lifetimeLoss: 0 },
    });
    return makeDoc({ duration: 2, looping: true, layers: [p, child("c", { init: init({ life: { mode: "constant", value: 1 }, speed: { mode: "constant", value: 30 } }) })] });
  };

  it("flags-false ⇒ no inherit columns, captureInherit false, and bit-identical to the flags-absent graph", () => {
    const withFalse = new Effect(heavyGraph(true), { seed: 1234 });
    const absent = new Effect(heavyGraph(false), { seed: 1234 });
    // Structural: no child inherit-color columns, parent does not capture.
    for (const ls of withFalse.layers) expect(ls.pool.inhR).toBeNull();
    expect(withFalse.layers[0]!.captureInherit).toBe(false);

    const dts = dtSequence(7, 400);
    const checkpoints = new Set([1, 60, 200, 400]);
    for (let i = 1; i <= 400; i++) {
      withFalse.step(dts[i - 1]!);
      absent.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(withFalse)).toBe(stateHash(absent));
    }
    // Render buffers identical too.
    const rf = renderAll(withFalse);
    const ra = renderAll(absent);
    for (let l = 0; l < rf.length; l++) {
      const n = withFalse.layers[l]!.count;
      expect(Array.from(rf[l]!.r.slice(0, n))).toEqual(Array.from(ra[l]!.r.slice(0, n)));
      expect(Array.from(rf[l]!.a.slice(0, n))).toEqual(Array.from(ra[l]!.a.slice(0, n)));
    }
    expect(withFalse.layers[1]!.count).toBeGreaterThan(0); // the graph actually fired
  });
});

// ---------------------------------------------------------------------------
// Zero-draw proof (the sharpest pin): flags ON with IDENTITY inherited values
// (size factor forced to 1 via null ol.size, rotation 0 via a zero-rotation
// parent) is stateHash-identical to flags OFF, and the child DRAW streams are
// byte-identical — inheritance modifies drawn RESULTS, never the PRNG. Color is
// on too: its columns are allocated and written, but _statehash does not fold
// them (render-only derived state), so the digest still matches exactly.
// ---------------------------------------------------------------------------
describe("inherit — zero-draw proof (M2)", () => {
  const graph = (on: boolean) => {
    const f = on ? { inheritColor: true, inheritSize: true, inheritRotation: true } : {};
    const p = parent("p", [sub("birth", "c", f), sub("death", "c", f), sub("collision", "c", f)], {
      emission: emit({ rateOverTime: { mode: "constant", value: 30 }, maxParticles: 64 }),
      init: init({ life: { mode: "constant", value: 0.4 }, rotation: { mode: "constant", value: 0 } }),
      over: over({ size: null, vel: { gravity: { x: 0, y: 400 } } }), // ol.size null ⇒ factor 1
      collision: { shape: { kind: "floor", y: 60 }, bounce: 0.5, dampen: 0, lifetimeLoss: 0 },
    });
    return makeDoc({ duration: 2, looping: true, layers: [p, child("c", { init: init({ speed: { mode: "constant", value: 25 } }) })] });
  };

  it("identity size/rotation ⇒ flags-on stateHash-identical to flags-off; child draw stream byte-identical", () => {
    const on = new Effect(graph(true), { seed: 909 });
    const off = new Effect(graph(false), { seed: 909 });
    // Structural difference: flags-on allocated the inherit-color columns, flags-off did not.
    expect(on.layers[1]!.pool.inhR).not.toBeNull();
    expect(off.layers[1]!.pool.inhR).toBeNull();
    expect(on.layers[0]!.captureInherit).toBe(true);

    const dts = dtSequence(19, 500);
    const checkpoints = new Set([1, 50, 150, 300, 500]);
    for (let i = 1; i <= 500; i++) {
      on.step(dts[i - 1]!);
      off.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(on)).toBe(stateHash(off)); // digest unmoved
    }
    // Child DRAW streams (drawn columns) byte-identical — the inherited values
    // never touched the PRNG.
    const co = on.layers[1]!;
    const cf = off.layers[1]!;
    expect(co.count).toBe(cf.count);
    const n = co.count;
    expect(n).toBeGreaterThan(0);
    for (const col of ["x", "y", "velX", "velY", "rand0", "rand1", "sizeInit", "rotation"] as const) {
      expect(Array.from(co.pool[col].slice(0, n))).toEqual(Array.from(cf.pool[col].slice(0, n)));
    }
  });
});

// ---------------------------------------------------------------------------
// Per-flag equivalence
// ---------------------------------------------------------------------------
describe("inherit — inheritSize bakes drawn size × the parent's over-life factor (M2)", () => {
  // Parent ol.size curve; a BIRTH child captures at t=0 ⇒ factor = the curve's
  // value at 0 (= its first key). Child init.size is constant so its drawn size
  // is exact; sizeInit == drawn × factor is hand-computable.
  const mk = (inheritSize: boolean) => {
    const p = parent("p", [sub("birth", "c", { inheritSize })], {
      emission: emit({ bursts: [burst(1)] }),
      init: init({ life: { mode: "constant", value: 10 } }),
      over: over({ size: { mode: "curve", keys: [{ t: 0, v: 3, ease: "linear" }, { t: 1, v: 0 }] } }),
    });
    return makeDoc({ duration: 5, looping: false, layers: [p, child("c", { init: init({ size: { mode: "constant", value: 5 } }) })] });
  };

  it("child sizeInit == drawnSize × factor(=3) when inheritSize is on", () => {
    const fx = new Effect(mk(true), { seed: 3 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    expect(fx.layers[1]!.pool.sizeInit[0]).toBe(5 * 3); // 15, exact
  });
  it("child sizeInit == drawnSize (unchanged) when inheritSize is off", () => {
    const fx = new Effect(mk(false), { seed: 3 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    expect(fx.layers[1]!.pool.sizeInit[0]).toBe(5);
  });
});

describe("inherit — inheritRotation adds the parent's rotation to the child's drawn rotation (M2)", () => {
  const mk = (inheritRotation: boolean) => {
    const p = parent("p", [sub("birth", "c", { inheritRotation })], {
      emission: emit({ bursts: [burst(1)] }),
      init: init({ life: { mode: "constant", value: 10 }, rotation: { mode: "constant", value: 30 } }),
    });
    return makeDoc({ duration: 5, looping: false, layers: [p, child("c", { init: init({ rotation: { mode: "constant", value: 10 } }) })] });
  };

  it("child rotation == drawn(10) + parent rotation(30) = 40 when on", () => {
    const fx = new Effect(mk(true), { seed: 4 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    expect(fx.layers[1]!.pool.rotation[0]).toBe(40);
  });
  it("child rotation == drawn(10) unchanged when off", () => {
    const fx = new Effect(mk(false), { seed: 4 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.pool.rotation[0]).toBe(10);
  });
});

describe("inherit — inheritColor writes the parent's sim RGBA and render multiplies by it (M2)", () => {
  // Child ol.color is white, so its render RGBA == the inherit columns exactly.
  const whiteChild = () =>
    child("c", { over: over({ color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] } }) });

  it("no parent startColor: child render == parent gradient at t=0 (f32-exact factors)", () => {
    // Gradient values all f32-representable ⇒ exact equality.
    const p = parent("p", [sub("birth", "c", { inheritColor: true })], {
      emission: emit({ bursts: [burst(1)] }),
      init: init({ life: { mode: "constant", value: 10 } }),
      over: over({ color: { keys: [{ t: 0, r: 0.5, g: 0.25, b: 0.75, a: 1 }] } }),
    });
    const fx = new Effect(makeDoc({ duration: 5, looping: false, layers: [p, whiteChild()] }), { seed: 5 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    expect(fx.layers[1]!.pool.inhR).not.toBeNull(); // columns allocated (target of an inheritColor ref)
    const buf = renderAll(fx)[1]!;
    expect([buf.r[0], buf.g[0], buf.b[0], buf.a[0]]).toEqual([0.5, 0.25, 0.75, 1]);
  });

  it("parent startColor tint is INCLUDED in the capture", () => {
    const p = parent("p", [sub("birth", "c", { inheritColor: true })], {
      emission: emit({ bursts: [burst(1)] }),
      init: init({ life: { mode: "constant", value: 10 } }),
      over: over({ color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] } }),
      startColor: { mode: "palette", colors: [{ r: 0.5, g: 0.5, b: 0.5, a: 1 }] },
    });
    const fx = new Effect(makeDoc({ duration: 5, looping: false, layers: [p, whiteChild()] }), { seed: 6 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    // gradient(1,1,1,1) × palette tint(0.5,0.5,0.5,1) = (0.5,0.5,0.5,1).
    const buf = renderAll(fx)[1]!;
    expect([buf.r[0], buf.g[0], buf.b[0], buf.a[0]]).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it("parent hueJitter rotation is INCLUDED (capture == hue-rotated gradient at the drawn offset)", () => {
    const p = parent("p", [sub("birth", "c", { inheritColor: true })], {
      emission: emit({ bursts: [burst(1)] }),
      init: init({ life: { mode: "constant", value: 10 } }),
      over: over({ color: { keys: [{ t: 0, r: 1, g: 0, b: 0, a: 1 }] } }), // saturated red
      startColor: { mode: "hueJitter", degrees: 180 },
    });
    const fx = new Effect(makeDoc({ duration: 5, looping: false, layers: [p, whiteChild()] }), { seed: 7 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    const offset = fx.layers[0]!.pool.tintR![0]!; // the parent particle's drawn hue offset (deg)
    expect(offset).not.toBe(0); // a real rotation is exercised
    const exp: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    hueRotateRGB(1, 0, 0, offset, exp);
    const buf = renderAll(fx)[1]!;
    // Child inhR is f32; render = fround(exp). Alpha stays the gradient's (1).
    expect(buf.r[0]).toBe(Math.fround(exp.r));
    expect(buf.g[0]).toBe(Math.fround(exp.g));
    expect(buf.b[0]).toBe(Math.fround(exp.b));
    expect(buf.a[0]).toBe(1);
  });

  it("parent bySpeed color is EXCLUDED from the capture (render-only)", () => {
    const p = parent("p", [sub("birth", "c", { inheritColor: true })], {
      emission: emit({ bursts: [burst(1)] }),
      init: init({ life: { mode: "constant", value: 10 }, speed: { mode: "constant", value: 100 } }),
      over: over({ color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] } }),
      // A bySpeed.color of 0.5 would halve the render color IF it leaked into capture.
      bySpeed: { size: null, color: { keys: [{ t: 0, r: 0.5, g: 0.5, b: 0.5, a: 0.5 }] }, rotation: null, range: { min: 0, max: 1 } },
    });
    const fx = new Effect(makeDoc({ duration: 5, looping: false, layers: [p, whiteChild()] }), { seed: 8 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    // Captured == plain gradient (1,1,1,1); the 0.5 bySpeed factor did NOT enter.
    const buf = renderAll(fx)[1]!;
    expect([buf.r[0], buf.g[0], buf.b[0], buf.a[0]]).toEqual([1, 1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------
// Every trigger carries inheritance (birth / death / collision).
// ---------------------------------------------------------------------------
describe("inherit — all three triggers apply inheritance (M2)", () => {
  // ol.size constant 0.5 ⇒ factor 0.5 at any capture t; child init.size 4 ⇒
  // sizeInit == 2 exactly whichever trigger fired.
  const build = (trigger: SubEmitterRef["trigger"], o: any) =>
    makeDoc({
      duration: 3,
      looping: false,
      layers: [
        parent("p", [sub(trigger, "c", { inheritSize: true })], {
          over: over({ size: { mode: "constant", value: 0.5 }, ...o.over }),
          ...o.parent,
        }),
        child("c", { init: init({ size: { mode: "constant", value: 4 } }) }),
      ],
    });

  it("birth", () => {
    const fx = new Effect(build("birth", { parent: { emission: emit({ bursts: [burst(1)] }), init: init({ life: { mode: "constant", value: 5 } }) } }), { seed: 11 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBeGreaterThanOrEqual(1);
    expect(fx.layers[1]!.pool.sizeInit[0]).toBe(2);
  });

  it("death", () => {
    const fx = new Effect(build("death", { parent: { emission: emit({ bursts: [burst(1)] }), init: init({ life: { mode: "constant", value: 0.2 } }) } }), { seed: 12 });
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    expect(fx.layers[1]!.pool.sizeInit[0]).toBe(2);
  });

  it("collision", () => {
    const fx = new Effect(
      build("collision", {
        over: { vel: { gravity: { x: 0, y: 400 } } },
        parent: {
          emission: emit({ bursts: [burst(1)] }),
          init: init({ life: { mode: "constant", value: 5 } }),
          collision: { shape: { kind: "floor", y: 50 }, bounce: 0.5, dampen: 0, lifetimeLoss: 0 },
        },
      }),
      { seed: 13 },
    );
    for (let i = 0; i < 60; i++) fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBeGreaterThanOrEqual(1);
    expect(fx.layers[1]!.pool.sizeInit[0]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Mixed refs on one parent: an inheriting ref and a non-inheriting ref feed
// their own children per their own flags.
// ---------------------------------------------------------------------------
describe("inherit — mixed refs on one parent (M2)", () => {
  it("inheriting ref scales its child; the sibling non-inheriting ref does not", () => {
    const p = parent(
      "p",
      [sub("birth", "cA", { inheritSize: true }), sub("birth", "cB", { inheritSize: false })],
      {
        emission: emit({ bursts: [burst(1)] }),
        init: init({ life: { mode: "constant", value: 10 } }),
        over: over({ size: { mode: "constant", value: 0.5 } }),
      },
    );
    const doc = makeDoc({
      duration: 5,
      looping: false,
      layers: [p, child("cA", { init: init({ size: { mode: "constant", value: 4 } }) }), child("cB", { init: init({ size: { mode: "constant", value: 4 } }) })],
    });
    const fx = new Effect(doc, { seed: 21 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1); // cA
    expect(fx.layers[2]!.count).toBe(1); // cB
    expect(fx.layers[1]!.pool.sizeInit[0]).toBe(2); // 4 × 0.5
    expect(fx.layers[2]!.pool.sizeInit[0]).toBe(4); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Determinism + snapshot stability of an inherit-heavy doc.
// ---------------------------------------------------------------------------
describe("inherit — determinism (M2)", () => {
  const inheritDoc = () => {
    const f = { inheritColor: true, inheritSize: true, inheritRotation: true };
    const p = parent("p", [sub("birth", "c", f), sub("death", "c", f), sub("collision", "c", f)], {
      emission: emit({ rateOverTime: { mode: "constant", value: 40 }, maxParticles: 64 }),
      init: init({ life: { mode: "constant", value: 0.35 }, speed: { mode: "constant", value: 20 }, rotation: { mode: "range", min: 0, max: 360 } }),
      over: over({ size: { mode: "curve", keys: [{ t: 0, v: 2, ease: "linear" }, { t: 1, v: 0.25 }] }, color: { keys: [{ t: 0, r: 1, g: 0.7, b: 0.2, a: 1 }, { t: 1, r: 1, g: 0.1, b: 0, a: 0 }] }, vel: { gravity: { x: 0, y: 400 } } }),
      startColor: { mode: "hueJitter", degrees: 60 },
      collision: { shape: { kind: "floor", y: 80 }, bounce: 0.5, dampen: 0.1, lifetimeLoss: 0.05 },
    });
    return makeDoc({ duration: 2, looping: true, layers: [p, child("c", { init: init({ life: { mode: "constant", value: 1 }, speed: { mode: "constant", value: 40 } }), over: over({ color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] } }) })] });
  };

  it("two runs, same seed ⇒ identical stateHash, identical inherit-color columns, identical render buffers", () => {
    const a = new Effect(inheritDoc(), { seed: 4242 });
    const b = new Effect(inheritDoc(), { seed: 4242 });
    const dts = dtSequence(23, 600);
    const checkpoints = new Set([1, 60, 300, 600]);
    for (let i = 1; i <= 600; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
    const ca = a.layers[1]!;
    const cb = b.layers[1]!;
    const n = ca.count;
    expect(n).toBeGreaterThan(0);
    expect(ca.pool.inhR).not.toBeNull();
    // Inherit-color columns are NOT folded by _statehash (render-only), so pin
    // them directly: identical runs must agree on them too.
    for (const col of ["inhR", "inhG", "inhB", "inhA"] as const) {
      expect(Array.from(ca.pool[col]!.slice(0, n))).toEqual(Array.from(cb.pool[col]!.slice(0, n)));
    }
    const ra = renderAll(a)[1]!;
    const rb = renderAll(b)[1]!;
    for (const ch of ["r", "g", "b", "a"] as const) {
      expect(Array.from(ra[ch].slice(0, n))).toEqual(Array.from(rb[ch].slice(0, n)));
    }
  });
});
