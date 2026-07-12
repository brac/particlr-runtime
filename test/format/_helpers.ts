import type { ParticleDoc, Layer } from "../../src/index.js";

// A complete, valid single-layer document used as the base for validation
// tests. Each test clones and mutates one field to isolate one rule.
export function makeLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    id: "l1",
    name: "layer",
    enabled: true,
    blend: "add",
    texture: { ref: "circle-soft", frames: null },
    emission: {
      rateOverTime: { mode: "constant", value: 20 },
      rateOverTimeParam: null,
      rateOverDistance: null,
      rateOverDistanceParam: null,
      bursts: [{ time: 0, count: 12, spread: 0, cycles: 1, interval: 0, probability: 1 }],
      delay: 0,
      prewarm: false,
      maxParticles: 256,
    },
    shape: { kind: "cone", direction: -90, spread: 30, radius: 10, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
    space: "local",
    inheritVelocity: 0,
    attractorInfluence: 0,
    initial: {
      life: { mode: "range", min: 0.5, max: 1 },
      lifeParam: null,
      speed: { mode: "range", min: 40, max: 80 },
      speedParam: null,
      size: { mode: "constant", value: 8 },
      sizeParam: null,
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: { mode: "curve", keys: [{ t: 0, v: 1, ease: "easeOut" }, { t: 1, v: 0 }] },
      color: {
        keys: [
          { t: 0, r: 1, g: 0.8, b: 0.3, a: 1 },
          { t: 1, r: 1, g: 0.1, b: 0, a: 0 },
        ],
      },
      rotation: null,
      velocity: {
        gravity: { x: 0, y: 30 },
        gravityParam: null,
        drag: null,
        speedMultiplier: null,
        x: null,
        y: null,
        orbital: null,
        radial: null,
      },
    },
    limitVelocity: null,
    noise: null,
    wind: null,
    bySpeed: null,
    byEmitterSpeed: null,
    startColor: null,
    randomFlip: null,
    tintParam: null,
    opacityParam: null,
    render: null,
    dissolve: null,
    collision: null,
    killZones: null,
    attractor: null,
    subEmitters: null,
    trail: null,
    ...overrides,
  };
}

export function makeDoc(overrides: Partial<ParticleDoc> = {}): ParticleDoc {
  return {
    schemaVersion: 11,
    meta: { name: "Test", createdWith: "particlr@0.x", notes: "" },
    duration: 1.2,
    looping: true,
    seed: 1337,
    params: [],
    layers: [makeLayer()],
    ...overrides,
  };
}

// Structured clone that preserves order and nested objects for mutation.
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
