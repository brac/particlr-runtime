import { describe, it, expect } from "vitest";
import { LayerSim, deriveLayerSeed, type Layer } from "../../src/index.js";
import { makeLayer } from "../format/_helpers.js";

const seed = deriveLayerSeed(1337, 0);

describe("LayerSim.spawn — draw order & determinism (§2.7)", () => {
  it("is deterministic for the same layer + seed", () => {
    const a = new LayerSim(makeLayer(), seed);
    const b = new LayerSim(makeLayer(), seed);
    for (let i = 0; i < 5; i++) {
      a.spawn();
      b.spawn();
    }
    for (const f of ["x", "y", "velX", "velY", "lifetime", "sizeInit", "rotation", "rand0", "frameRand"] as const) {
      expect(Array.from(a.pool[f])).toEqual(Array.from(b.pool[f]));
    }
  });

  it("draw order is mode-independent: changing life's mode leaves other properties' draws untouched", () => {
    const base = makeLayer();
    const rangeLife: Layer = { ...base, initial: { ...base.initial, life: { mode: "range", min: 0.5, max: 1 } } };
    const constLife: Layer = { ...base, initial: { ...base.initial, life: { mode: "constant", value: 0.7 } } };
    const a = new LayerSim(rangeLife, seed);
    const b = new LayerSim(constLife, seed);
    a.spawn();
    b.spawn();
    // Everything except lifetime must be identical (same stream positions).
    for (const f of ["x", "y", "velX", "velY", "sizeInit", "rotation", "angVel", "rand0", "rand1", "rand2", "rand3", "frameRand"] as const) {
      expect(a.pool[f][0]).toBe(b.pool[f][0]);
    }
    expect(a.pool.lifetime[0]).not.toBe(b.pool.lifetime[0]);
  });

  it("drops spawns and sets capped when the pool is full (E7)", () => {
    const layer = makeLayer({ emission: { ...makeLayer().emission, maxParticles: 2 } });
    const sim = new LayerSim(layer, seed);
    expect(sim.spawn()).toBe(true);
    expect(sim.spawn()).toBe(true);
    expect(sim.spawn()).toBe(false);
    expect(sim.capped).toBe(true);
    expect(sim.count).toBe(2);
  });

  it("reset clears particles and rewinds the stream", () => {
    const sim = new LayerSim(makeLayer(), seed);
    sim.spawn();
    const firstX = sim.pool.x[0];
    sim.reset(seed);
    expect(sim.count).toBe(0);
    sim.spawn();
    expect(sim.pool.x[0]).toBe(firstX);
  });
});

describe("LayerSim.update — integration math (§2.4, §2.5)", () => {
  function craftedLayer(): Layer {
    const base = makeLayer();
    return {
      ...base,
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: { mode: "constant", value: 10 },
        velocity: {
          gravity: { x: 0, y: 10 },
          drag: { mode: "constant", value: 0.5 },
          speedMultiplier: { mode: "constant", value: 2 },
          x: null,
          y: null,
          orbital: null,
          radial: null,
        },
      },
    };
  }

  it("applies gravity, then drag, then speedMultiplier, then position (one step)", () => {
    const sim = new LayerSim(craftedLayer(), seed);
    const p = sim.pool;
    p.count = 1;
    p.x[0] = 0;
    p.y[0] = 0;
    p.velX[0] = 10;
    p.velY[0] = 0;
    p.age[0] = 0;
    p.lifetime[0] = 100;
    p.rotation[0] = 0;
    p.angVel[0] = 90;
    sim.update(0.1);

    // vx = 10 + 0*0.1 = 10; vy = 0 + 10*0.1 = 1
    // drag f = 1 - 0.5*0.1 = 0.95 -> vx=9.5, vy=0.95
    // sm = 2 -> x += 9.5*2*0.1 = 1.9 ; y += 0.95*2*0.1 = 0.19
    expect(p.velX[0]).toBeCloseTo(9.5, 4);
    expect(p.velY[0]).toBeCloseTo(0.95, 4);
    expect(p.x[0]).toBeCloseTo(1.9, 4);
    expect(p.y[0]).toBeCloseTo(0.19, 4);
    // rotation += (angVel 90 + track 10) * 0.1 = 10
    expect(p.rotation[0]).toBeCloseTo(10, 4);
    expect(p.age[0]).toBeCloseTo(0.1, 6);
  });

  it("kills particles whose age reaches lifetime", () => {
    const sim = new LayerSim(craftedLayer(), seed);
    const p = sim.pool;
    p.count = 2;
    p.lifetime[0] = 0.05;
    p.age[0] = 0;
    p.lifetime[1] = 10;
    p.age[1] = 0;
    p.velX[0] = 0;
    p.velY[0] = 0;
    p.velX[1] = 0;
    p.velY[1] = 0;
    sim.update(0.1); // particle 0 dies (age 0.1 >= 0.05)
    expect(sim.count).toBe(1);
    expect(p.lifetime[0]).toBe(10); // survivor swapped into slot 0
  });
});
