import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { LayerSim, Effect, deriveLayerSeed, parseParticle, type Layer, type ScalarTrack, type ParticleDoc } from "../../src/index.js";
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

// A single-particle layer whose ONLY force is (optionally) gravity / drag /
// speedMultiplier, plus a limitVelocity cap. Point shape, zero launch speed,
// effectively infinite life. Tests spawn one particle and overwrite its
// position/velocity directly (index 0 is stable — no swap-remove).
function limitLayer(
  limitVelocity: ScalarTrack | null,
  opts: { drag?: ScalarTrack | null; gravity?: { x: number; y: number }; speedMul?: ScalarTrack | null } = {},
): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    space: "local",
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
      velocity: { gravity: opts.gravity ?? { x: 0, y: 0 }, drag: opts.drag ?? null, speedMultiplier: opts.speedMul ?? null, x: null, y: null, orbital: null, radial: null },
    },
    limitVelocity,
  });
}

function one(layer: Layer): LayerSim {
  const ls = new LayerSim(layer, seed);
  expect(ls.spawn()).toBe(true);
  ls.pool.lifetime[0] = 100;
  return ls;
}

describe("limit-velocity — clamp exactness (M1, §0.3a)", () => {
  it("a speed above the cap scales direction-preserving to exactly the cap", () => {
    const ls = one(limitLayer(ct(50)));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = 0;
    ls.pool.velX[0] = 100;
    ls.pool.velY[0] = 100;
    ls.update(0.5);
    // Compute the expected with the SAME float ops the sim uses — including the
    // Float32 store into the pool (Math.fround).
    const speed = Math.sqrt(100 * 100 + 100 * 100);
    const s = 50 / speed;
    expect(ls.pool.velX[0]!).toBe(Math.fround(100 * s));
    expect(ls.pool.velY[0]!).toBe(Math.fround(100 * s));
    // Direction preserved (velX === velY here) and final speed == cap.
    expect(Math.sqrt(ls.pool.velX[0]! ** 2 + ls.pool.velY[0]! ** 2)).toBeCloseTo(50, 3);
  });

  it("a 3-4-5 vector clamps exactly (integer-clean)", () => {
    const ls = one(limitLayer(ct(250)));
    ls.pool.velX[0] = 300;
    ls.pool.velY[0] = 400; // speed 500
    ls.update(0.5);
    expect(ls.pool.velX[0]!).toBe(150); // 300 · (250/500)
    expect(ls.pool.velY[0]!).toBe(200); // 400 · (250/500)
  });

  it("a speed below the cap is bitwise identical to a limitVelocity-null twin", () => {
    const capped = one(limitLayer(ct(100)));
    const nullTwin = one(limitLayer(null));
    for (const ls of [capped, nullTwin]) {
      ls.pool.velX[0] = 33.33;
      ls.pool.velY[0] = 20.5; // speed ~39 < 100
    }
    capped.update(0.5);
    nullTwin.update(0.5);
    expect(capped.pool.velX[0]!).toBe(nullTwin.pool.velX[0]!);
    expect(capped.pool.velY[0]!).toBe(nullTwin.pool.velY[0]!);
    expect(capped.pool.x[0]!).toBe(nullTwin.pool.x[0]!);
    expect(capped.pool.y[0]!).toBe(nullTwin.pool.y[0]!);
  });
});

describe("limit-velocity — cap = 0 freezes (M1, E27)", () => {
  it("clamps stored velocity to (0,0) and stops the particle moving", () => {
    const ls = one(limitLayer(ct(0)));
    ls.pool.x[0] = 10;
    ls.pool.y[0] = 20;
    ls.pool.velX[0] = 100;
    ls.pool.velY[0] = 100;
    ls.update(0.5);
    expect(ls.pool.velX[0]!).toBe(0);
    expect(ls.pool.velY[0]!).toBe(0);
    expect(ls.pool.x[0]!).toBe(10); // position delta 0
    expect(ls.pool.y[0]!).toBe(20);
    // A second step keeps it frozen (no other forces).
    ls.update(0.5);
    expect(ls.pool.x[0]!).toBe(10);
    expect(ls.pool.y[0]!).toBe(20);
  });
});

describe("limit-velocity — curve cap over ageNorm (M1)", () => {
  it("evaluates the cap at the particle's ageNorm", () => {
    // Cap 300 → 0 over life; at mid-life (ageNorm 0.5) the cap is 150.
    const ls = one(limitLayer({ mode: "curve", keys: [{ t: 0, v: 300 }, { t: 1, v: 0 }] }));
    ls.pool.lifetime[0] = 2;
    ls.pool.age[0] = 1; // ageNorm = 0.5
    ls.pool.velX[0] = 300;
    ls.pool.velY[0] = 0; // speed 300 > cap 150
    ls.update(0.001); // tiny dt so ageNorm at the top of update stays 0.5
    expect(ls.pool.velX[0]!).toBe(150);
    expect(ls.pool.velY[0]!).toBe(0);
  });
});

describe("limit-velocity — update-order pin (after drag, feeds position) (M1)", () => {
  it("the cap applies AFTER drag: pre-drag speed above cap, post-drag below ⇒ un-clamped", () => {
    // drag const 1, dt 0.5 ⇒ factor 0.5. Pre-drag speed 200 (> cap 150); post-drag
    // speed 100 (< cap). Clamp runs after drag, so velX stays 100 (NOT 75, which is
    // what clamping-then-dragging 150·0.5 would give).
    const ls = one(limitLayer(ct(150), { drag: ct(1) }));
    ls.pool.velX[0] = 200;
    ls.pool.velY[0] = 0;
    ls.update(0.5);
    expect(ls.pool.velX[0]!).toBe(100);
  });

  it("the clamped velocity feeds the speedMultiplier position step", () => {
    // velX 400 clamps to 100 (cap 100), then speedMul 2 drives the position: the
    // stored velocity is the clamped value; the position uses clamped · sm · dt.
    const ls = one(limitLayer(ct(100), { speedMul: ct(2) }));
    ls.pool.x[0] = 0;
    ls.pool.velX[0] = 400;
    ls.pool.velY[0] = 0;
    ls.update(0.5);
    expect(ls.pool.velX[0]!).toBe(100); // stored velocity is the clamped value (sm not applied)
    expect(ls.pool.x[0]!).toBe(100); // 100 · 2 · 0.5
  });
});

describe("limit-velocity — terminal-velocity interaction (M1)", () => {
  it("gravity re-fills then the cap re-clamps each step: speed settles at the cap", () => {
    const ls = one(limitLayer(ct(200), { gravity: { x: 0, y: 1000 } }));
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 0;
    for (let i = 0; i < 40; i++) ls.update(1 / 60);
    const speed = Math.sqrt(ls.pool.velX[0]! ** 2 + ls.pool.velY[0]! ** 2);
    expect(speed).toBeCloseTo(200, 6); // stays == cap (terminal velocity)
  });
});

describe("limit-velocity — determinism & inertness (M1)", () => {
  it("null pin: a limitVelocity-null layer is bit-identical run twice through the new path", () => {
    const layer = makeLayer({
      space: "world",
      limitVelocity: null,
      shape: { kind: "cone", direction: -90, spread: 40, radius: 6, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 400 }, drag: ct(0.5), speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
      noise: { strength: ct(40), frequency: 0.02, scrollSpeed: 0.3, octaves: 2 },
    });
    const doc = makeDoc({ duration: 2, looping: true, layers: [layer] });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(11, 300);
    for (let i = 0; i < 300; i++) {
      a.step(dts[i]!);
      b.step(dts[i]!);
    }
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it("non-binding-inertness / zero-draw pin: a huge cap that never binds ⇒ stateHash identical to a null twin", () => {
    // The clamp branch is entered (limitVelocity !== null) but never modifies vx/vy
    // (speed < cap) and draws no PRNG (literal 0 uniform), so the full sim — spawn
    // stream, motion, tint columns — is byte-identical to the limitVelocity-null run.
    const base = (limit: ScalarTrack | null): Layer =>
      makeLayer({
        space: "world",
        limitVelocity: limit,
        shape: { kind: "cone", direction: -90, spread: 40, radius: 6, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
        overLifetime: {
          size: null,
          color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
          rotation: null,
          velocity: { gravity: { x: 0, y: 400 }, drag: ct(0.5), speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
        },
        noise: { strength: ct(40), frequency: 0.02, scrollSpeed: 0.3, octaves: 2 },
        startColor: { mode: "palette", colors: [{ r: 1, g: 0.5, b: 0.2, a: 1 }, { r: 0.2, g: 0.5, b: 1, a: 1 }] },
      });
    const nullDoc = makeDoc({ duration: 2, looping: true, layers: [base(null)] });
    const hugeDoc = makeDoc({ duration: 2, looping: true, layers: [base(ct(1e9))] });
    const nullFx = new Effect(nullDoc, { seed: 1337 });
    const hugeFx = new Effect(hugeDoc, { seed: 1337 });
    for (let i = 0; i < 200; i++) {
      nullFx.step(1 / 60);
      hugeFx.step(1 / 60);
    }
    expect(stateHash(hugeFx)).toBe(stateHash(nullFx));
  });

  it("two-run bit identity with a BINDING cap over 600 mixed-dt steps", () => {
    const layer = makeLayer({
      space: "world",
      limitVelocity: { mode: "curve", keys: [{ t: 0, v: 300 }, { t: 1, v: 40 }] },
      shape: { kind: "cone", direction: -90, spread: 40, radius: 6, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
      initial: {
        life: { mode: "range", min: 0.5, max: 1 },
        speed: { mode: "range", min: 200, max: 600 }, // launch fast so the cap binds
        size: { mode: "constant", value: 8 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 400 }, drag: ct(0.3), speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
    });
    const doc = makeDoc({ duration: 2, looping: true, layers: [layer] });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(23, 600);
    const checkpoints = new Set([1, 200, 400, 600]);
    for (let i = 1; i <= 600; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
  });

  it("migrated-preset pin: an existing preset stays deterministic through the M1 code path", () => {
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
