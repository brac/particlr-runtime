import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LayerSim, Effect, deriveLayerSeed, mulberry32, parseParticle, type Layer, type NoiseConfig, type ParticleDoc } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";
import { presetsDir, hasPresets } from "../_presets.js";

const seed = deriveLayerSeed(1337, 0);
const NOISE: NoiseConfig = { strength: { mode: "constant", value: 50 }, frequency: 0.02, scrollSpeed: 0.3, octaves: 2 };

const loadPreset = (name: string): ParticleDoc => {
  const parsed = parseParticle(readFileSync(resolve(presetsDir, name), "utf8"));
  if (!parsed.ok) throw new Error(`${name}: ${JSON.stringify(parsed.errors)}`);
  return parsed.doc!;
};

describe("noise draw 14 (schemaVersion 3, §0.2)", () => {
  it("a null-noise layer allocates no noisePhase column and draws nothing extra", () => {
    const sim = new LayerSim(makeLayer(), seed);
    expect(sim.pool.noisePhase).toBeNull();
  });

  it("the noise draw is APPENDED after frameRand, not inserted (rand0..3/frameRand unchanged)", () => {
    // Two layers identical except for the noise module. With the same seed, the
    // first spawn's 13 standard draws must be byte-identical; the noise layer
    // then consumes ONE extra draw (the 14th) for its phase.
    const plain = new LayerSim(makeLayer(), seed);
    const noisy = new LayerSim(makeLayer({ noise: NOISE }), seed);
    plain.spawn();
    noisy.spawn();

    for (const f of ["x", "y", "velX", "velY", "lifetime", "sizeInit", "rotation", "angVel", "rand0", "rand1", "rand2", "rand3", "frameRand"] as const) {
      expect(noisy.pool[f][0], f).toBe(plain.pool[f][0]);
    }
    // The noise layer has a phase column; the plain layer does not.
    expect(plain.pool.noisePhase).toBeNull();
    expect(noisy.pool.noisePhase).not.toBeNull();

    // The stored phase is exactly the 14th mulberry32 draw from the layer seed
    // (rounded to Float32 by the pool column).
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng(); // the 13 standard spawn draws
    expect(noisy.pool.noisePhase![0]).toBe(Math.fround(rng()));
  });

  it("the extra draw shifts the stream for the NEXT spawn (proves consumption)", () => {
    const plain = new LayerSim(makeLayer(), seed);
    const noisy = new LayerSim(makeLayer({ noise: NOISE }), seed);
    plain.spawn();
    plain.spawn();
    noisy.spawn();
    noisy.spawn();
    // Particle 0 shared its 13 draws; particle 1 must differ because the noise
    // layer consumed one extra draw between them.
    expect(noisy.pool.rand0[1]).not.toBe(plain.pool.rand0[1]);
  });
});

describe.skipIf(!hasPresets)("noise perturbation (schemaVersion 3, §0.3)", () => {
  it("perturbs position but does NOT accumulate into stored velocity (§0.3)", () => {
    // One particle tracked in each of two twin sims (index 0 is stable — no
    // swap-remove), identical except for the noise module, with no gravity/
    // drag/speedMul so the ONLY difference between their trajectories can be
    // noise. With a single spawn the first 13 draws are identical (the noisy
    // sim's 14th draw only feeds noisePhase — proven in the draw-14 test
    // above), so both particles start at the same position and velocity.
    const base = makeLayer();
    const mkTwin = (noise: Layer["noise"]): Layer =>
      makeLayer({
        initial: { ...base.initial, life: { mode: "constant", value: 10 }, speed: { mode: "constant", value: 30 } },
        overLifetime: { ...base.overLifetime, size: null, velocity: { ...base.overLifetime.velocity, gravity: { x: 0, y: 0 } } },
        noise,
      });
    const noisy = new LayerSim(mkTwin({ strength: { mode: "constant", value: 200 }, frequency: 0.05, scrollSpeed: 0, octaves: 1 }), seed);
    const plain = new LayerSim(mkTwin(null), seed);
    noisy.setClock(0);
    plain.setClock(0);
    expect(noisy.spawn()).toBe(true);
    expect(plain.spawn()).toBe(true);
    // Twin spawns are identical (same seed, same first 13 draws).
    expect(noisy.pool.x[0]).toBe(plain.pool.x[0]);
    expect(noisy.pool.y[0]).toBe(plain.pool.y[0]);
    expect(noisy.pool.velX[0]).toBe(plain.pool.velX[0]);
    expect(noisy.pool.velY[0]).toBe(plain.pool.velY[0]);
    const vx0 = noisy.pool.velX[0]!;
    const vy0 = noisy.pool.velY[0]!;

    for (let i = 0; i < 20; i++) {
      noisy.update(1 / 60);
      plain.update(1 / 60);
    }
    // Velocity is untouched by noise (bounded position perturbation, not an
    // acceleration): both twins still carry the exact spawn velocity.
    expect(noisy.pool.velX[0]).toBe(vx0);
    expect(noisy.pool.velY[0]).toBe(vy0);
    expect(plain.pool.velX[0]).toBe(vx0);
    expect(plain.pool.velY[0]).toBe(vy0);
    // The perturbation displaces relative to the UN-noised trajectory — a real
    // baseline, not just "something moved" (the base velocity alone would have
    // satisfied that).
    const dx = Math.abs(noisy.pool.x[0]! - plain.pool.x[0]!);
    const dy = Math.abs(noisy.pool.y[0]! - plain.pool.y[0]!);
    expect(dx + dy).toBeGreaterThan(0);
  });

  it("is bit-identical across two runs with noise on (300 mixed-dt steps)", () => {
    const doc = loadPreset("firefly-field.prt");
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(7, 300);
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
  });

  it("perf smoke: 10k particles × 100 steps with noise on (non-gating)", () => {
    const layer = makeLayer({
      emission: { ...makeLayer().emission, rateOverTime: { mode: "constant", value: 100000 }, bursts: [], maxParticles: 10000 },
      noise: { strength: { mode: "constant", value: 40 }, frequency: 0.02, scrollSpeed: 0.5, octaves: 3 },
    });
    const fx = new Effect(makeDoc({ duration: 10, layers: [layer] }), { seed: 1337 });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) fx.step(1 / 60);
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[perf] noise 10k×100: ${fx.layers[0]!.count} particles, ${ms.toFixed(1)} ms`);
    expect(fx.layers[0]!.count).toBeGreaterThan(0);
  });
});
