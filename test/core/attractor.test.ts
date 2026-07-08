import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { LayerSim, Effect, deriveLayerSeed, parseParticle, type Layer, type AttractorConfig, type ScalarTrack, type ParticleDoc } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);
const ct = (value: number): ScalarTrack => ({ mode: "constant", value });

const presetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../presets");
const loadPreset = (name: string): ParticleDoc => {
  const parsed = parseParticle(readFileSync(resolve(presetsDir, name), "utf8"));
  if (!parsed.ok) throw new Error(`${name}: ${JSON.stringify(parsed.errors)}`);
  return parsed.doc!;
};

// A single-particle layer whose ONLY force is the attractor (or a host attractor
// driven via setHostAttractor). Point shape, zero launch speed, effectively
// infinite life, no over-lifetime motion. Tests spawn one particle and overwrite
// its position/velocity directly (index 0 is stable — no swap-remove).
function attractLayer(
  attractor: AttractorConfig | null,
  opts: { influence?: number; drag?: ScalarTrack | null; gravity?: { x: number; y: number }; space?: "local" | "world" } = {},
): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    space: opts.space ?? "local",
    attractorInfluence: opts.influence ?? 0,
    initial: {
      life: { mode: "constant", value: 100 },
      speed: { mode: "constant", value: 0 },
      size: { mode: "constant", value: 1 },
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: null,
      color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
      rotation: null,
      velocity: { gravity: opts.gravity ?? { x: 0, y: 0 }, drag: opts.drag ?? null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
    attractor,
  });
}

function one(layer: Layer): LayerSim {
  const ls = new LayerSim(layer, seed);
  expect(ls.spawn()).toBe(true);
  return ls;
}

describe("attractor — radial force (M2, §0.3b)", () => {
  it("radial acceleration moves the STORED velocity (unlike VoL's position-only rule)", () => {
    const ls = one(attractLayer({ x: 100, y: 0, strength: ct(300), tangential: null, radius: 200, falloff: "none", killRadius: 0 }));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = 0;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 0;
    ls.pool.lifetime[0] = 100;
    ls.update(0.5); // dx=100, d=100, s=0.5, w(none)=1, ux=1, aR=300: vx += 1·300·0.5 = 150
    expect(ls.pool.velX[0]!).toBe(150); // written to the STORED velocity column
    expect(ls.pool.velY[0]!).toBe(0);
  });

  it("positive tangential orbits clockwise: a particle at +x of the point gains +vy", () => {
    const ls = one(attractLayer({ x: 0, y: 0, strength: ct(0), tangential: ct(200), radius: 200, falloff: "none", killRadius: 0 }));
    ls.pool.x[0] = 100; // +x of the point
    ls.pool.y[0] = 0;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 0;
    ls.pool.lifetime[0] = 100;
    ls.update(0.5); // ux=-1, uy=0, aT=200: vy += (0 - (-1)·200)·0.5 = 100, vx += 0
    expect(ls.pool.velY[0]!).toBe(100);
    expect(ls.pool.velY[0]!).toBeGreaterThan(0); // clockwise on the y-down screen
    expect(ls.pool.velX[0]!).toBe(0);
  });
});

describe("attractor — falloff weights (M2, §0.3b)", () => {
  // Point at origin, particle at (D, 0): ux=-1, d=D. velX = -1·(400·w)·0.5 = -200·w.
  const velAt = (falloff: AttractorConfig["falloff"], D: number): number => {
    const ls = one(attractLayer({ x: 0, y: 0, strength: ct(400), tangential: null, radius: 200, falloff, killRadius: 0 }));
    ls.pool.x[0] = D;
    ls.pool.y[0] = 0;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 0;
    ls.pool.lifetime[0] = 100;
    ls.update(0.5);
    return ls.pool.velX[0]!;
  };

  it("none = full strength inside the radius (w=1)", () => {
    expect(velAt("none", 50)).toBe(-200); // s=0.75, w=1
  });
  it("linear ramps with s (w=s)", () => {
    expect(velAt("linear", 50)).toBe(-150); // s=0.75, w=0.75 → -200·0.75
  });
  it("smooth = smoothstep(s) = s·s·(3−2s)", () => {
    expect(velAt("smooth", 50)).toBe(-168.75); // s=0.75, w=0.84375 → -200·0.84375
  });

  // Bitwise-untouched checks: start the velocity at a non-zero value and prove the
  // force block leaves it EXACTLY that when d ≥ radius, beyond, or at the center.
  const untouched = (D: number): number => {
    const ls = one(attractLayer({ x: 0, y: 0, strength: ct(400), tangential: ct(400), radius: 200, falloff: "smooth", killRadius: 0 }));
    ls.pool.x[0] = D;
    ls.pool.y[0] = 0;
    ls.pool.velX[0] = 7;
    ls.pool.velY[0] = -3;
    ls.pool.lifetime[0] = 100;
    ls.update(0.5);
    return ls.pool.velX[0]!;
  };
  it("d = radius: no force (bitwise untouched)", () => {
    expect(untouched(200)).toBe(7);
  });
  it("d beyond radius: no force (bitwise untouched)", () => {
    expect(untouched(250)).toBe(7);
  });
  it("d = 0 (at the point): no force, no divide-by-zero", () => {
    expect(untouched(0)).toBe(7);
  });
});

describe("attractor — killRadius fires a death sub-emitter (M2 × M8)", () => {
  const parentLayer = (killRadius: number): Layer =>
    makeLayer({
      id: "parent",
      space: "local",
      shape: { kind: "point", emitFrom: "volume" },
      emission: { rateOverTime: ct(0), rateOverDistance: null, bursts: [{ time: 0, count: 1, spread: 0, cycles: 1, interval: 0, probability: 1 }], delay: 0, prewarm: false, maxParticles: 8 },
      initial: {
        life: { mode: "constant", value: 100 },
        speed: { mode: "constant", value: 0 },
        size: { mode: "constant", value: 1 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
      // Attractor centered on the spawn point; a particle spawns AT (0,0) so it is
      // inside killRadius immediately (d=0 — consumed even though the force skips it).
      attractor: { x: 0, y: 0, strength: ct(0), tangential: null, radius: 200, falloff: "none", killRadius },
      subEmitters: [{ trigger: "death", layerId: "child", count: 5, probability: 1, inheritVelocity: 0 }],
    });
  const childLayer = (): Layer =>
    makeLayer({
      id: "child",
      shape: { kind: "point", emitFrom: "volume" },
      emission: { rateOverTime: ct(0), rateOverDistance: null, bursts: [], delay: 0, prewarm: false, maxParticles: 32 },
    });

  it("a particle inside killRadius dies this step and spawns the death children", () => {
    const doc = makeDoc({ duration: 100, looping: false, layers: [parentLayer(50), childLayer()] });
    const fx = new Effect(doc, { seed: 1337 });
    fx.step(0.1); // parent burst spawns one particle at (0,0)
    expect(fx.layers[0]!.count).toBe(1);
    fx.step(0.1); // parent particle is consumed (killRadius) → death event → child spawns
    expect(fx.layers[0]!.count).toBe(0);
    expect(fx.layers[1]!.count).toBe(5);
  });

  it("control: killRadius 0 keeps the particle alive, no death children", () => {
    const doc = makeDoc({ duration: 100, looping: false, layers: [parentLayer(0), childLayer()] });
    const fx = new Effect(doc, { seed: 1337 });
    fx.step(0.1);
    fx.step(0.1);
    expect(fx.layers[0]!.count).toBe(1); // still alive (life 100)
    expect(fx.layers[1]!.count).toBe(0); // no death fired
  });
});

describe("attractor — host hook (M2, §0.3b)", () => {
  it("host influence scales the acceleration linearly (0.5 / 1 / 2)", () => {
    const run = (infl: number): number => {
      const ls = one(attractLayer(null, { influence: infl, space: "world" }));
      ls.pool.x[0] = 0;
      ls.pool.y[0] = 0;
      ls.pool.velX[0] = 0;
      ls.pool.velY[0] = 0;
      ls.pool.lifetime[0] = 100;
      ls.setHostAttractor(100, 0, 400, 200); // sim-frame coords, smooth falloff, radial only
      ls.update(0.5); // d=100, s=0.5, w(smooth)=0.5, aR=400·infl·0.5=200·infl; velX=200·infl·0.5=100·infl
      return ls.pool.velX[0]!;
    };
    expect(run(0.5)).toBe(50);
    expect(run(1)).toBe(100);
    expect(run(2)).toBe(200);
  });

  it("influence 0 ⇒ bit-identical to a run with no setAttractor (load-bearing)", () => {
    // makeLayer defaults to attractorInfluence 0, so a host attractor is inert.
    const doc = makeDoc({ duration: 2, looping: true, layers: [makeLayer({ space: "world" })] });
    const withCalls = new Effect(doc, { seed: 1337 });
    const plain = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(11, 120);
    for (let i = 0; i < 120; i++) {
      withCalls.setAttractor(50, -20, 700, 180); // driven every step; influence 0 ⇒ no force
      withCalls.step(dts[i]!);
      plain.step(dts[i]!); // never touches the host attractor
    }
    expect(stateHash(withCalls)).toBe(stateHash(plain));
  });

  it("frame conversion (E24): world uses coords as-is, local subtracts the step-end emitter", () => {
    const build = (space: "world" | "local"): Effect => {
      const layer = makeLayer({
        id: "l",
        space,
        attractorInfluence: 1,
        shape: { kind: "point", emitFrom: "volume" },
        emission: { rateOverTime: ct(0), rateOverDistance: null, bursts: [{ time: 0, count: 1, spread: 0, cycles: 1, interval: 0, probability: 1 }], delay: 0, prewarm: false, maxParticles: 8 },
        initial: {
          life: { mode: "constant", value: 100 },
          speed: { mode: "constant", value: 0 },
          size: { mode: "constant", value: 1 },
          rotation: { mode: "constant", value: 0 },
          angularVelocity: { mode: "constant", value: 0 },
        },
        overLifetime: {
          size: null,
          color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
          rotation: null,
          velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
        },
      });
      return new Effect(makeDoc({ duration: 100, looping: false, layers: [layer] }), { seed: 1337, x: 0, y: 0 });
    };
    const place = (fx: Effect): void => {
      const p = fx.layers[0]!.pool;
      p.x[0] = 0;
      p.y[0] = 0;
      p.velX[0] = 0;
      p.velY[0] = 0;
      p.age[0] = 0;
      p.lifetime[0] = 100;
    };

    // WORLD: emitter stays at 0; host (50,0) used as-is ⇒ the point is at +x ⇒ +vx.
    const w = build("world");
    w.step(0.1);
    place(w);
    w.setAttractor(50, 0, 400, 200);
    w.step(0.1);
    expect(w.layers[0]!.pool.velX[0]!).toBeGreaterThan(0);

    // LOCAL: emitter moved to (100,0); host (50,0) → local (50−100,0)=(−50,0) ⇒ −vx.
    const l = build("local");
    l.step(0.1);
    place(l);
    l.setEmitterPosition(100, 0);
    l.setAttractor(50, 0, 400, 200);
    l.step(0.1);
    expect(l.layers[0]!.pool.velX[0]!).toBeLessThan(0);
  });

  it("setAttractor changes state; clearAttractor restores the null path bitwise", () => {
    const doc = makeDoc({ duration: 2, looping: true, layers: [makeLayer({ space: "world", attractorInfluence: 1 })] });
    const dts = dtSequence(17, 60);
    const baseline = new Effect(doc, { seed: 1337 });
    const active = new Effect(doc, { seed: 1337 });
    const cleared = new Effect(doc, { seed: 1337 });
    for (let i = 0; i < 60; i++) {
      active.setAttractor(40, 0, 600, 220);
      cleared.setAttractor(40, 0, 600, 220);
      cleared.clearAttractor(); // net no-op each step
      baseline.step(dts[i]!);
      active.step(dts[i]!);
      cleared.step(dts[i]!);
    }
    expect(stateHash(active)).not.toBe(stateHash(baseline)); // the attractor actually did something
    expect(stateHash(cleared)).toBe(stateHash(baseline)); // clearing reverts to the null path
  });
});

describe("attractor — determinism (M2)", () => {
  it("two runs with a scripted setAttractor sequence are bit-identical over 600 mixed-dt steps", () => {
    const doc = makeDoc({ duration: 2, looping: true, layers: [makeLayer({ space: "world", attractorInfluence: 1 })] });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(23, 600);
    const script = (fx: Effect, i: number): void => {
      if (i === 1) fx.setAttractor(60, -20, 500, 220);
      else if (i === 200) fx.setAttractor(-40, 30, 800, 180);
      else if (i === 400) fx.clearAttractor();
      else if (i === 500) fx.setAttractor(0, 0, 300, 150);
    };
    const checkpoints = new Set([1, 200, 400, 600]);
    for (let i = 1; i <= 600; i++) {
      script(a, i);
      script(b, i);
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
  });

  it("null pin: influence 0 makes setAttractor a no-op even with gravity+collision+noise", () => {
    const layer = makeLayer({
      space: "world",
      shape: { kind: "cone", direction: -90, spread: 40, radius: 6, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 400 }, drag: ct(0.5), speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
      noise: { strength: ct(40), frequency: 0.02, scrollSpeed: 0.3, octaves: 2 },
      collision: { shape: { kind: "floor", y: 100 }, bounce: 0.5, dampen: 0.2, lifetimeLoss: 0.05 },
    });
    const doc = makeDoc({ duration: 2, looping: true, layers: [layer] });
    const plain = new Effect(doc, { seed: 1337 });
    const withCalls = new Effect(doc, { seed: 1337 });
    for (let i = 0; i < 120; i++) {
      withCalls.setAttractor(30, -40, 700, 160);
      plain.step(1 / 60);
      withCalls.step(1 / 60);
    }
    expect(stateHash(withCalls)).toBe(stateHash(plain));
  });

  it("zero-draw pin: an attractor layer's spawn stream is identical to an attractor-null twin", () => {
    const att: AttractorConfig = { x: 0, y: 0, strength: ct(300), tangential: ct(100), radius: 200, falloff: "smooth", killRadius: 20 };
    const nullTwin = new LayerSim(makeLayer(), seed);
    const attTwin = new LayerSim(makeLayer({ attractor: att }), seed);
    for (let k = 0; k < 50; k++) {
      nullTwin.spawn();
      attTwin.spawn();
    }
    expect(attTwin.count).toBe(nullTwin.count);
    const n = nullTwin.count;
    expect(Array.from(attTwin.pool.rand0.slice(0, n))).toEqual(Array.from(nullTwin.pool.rand0.slice(0, n)));
    expect(Array.from(attTwin.pool.velX.slice(0, n))).toEqual(Array.from(nullTwin.pool.velX.slice(0, n)));
    expect(Array.from(attTwin.pool.x.slice(0, n))).toEqual(Array.from(nullTwin.pool.x.slice(0, n)));
  });

  it("migrated-preset pin: an existing preset stays deterministic through the M2 code path", () => {
    // The load-bearing HEAD pin is the unchanged preset determinism SNAPSHOTS
    // (determinism.test.ts, run with no -u). Here we confirm a real preset still
    // runs bit-identically twice through the (now attractor-carrying) update loop.
    const doc = loadPreset("explosion.prt");
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    for (let i = 0; i < 60; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(stateHash(a)).toBe(stateHash(b));
  });
});

describe("attractor — update-order pin (gravity → attractor → drag) (M2)", () => {
  it("with high drag the attractor force IS dragged this step (proves it runs before drag)", () => {
    // Undragged twin: no drag ⇒ velX = full attractor delta.
    const bare = one(attractLayer({ x: 100, y: 0, strength: ct(400), tangential: null, radius: 200, falloff: "none", killRadius: 0 }));
    bare.pool.x[0] = 0;
    bare.pool.y[0] = 0;
    bare.pool.velX[0] = 0;
    bare.pool.velY[0] = 0;
    bare.pool.lifetime[0] = 100;
    bare.update(0.5); // ux=1, aR=400: velX = 1·400·0.5 = 200
    expect(bare.pool.velX[0]!).toBe(200);

    // Dragged twin: drag const 1 ⇒ factor = 1 − 1·0.5 = 0.5; the attractor delta is
    // multiplied by it because the force is applied BEFORE drag.
    const dragged = one(attractLayer({ x: 100, y: 0, strength: ct(400), tangential: null, radius: 200, falloff: "none", killRadius: 0 }, { drag: ct(1) }));
    dragged.pool.x[0] = 0;
    dragged.pool.y[0] = 0;
    dragged.pool.velX[0] = 0;
    dragged.pool.velY[0] = 0;
    dragged.pool.lifetime[0] = 100;
    dragged.update(0.5);
    expect(dragged.pool.velX[0]!).toBe(100); // 200 · 0.5 (dragged), NOT 200
  });
});
