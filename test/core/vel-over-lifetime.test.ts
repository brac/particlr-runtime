import { describe, it, expect } from "vitest";
import { LayerSim, Effect, deriveLayerSeed, mulberry32, type Layer, type ScalarTrack } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);
const RAD = Math.PI / 180;

// A minimal single-particle layer: point shape, zero launch speed, no gravity/
// drag/speedMul and an effectively infinite lifetime, so the ONLY motion is the
// velocity-over-lifetime field under test. Any velocity tracks are merged in.
function velLayer(v: Partial<Layer["overLifetime"]["velocity"]>, extra: Partial<Layer> = {}): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
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
      velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null, ...v },
    },
    ...extra,
  });
}

const ct = (value: number): ScalarTrack => ({ mode: "constant", value });

describe("velocity over lifetime — orbital (§M3)", () => {
  it("pure orbital keeps a constant radius and advances the angle clockwise", () => {
    const R = 50;
    const sim = new LayerSim(velLayer({ orbital: ct(30) }), seed); // 30 deg/s
    expect(sim.spawn()).toBe(true);
    sim.pool.x[0] = R;
    sim.pool.y[0] = 0;

    let prevAngle = 0;
    for (let i = 0; i < 60; i++) {
      sim.update(1 / 60);
      const x = sim.pool.x[0]!;
      const y = sim.pool.y[0]!;
      const r = Math.hypot(x, y);
      // Rotation preserves magnitude: the orbit radius is invariant.
      expect(Math.abs(r - R)).toBeLessThan(1e-2);
      // Clockwise on the y-down screen: from (R,0) the offset rotates toward +y,
      // so atan2(y,x) increases monotonically off zero.
      const angle = Math.atan2(y, x);
      expect(angle).toBeGreaterThan(prevAngle);
      prevAngle = angle;
    }
    // 30 deg/s for 1 s ⇒ ~30° swept.
    expect(prevAngle).toBeCloseTo(30 * RAD, 4);
  });

  it("orbital rotates in place: a particle AT the origin stays at the origin", () => {
    const sim = new LayerSim(velLayer({ orbital: ct(120) }), seed);
    expect(sim.spawn()).toBe(true);
    sim.pool.x[0] = 0;
    sim.pool.y[0] = 0;
    for (let i = 0; i < 30; i++) sim.update(1 / 60);
    expect(sim.pool.x[0]).toBe(0);
    expect(sim.pool.y[0]).toBe(0);
  });
});

describe("velocity over lifetime — radial (§M3)", () => {
  it("pure radial grows the radius linearly and preserves direction", () => {
    const R = 10;
    const radial = 20; // px/s outward
    const sim = new LayerSim(velLayer({ radial: ct(radial) }), seed);
    expect(sim.spawn()).toBe(true);
    sim.pool.x[0] = R;
    sim.pool.y[0] = 0;

    const dt = 1 / 60;
    for (let i = 1; i <= 60; i++) {
      sim.update(dt);
      // Along +x with oy=0, each step adds exactly radial·dt to r, so after
      // t seconds r = R + radial·t (exact, not just approximate).
      expect(sim.pool.x[0]).toBeCloseTo(R + radial * i * dt, 4);
      expect(sim.pool.y[0]).toBe(0); // direction preserved
    }
  });

  it("skips the radial push at the origin (r < 1e-6, no NaN)", () => {
    const sim = new LayerSim(velLayer({ radial: ct(50) }), seed);
    expect(sim.spawn()).toBe(true);
    sim.pool.x[0] = 0;
    sim.pool.y[0] = 0;
    sim.update(1 / 60);
    expect(sim.pool.x[0]).toBe(0);
    expect(sim.pool.y[0]).toBe(0);
  });
});

describe("velocity over lifetime — additive x/y (§M3)", () => {
  it("additive x moves position but does NOT change stored velX (twin-sim)", () => {
    const moving = new LayerSim(velLayer({ x: ct(50) }), seed);
    const still = new LayerSim(velLayer({}), seed); // all four tracks null
    expect(moving.spawn()).toBe(true);
    expect(still.spawn()).toBe(true);
    // Zero launch speed ⇒ both start at rest at the origin. The moving layer's
    // extra draw (15) only feeds velRandX, so the shared 13 spawn draws match.
    expect(moving.pool.x[0]).toBe(still.pool.x[0]);
    expect(moving.pool.velX[0]).toBe(0);

    for (let i = 0; i < 20; i++) {
      moving.update(1 / 60);
      still.update(1 / 60);
    }
    // Position advanced by the additive track; stored velocity is untouched.
    expect(moving.pool.x[0]).toBeCloseTo(50 * (20 / 60), 4);
    expect(moving.pool.velX[0]).toBe(0);
    expect(still.pool.x[0]).toBe(0);
    expect(still.pool.velX[0]).toBe(0);
    expect(moving.pool.x[0]).not.toBe(still.pool.x[0]);
  });
});

describe("velocity over lifetime — world-space origin follows the emitter (§M3)", () => {
  it("the orbital center is the step-end emitter position", () => {
    const sim = new LayerSim(velLayer({ orbital: ct(90) }, { space: "world" }), seed);
    // Origin 1 at (100,50).
    sim.setEmitterStep(100, 50, 100, 50, 0, 0);
    expect(sim.spawn()).toBe(true);
    sim.pool.x[0] = 140; // 40 px right of origin 1
    sim.pool.y[0] = 50;

    const dist = (ox: number, oy: number): number => Math.hypot(sim.pool.x[0]! - ox, sim.pool.y[0]! - oy);
    const d1before = dist(100, 50);
    sim.update(1 / 60);
    // Rotation is about origin 1 ⇒ distance to it is preserved.
    expect(Math.abs(dist(100, 50) - d1before)).toBeLessThan(1e-2);

    // Move the emitter: origin 2 at (300,200).
    sim.setEmitterStep(300, 200, 300, 200, 0, 0);
    const d2before = dist(300, 200);
    const d1now = dist(100, 50);
    sim.update(1 / 60);
    // Now rotation is about origin 2 ⇒ distance to origin 2 is preserved,
    // and distance to the OLD origin 1 changed (the center moved with the emitter).
    expect(Math.abs(dist(300, 200) - d2before)).toBeLessThan(1e-2);
    expect(Math.abs(dist(100, 50) - d1now)).toBeGreaterThan(1e-3);
  });
});

describe("velocity over lifetime — PRNG draws 15–18 (§0.2)", () => {
  it("all four tracks null ⇒ no velRand columns and a stream identical to a plain layer", () => {
    const plain = new LayerSim(makeLayer(), seed);
    const nullVel = new LayerSim(velLayer({}), seed);
    expect(nullVel.pool.velRandX).toBeNull();
    expect(nullVel.pool.velRandY).toBeNull();
    expect(nullVel.pool.velRandOrbital).toBeNull();
    expect(nullVel.pool.velRandRadial).toBeNull();
    // Two spawns each: with zero extra draws the second particle's first uniform
    // must match a plain layer built from the same seed.
    plain.spawn();
    plain.spawn();
    nullVel.spawn();
    nullVel.spawn();
    expect(nullVel.pool.rand0[1]).toBe(plain.pool.rand0[1]);
  });

  it("x-only ⇒ exactly one extra draw (the stream shifts for the next spawn)", () => {
    const plain = new LayerSim(velLayer({}), seed);
    const xOnly = new LayerSim(velLayer({ x: ct(10) }), seed);
    expect(xOnly.pool.velRandX).not.toBeNull();
    expect(xOnly.pool.velRandY).toBeNull();
    plain.spawn();
    plain.spawn();
    xOnly.spawn();
    xOnly.spawn();
    // Particle 0 shares the 13 standard draws; particle 1 differs because x-only
    // consumed one extra draw between the two spawns.
    expect(xOnly.pool.rand0[1]).not.toBe(plain.pool.rand0[1]);
  });

  it("draws 15–18 are appended after the 13 standard draws, in the fixed order x, y, orbital, radial", () => {
    // No noise, all four velocity tracks non-null. After the 13 standard spawn
    // draws (indices 0..12) the next four draws feed velRandX/Y/Orbital/Radial in
    // that exact order — pinned by mulberry32 draw-index equality (the way
    // noise-sim pins draw 14).
    const sim = new LayerSim(velLayer({ x: ct(1), y: ct(2), orbital: ct(3), radial: ct(4) }), seed);
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng(); // the 13 standard spawn draws
    expect(sim.pool.velRandX![0]).toBe(Math.fround(rng())); // draw 15
    expect(sim.pool.velRandY![0]).toBe(Math.fround(rng())); // draw 16
    expect(sim.pool.velRandOrbital![0]).toBe(Math.fround(rng())); // draw 17
    expect(sim.pool.velRandRadial![0]).toBe(Math.fround(rng())); // draw 18
  });

  it("noise (draw 14) precedes the velocity draws when both are present", () => {
    const noise = { strength: ct(10), frequency: 0.02, scrollSpeed: 0, octaves: 1 };
    const sim = new LayerSim(velLayer({ x: ct(1), radial: ct(4) }, { noise }), seed);
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng();
    expect(sim.pool.noisePhase![0]).toBe(Math.fround(rng())); // draw 14
    expect(sim.pool.velRandX![0]).toBe(Math.fround(rng())); // draw 15 (x)
    // y and orbital are null ⇒ no draws; radial is the next one.
    expect(sim.pool.velRandRadial![0]).toBe(Math.fround(rng())); // draw 18 (radial)
  });
});

describe("velocity over lifetime — determinism (§0.2)", () => {
  it("is bit-identical across two runs with all four tracks on (range mode incl.), 300 mixed-dt steps", () => {
    const layer = velLayer(
      {
        x: { mode: "range", min: -30, max: 30 }, // exercises velRandX
        y: ct(15),
        orbital: { mode: "curve", keys: [{ t: 0, v: 40 }, { t: 1, v: 160 }] },
        radial: ct(-20),
      },
      {
        shape: { kind: "circle", radius: 60, arcMode: "random", arcSpeed: 1, innerRadius: 0, arc: 360, emitFrom: "surface" },
        initial: {
          life: { mode: "range", min: 1, max: 2 },
          speed: { mode: "range", min: 10, max: 40 },
          size: { mode: "constant", value: 4 },
          rotation: { mode: "constant", value: 0 },
          angularVelocity: { mode: "constant", value: 0 },
        },
        emission: { rateOverTime: { mode: "constant", value: 80 }, rateOverDistance: null, bursts: [], delay: 0, prewarm: false, maxParticles: 400 },
      },
    );
    const doc = makeDoc({ duration: 5, layers: [layer] });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(11, 300);
    const checkpoints = new Set([1, 60, 150, 300]);
    for (let i = 1; i <= 300; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
    for (const [la, lb] of a.layers.map((l, i) => [l, b.layers[i]!] as const)) {
      expect(la.count).toBe(lb.count);
      expect(Array.from(la.pool.x.slice(0, la.count))).toEqual(Array.from(lb.pool.x.slice(0, lb.count)));
    }
    expect(a.layers[0]!.count).toBeGreaterThan(0);
  });
});
