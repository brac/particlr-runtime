// Emitter motion / simulation space (schemaVersion 2). Verifies world-space
// spawning: position interpolation along the emitter's step segment, inherited
// velocity, teleport (no interpolation), rate-over-distance, prewarm placement,
// and that local layers are untouched by emitter motion. All Node, no browser.
import { describe, it, expect } from "vitest";
import { Effect, type ParticleDoc, type Layer, type Emission } from "../../src/index.js";
import { makeDoc, makeLayer } from "../format/_helpers.js";

// A still, immortal, point-emitting layer tuned per test. Gravity/drag zeroed so
// spawn positions are exactly the emitter-interpolated values after one step.
function layer(over: Partial<Layer> = {}, em: Partial<Emission> = {}): Layer {
  const base = makeLayer();
  return {
    ...base,
    shape: { kind: "point", emitFrom: "volume" },
    space: "local",
    inheritVelocity: 0,
    emission: {
      rateOverTime: { mode: "constant", value: 0 },
      rateOverDistance: null,
      bursts: [],
      delay: 0,
      prewarm: false,
      maxParticles: 1000,
      ...em,
    },
    initial: {
      ...base.initial,
      life: { mode: "constant", value: 100 },
      speed: { mode: "constant", value: 0 },
    },
    overLifetime: {
      ...base.overLifetime,
      velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
    ...over,
  };
}
function doc(l: Layer, over: Partial<ParticleDoc> = {}): ParticleDoc {
  return makeDoc({ layers: [l], looping: false, duration: 100, ...over });
}
// Live x positions of layer 0, sorted ascending.
function xs(fx: Effect): number[] {
  const p = fx.layers[0]!.pool;
  return Array.from({ length: p.count }, (_, i) => p.x[i]!).sort((a, b) => a - b);
}

describe("emitter transform API", () => {
  it("defaults to the origin and reports the committed position after a step", () => {
    const fx = new Effect(doc(layer()));
    expect(fx.emitterX).toBe(0);
    expect(fx.emitterY).toBe(0);
    fx.setEmitterPosition(30, 40);
    fx.step(0.02);
    expect(fx.emitterX).toBe(30);
    expect(fx.emitterY).toBe(40);
  });

  it("honors the constructor start position", () => {
    const fx = new Effect(doc(layer()), { x: 5, y: 6 });
    expect(fx.emitterX).toBe(5);
    expect(fx.emitterY).toBe(6);
  });
});

describe("world-space spawn interpolation", () => {
  it("distributes a continuous batch along the emitter's step segment", () => {
    // rate 400 over dt 0.01 => 4 particles, at midpoint fractions of a 0->100 move.
    const l = layer({ space: "world" }, { rateOverTime: { mode: "constant", value: 400 } });
    const fx = new Effect(doc(l));
    fx.setEmitterPosition(100, 0);
    fx.step(0.01);
    expect(fx.particleCount).toBe(4);
    const got = xs(fx);
    [12.5, 37.5, 62.5, 87.5].forEach((want, i) => expect(got[i]!).toBeCloseTo(want, 4));
  });

  it("places burst sub-events by their time within the step", () => {
    // count 2, spread 0.01, step 0.02 => sub-events at f=0 and f=0.5 of a 0->100 move.
    const l = layer({ space: "world" }, { bursts: [{ time: 0, count: 2, spread: 0.01 }] });
    const fx = new Effect(doc(l));
    fx.setEmitterPosition(100, 0);
    fx.step(0.02);
    const got = xs(fx);
    expect(got[0]!).toBeCloseTo(0, 4);
    expect(got[1]!).toBeCloseTo(50, 4);
  });

  it("leaves local-space layers at their local positions when the emitter moves", () => {
    const l = layer({ space: "local" }, { bursts: [{ time: 0, count: 4, spread: 0 }] });
    const fx = new Effect(doc(l));
    fx.setEmitterPosition(100, 0);
    fx.step(0.02);
    // Point shape at the local origin — emitter motion does not touch core coords.
    for (const x of xs(fx)) expect(x).toBeCloseTo(0, 6);
  });
});

describe("inherited velocity", () => {
  const drive = (space: "local" | "world", iv: number): number => {
    const l = layer({ space, inheritVelocity: iv }, { bursts: [{ time: 0, count: 1, spread: 0 }] });
    const fx = new Effect(doc(l));
    fx.setEmitterPosition(100, 0); // emitter velocity = 100 / 0.02 = 5000 px/s
    fx.step(0.02);
    return fx.layers[0]!.pool.velX[0]!;
  };

  it("adds inheritVelocity × emitter velocity in world space", () => {
    expect(drive("world", 1)).toBeCloseTo(5000, 2);
    expect(drive("world", 0)).toBeCloseTo(0, 6);
    expect(drive("world", -0.5)).toBeCloseTo(-2500, 2);
  });

  it("ignores inheritVelocity in local space", () => {
    expect(drive("local", 1)).toBeCloseTo(0, 6);
  });
});

describe("teleport (E15)", () => {
  it("jumps with no interpolation and no inherited velocity", () => {
    const l = layer({ space: "world", inheritVelocity: 1 }, { bursts: [{ time: 0, count: 4, spread: 0.015 }] });
    const fx = new Effect(doc(l));
    fx.teleportEmitter(500, 0);
    fx.step(0.02);
    expect(fx.emitterX).toBe(500);
    for (const x of xs(fx)) expect(x).toBeCloseTo(500, 6); // no smear across the gap
    expect(fx.layers[0]!.pool.velX[0]!).toBeCloseTo(0, 6); // no teleport-speed launch
  });
});

describe("rate over distance", () => {
  it("spawns particles per pixel traveled, spread along the path", () => {
    const l = layer({ space: "world" }, { rateOverDistance: { mode: "constant", value: 0.1 } });
    const fx = new Effect(doc(l));
    fx.setEmitterPosition(100, 0); // 100 px * 0.1 = 10 particles
    fx.step(0.02);
    expect(fx.particleCount).toBe(10);
    const got = xs(fx);
    [5, 15, 25, 35, 45, 55, 65, 75, 85, 95].forEach((want, i) => expect(got[i]!).toBeCloseTo(want, 4));
  });

  it("emits nothing while the emitter is stationary", () => {
    const l = layer({ space: "world" }, { rateOverDistance: { mode: "constant", value: 0.1 } });
    const fx = new Effect(doc(l));
    fx.step(0.02);
    fx.step(0.02);
    expect(fx.particleCount).toBe(0);
  });

  it("is inert for local-space layers", () => {
    const l = layer({ space: "local" }, { rateOverDistance: { mode: "constant", value: 0.1 } });
    const fx = new Effect(doc(l));
    fx.setEmitterPosition(100, 0);
    fx.step(0.02);
    expect(fx.particleCount).toBe(0);
  });
});

describe("prewarm × world space (E16)", () => {
  it("spawns prewarmed particles at the initial emitter position", () => {
    const l = layer({ space: "world" }, {
      rateOverTime: { mode: "constant", value: 50 },
      prewarm: true,
    });
    const fx = new Effect(doc(l, { looping: true, duration: 1 }), { x: 7, y: 0 });
    expect(fx.particleCount).toBeGreaterThan(0);
    for (const x of xs(fx)) expect(x).toBeCloseTo(7, 6); // no motion during prewarm
  });
});

describe("determinism with emitter motion", () => {
  it("same seed + same (dt, position) sequence ⇒ identical pools", () => {
    const build = () => new Effect(doc(layer({ space: "world" }, { rateOverTime: { mode: "constant", value: 300 } })), { seed: 99 });
    const seq: Array<[number, number, number]> = [
      [0.016, 20, 0],
      [0.016, 55, 10],
      [0.016, 55, 10],
      [0.016, 130, -5],
    ];
    const runa = build();
    const runb = build();
    for (const [dt, x, y] of seq) {
      runa.setEmitterPosition(x, y);
      runa.step(dt);
      runb.setEmitterPosition(x, y);
      runb.step(dt);
    }
    const pa = runa.layers[0]!.pool;
    const pb = runb.layers[0]!.pool;
    expect(pa.count).toBe(pb.count);
    expect(pa.count).toBeGreaterThan(0);
    for (let i = 0; i < pa.count; i++) {
      expect(pa.x[i]).toBe(pb.x[i]);
      expect(pa.y[i]).toBe(pb.y[i]);
      expect(pa.velX[i]).toBe(pb.velX[i]);
    }
  });

  it("reset keeps the emitter position and stills motion", () => {
    const fx = new Effect(doc(layer({ space: "world" })));
    fx.setEmitterPosition(40, 0);
    fx.step(0.02);
    fx.reset();
    expect(fx.emitterX).toBe(40); // host owns placement — reset does not recenter
    // A step with no queued move leaves the emitter still (velocity cleared).
    fx.step(0.02);
    expect(fx.layers[0]!.pool.count).toBe(0);
  });
});
