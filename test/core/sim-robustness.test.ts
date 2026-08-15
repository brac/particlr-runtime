// Simulation-robustness regressions from the 2026-08-15 adversarial audit:
//   S-1  disabled layers froze their pools ⇒ isDone/onDone never fired
//   S-3  a disabled parent replayed its last step's sub-emitter events forever
//   S-4  step(NaN) slipped past both dt guards and poisoned the sim permanently
//   S-5  the MAX_DT clamp didn't clamp emitter-derived velocity or distance emission
// Every fix must be behavior-neutral for normal playback; the byte-identity pins
// at the bottom of each block are the guard, and the shared determinism snapshot
// (determinism.test.ts) must stay untouched.
import { describe, it, expect } from "vitest";
import { Effect, MAX_DT, type Layer, type ParticleDoc, type SubEmitterRef } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const ol = (over: Partial<Layer["overLifetime"]["velocity"]> = {}): Layer["overLifetime"] => ({
  size: null,
  color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
  rotation: null,
  velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null, ...over },
});
const init = (life: number, speed = 0): Layer["initial"] => ({
  life: { mode: "constant", value: life },
  speed: { mode: "constant", value: speed },
  size: { mode: "constant", value: 1 },
  rotation: { mode: "constant", value: 0 },
  angularVelocity: { mode: "constant", value: 0 },
});
const emit = (over: Partial<Layer["emission"]> = {}): Layer["emission"] => ({
  rateOverTime: { mode: "constant", value: 0 },
  rateOverDistance: null,
  bursts: [],
  delay: 0,
  prewarm: false,
  maxParticles: 1000,
  ...over,
});
const burst = (count: number, time = 0): Layer["emission"]["bursts"][number] => ({
  time,
  count,
  spread: 0,
  cycles: 1,
  interval: 0,
  probability: 1,
});
const sub = (trigger: SubEmitterRef["trigger"], layerId: string, count: number): SubEmitterRef => ({
  trigger,
  layerId,
  count,
  probability: 1,
  inheritVelocity: 0,
});
function base(over: Partial<Layer> = {}): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    space: "local",
    inheritVelocity: 0,
    emission: emit(),
    initial: init(1),
    overLifetime: ol(),
    ...over,
  });
}
function doc(layers: Layer[], over: Partial<ParticleDoc> = {}): ParticleDoc {
  return makeDoc({ layers, looping: false, duration: 1, ...over });
}
// Live velX of every particle in a layer, ascending.
const velXs = (fx: Effect, li = 0): number[] => {
  const p = fx.layers[li]!.pool;
  return Array.from({ length: p.count }, (_, i) => p.velX[i]!).sort((a, b) => a - b);
};

// ---------------------------------------------------------------------------
// S-1 — a layer disabled mid-flight must still age its live particles out.
// ---------------------------------------------------------------------------
describe("S-1 — a layer disabled mid-flight ages out and the effect completes", () => {
  const reproDoc = () =>
    doc([base({ id: "a", name: "a", emission: emit({ bursts: [burst(24)] }), initial: init(0.5) })], { duration: 1 });

  it("live particles age out, particleCount reaches 0, isDone flips and onDone fires once", () => {
    const fx = new Effect(reproDoc(), { seed: 1337 });
    let onDoneCalls = 0;
    fx.onDone = () => onDoneCalls++;
    for (let i = 0; i < 6; i++) fx.step(1 / 60); // burst is alive, ~0.1s of life spent
    expect(fx.particleCount).toBe(24);

    // The undocumented-but-public mutation S-1/S-3 need (no shipped surface does
    // this; the editor rebuilds the Effect on mute).
    fx.doc.layers[0]!.enabled = false;

    for (let i = 0; i < 600; i++) fx.step(1 / 60);
    // RED pre-fix: 24 frozen particles forever, isDone false, onDone never fired.
    expect(fx.particleCount).toBe(0);
    expect(fx.isDone).toBe(true);
    expect(onDoneCalls).toBe(1);
  });

  it("re-enabling a layer that already drained resumes normally (no stuck state)", () => {
    const fx = new Effect(reproDoc(), { seed: 1337 });
    for (let i = 0; i < 6; i++) fx.step(1 / 60);
    fx.doc.layers[0]!.enabled = false;
    for (let i = 0; i < 60; i++) fx.step(1 / 60); // drains (life 0.5s)
    expect(fx.particleCount).toBe(0);
    fx.doc.layers[0]!.enabled = true;
    fx.step(1 / 60);
    expect(fx.particleCount).toBe(0); // the burst already fired this cycle; nothing new
    expect(fx.isDone).toBe(true);
  });

  it("determinism guard: ageing a never-enabled layer is a byte-exact no-op", () => {
    // A doc that SHIPS a disabled layer alongside an enabled one — the only way
    // `enabled:false` is reachable without host mutation. Such a layer never emits
    // (emitInterval/emitDistance skip it) and never receives sub-emitter children
    // (S-2 drops the ref at plan-build), so its pool is permanently empty and the
    // now-unconditional update() is a hoist-only no-op with zero PRNG draws. This
    // digest was captured on the PRE-FIX runtime: it must not move.
    const live = base({ id: "live", name: "live", emission: emit({ rateOverTime: { mode: "constant", value: 300 } }), initial: init(2) });
    const muted = base({ id: "muted", name: "muted", enabled: false, emission: emit({ rateOverTime: { mode: "constant", value: 300 } }), initial: init(2) });
    const fx = new Effect(doc([live, muted], { duration: 3 }), { seed: 99 });
    for (const dt of dtSequence(4242, 40)) fx.step(dt);
    expect(fx.layers[0]!.count).toBeGreaterThan(50);
    expect(fx.layers[1]!.count).toBe(0); // the muted layer holds nothing, ever
    expect(stateHash(fx)).toBe("fb270747");
  });
});

// ---------------------------------------------------------------------------
// S-3 — a disabled parent must stop replaying its last step's events.
// ---------------------------------------------------------------------------
describe("S-3 — a disabled parent stops replaying sub-emitter events", () => {
  it("child count stops growing once the parent is muted mid-flight", () => {
    const parent = base({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "c", 3)],
      emission: emit({ bursts: [burst(8)], maxParticles: 64 }),
      initial: init(0.2), // the 8 parents all die around step 12
    });
    const child = base({ id: "c", name: "c", emission: emit({ maxParticles: 400 }), initial: init(0.15) });
    const fx = new Effect(doc([parent, child], { duration: 2 }), { seed: 7 });
    let onDoneCalls = 0;
    fx.onDone = () => onDoneCalls++;

    // Step past the parents' death so the death-event scratch is non-empty on the
    // step we mute (that is exactly the stale record S-3 replayed).
    let peakChild = 0;
    for (let i = 0; i < 13; i++) {
      fx.step(1 / 60);
      peakChild = Math.max(peakChild, fx.layers[1]!.count);
    }
    expect(peakChild).toBeGreaterThan(0); // deaths did fire children

    fx.doc.layers[0]!.enabled = false;
    for (let i = 0; i < 600; i++) {
      fx.step(1 / 60);
      peakChild = Math.max(peakChild, fx.layers[1]!.count);
    }
    // At most 8 parents × 3 children = 24 can ever exist. RED pre-fix: the muted
    // parent replayed its last death events (+8 children/frame per the audit)
    // until the child pool pinned at its 400 cap and never drained.
    expect(peakChild).toBeLessThanOrEqual(24);
    expect(fx.layers[1]!.count).toBe(0);
    expect(fx.layers[0]!.count).toBe(0);
    expect(fx.isDone).toBe(true);
    expect(onDoneCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S-4 — step(NaN) must be rejected, not integrated.
// ---------------------------------------------------------------------------
describe("S-4 — step(NaN) is a no-op, not a permanent poison", () => {
  const nanDoc = () => doc([base({ id: "a", name: "a", emission: emit({ bursts: [burst(24)] }), initial: init(0.5) })], { duration: 1 });

  it("leaves the clock and every particle finite, and the effect still completes", () => {
    const fx = new Effect(nanDoc(), { seed: 1337 });
    for (let i = 0; i < 6; i++) fx.step(1 / 60);
    const tBefore = fx.time;
    const xBefore = Array.from(fx.layers[0]!.pool.x.subarray(0, fx.layers[0]!.count));

    fx.step(NaN);

    // RED pre-fix: NaN < clamp and NaN <= 0 are both false, so NaN integrated into
    // x/y/age of all 24 particles — immortal, isDone false forever.
    expect(fx.time).toBe(tBefore);
    expect(Array.from(fx.layers[0]!.pool.x.subarray(0, fx.layers[0]!.count))).toEqual(xBefore);
    for (let i = 0; i < fx.particleCount; i++) expect(Number.isFinite(fx.layers[0]!.pool.x[i]!)).toBe(true);

    for (let i = 0; i < 600; i++) fx.step(1 / 60);
    expect(fx.particleCount).toBe(0);
    expect(fx.isDone).toBe(true);
  });

  it("NaN / ±Infinity-scaled / 0 / negative dt all leave the state byte-identical", () => {
    const poisoned = new Effect(nanDoc(), { seed: 1337 });
    const clean = new Effect(nanDoc(), { seed: 1337 });
    const seq = dtSequence(11, 30);
    for (const dt of seq) {
      poisoned.step(NaN);
      poisoned.step(0);
      poisoned.step(-1);
      poisoned.step(-Infinity);
      poisoned.step(dt);
      clean.step(dt);
    }
    expect(stateHash(poisoned)).toBe(stateHash(clean));
  });

  it("E2/E1 unchanged: +Infinity still clamps to MAX_DT (not rejected)", () => {
    const a = new Effect(doc([base({ id: "a", name: "a", emission: emit({ rateOverTime: { mode: "constant", value: 100 } }), initial: init(100) })], { duration: 10 }), { seed: 5 });
    const b = new Effect(doc([base({ id: "a", name: "a", emission: emit({ rateOverTime: { mode: "constant", value: 100 } }), initial: init(100) })], { duration: 10 }), { seed: 5 });
    a.step(Infinity);
    b.step(MAX_DT);
    expect(a.time).toBeCloseTo(MAX_DT, 12);
    expect(stateHash(a)).toBe(stateHash(b));
  });
});

// ---------------------------------------------------------------------------
// S-5 — the MAX_DT clamp must also clamp emitter-derived velocity + distance.
// ---------------------------------------------------------------------------
describe("S-5 — a clamped step scales the emitter's simulated displacement", () => {
  // World-space, inheritVelocity 1, zero launch speed: a spawned particle's velX
  // IS the emitter velocity the sim computed for the step.
  const moverDoc = (em: Partial<Layer["emission"]> = {}) =>
    doc([
      base({
        id: "w",
        name: "w",
        space: "world",
        inheritVelocity: 1,
        emission: emit({ rateOverTime: { mode: "constant", value: 200 }, ...em }),
        initial: init(100),
      }),
    ], { duration: 100 });

  it("inherited velocity is the emitter's TRUE speed, not rawDt/MAX_DT × it", () => {
    const fx = new Effect(moverDoc(), { seed: 3 });
    fx.setEmitterPosition(2000, 0);
    fx.step(0.5); // rawDt 0.5 ⇒ clamped to MAX_DT (0.05); scale = 0.1
    // Intended: 2000px in 0.5s = 4000 px/s.
    // RED pre-fix: 2000 / 0.05 = 40000 px/s (10× — the audit's inflation).
    for (const v of velXs(fx)) expect(v).toBeCloseTo(4000, 6);
    // Frame anchors are deliberately untouched by this fix: the emitter really
    // did reach (2000,0), spawn positions still lerp across the whole segment
    // (gap-free trail), and emitterX still reports the committed target.
    expect(fx.emitterX).toBe(2000);
    expect(fx.emitterY).toBe(0);
    const p = fx.layers[0]!.pool;
    const xs = Array.from({ length: p.count }, (_, i) => p.x[i]!).sort((a, b) => a - b);
    expect(xs[0]!).toBeLessThan(200);
    expect(xs[xs.length - 1]!).toBeGreaterThan(1800);
  });

  it("rate-over-distance emits for the simulated arc length, not the full move", () => {
    const fx = new Effect(
      moverDoc({ rateOverTime: { mode: "constant", value: 0 }, rateOverDistance: { mode: "constant", value: 0.1 } }),
      { seed: 3 },
    );
    fx.setEmitterPosition(2000, 0);
    fx.step(0.5);
    // Simulated arc = 2000 × (0.05/0.5) = 200px ⇒ 0.1/px = 20 particles, still
    // spread evenly across the whole 2000px path (density scales, coverage does
    // not). RED pre-fix: 0.1 × 2000 = 200 particles dumped in one frame.
    expect(fx.particleCount).toBe(20);
    const p = fx.layers[0]!.pool;
    const xs = Array.from({ length: p.count }, (_, i) => p.x[i]!).sort((a, b) => a - b);
    expect(xs[xs.length - 1]! - xs[0]!).toBeGreaterThan(1800);
  });

  it("no-op below the clamp: dt == MAX_DT keeps the full, unscaled displacement", () => {
    const fx = new Effect(moverDoc(), { seed: 3 });
    fx.setEmitterPosition(2000, 0);
    fx.step(MAX_DT); // exactly at the clamp ⇒ the scale branch must NOT run
    for (const v of velXs(fx)) expect(v).toBeCloseTo(2000 / MAX_DT, 6);
    expect(fx.emitterX).toBe(2000);
  });

  it("byte-identity pin: a normal moving-emitter run is unchanged by the S-5 fix", () => {
    // Every dt here is < MAX_DT, so the clamp never fires and the emitter path is
    // simulated in full. This digest was captured on the PRE-FIX runtime; if the
    // S-5 branch ever leaks into an unclamped step it moves.
    const fx = new Effect(
      moverDoc({ rateOverTime: { mode: "constant", value: 300 }, rateOverDistance: { mode: "constant", value: 0.05 } }),
      { seed: 20260815 },
    );
    const seq = dtSequence(777, 60);
    let px = 0;
    let py = 0;
    for (let i = 0; i < seq.length; i++) {
      px += 13 * Math.cos(i * 0.37);
      py += 9 * Math.sin(i * 0.53);
      fx.setEmitterPosition(px, py);
      fx.step(seq[i]!);
    }
    expect(fx.particleCount).toBeGreaterThan(50);
    expect(stateHash(fx)).toBe("25330319");
  });
});
