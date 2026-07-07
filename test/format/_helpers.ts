import type { SparkDoc, Layer } from "../../src/index.js";

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
      rateOverDistance: null,
      bursts: [{ time: 0, count: 12, spread: 0 }],
      delay: 0,
      prewarm: false,
      maxParticles: 256,
    },
    shape: { kind: "cone", direction: -90, spread: 30, radius: 10, emitFrom: "volume" },
    space: "local",
    inheritVelocity: 0,
    initial: {
      life: { mode: "range", min: 0.5, max: 1 },
      speed: { mode: "range", min: 40, max: 80 },
      size: { mode: "constant", value: 8 },
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
        drag: null,
        speedMultiplier: null,
      },
    },
    subEmitters: null,
    trail: null,
    ...overrides,
  };
}

export function makeDoc(overrides: Partial<SparkDoc> = {}): SparkDoc {
  return {
    schemaVersion: 2,
    meta: { name: "Test", createdWith: "sparkr@0.x", notes: "" },
    duration: 1.2,
    looping: true,
    seed: 1337,
    layers: [makeLayer()],
    ...overrides,
  };
}

// Structured clone that preserves order and nested objects for mutation.
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
