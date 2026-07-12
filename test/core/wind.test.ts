import { describe, it, expect } from "vitest";
import { LayerSim, deriveLayerSeed, type Layer, type WindConfig, type ScalarTrack } from "../../src/index.js";
import { makeLayer } from "../format/_helpers.js";

const seed = deriveLayerSeed(1337, 0);
const ct = (value: number): ScalarTrack => ({ mode: "constant", value });
const curve = (a: number, b: number): ScalarTrack => ({ mode: "curve", keys: [{ t: 0, v: a }, { t: 1, v: b }] });
const RAD = Math.PI / 180;
// WINDP (schemaVersion 11): the wind literals below omit the two param bindings;
// `w` fills them as null (unbound = the pre-v11 behavior these sim tests assert).
const w = (o: Omit<WindConfig, "windStrengthParam" | "windDirectionParam">): WindConfig =>
  ({ ...o, windStrengthParam: null, windDirectionParam: null });

// A single-point layer with ZERO initial speed and ZERO gravity/drag, so after a
// spawn every particle sits at velocity 0 and update() writes ONLY the wind
// contribution into the stored velocity. lifetime is large so particles survive
// long multi-step runs. Extra overrides let a test add drag etc.
function windLayer(wind: WindConfig | null, velExtra: Record<string, unknown> = {}): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    initial: {
      life: ct(100000),
      lifeParam: null,
      speed: ct(0),
      speedParam: null,
      size: ct(10),
      sizeParam: null,
      rotation: ct(0),
      angularVelocity: ct(0),
    },
    overLifetime: {
      size: null,
      color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
      rotation: null,
      velocity: { gravity: { x: 0, y: 0 }, gravityParam: null, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null, ...velExtra },
    },
    wind,
  });
}

// Spawn `n` particles at clock 0, then run ONE update(dt) at the given clock and
// return the LayerSim (pool holds the wind-only stored velocity).
function stepOnce(wind: WindConfig | null, clock: number, dt: number, n = 1): LayerSim {
  const ls = new LayerSim(windLayer(wind), seed);
  for (let k = 0; k < n; k++) expect(ls.spawn()).toBe(true);
  ls.setClock(clock);
  ls.update(dt);
  return ls;
}

describe("wind — coherent gusting directional force (B6)", () => {
  it("is position-independent: two particles at different positions get an IDENTICAL wind delta (coherence law)", () => {
    const wind: WindConfig = w({ direction: 30, strength: ct(80), gustFrequency: 0.5, gustAmount: 0.4 });
    const ls = new LayerSim(windLayer(wind), seed);
    expect(ls.spawn()).toBe(true);
    expect(ls.spawn()).toBe(true);
    // Same age (both freshly spawned ⇒ ageNorm 0), deliberately DIFFERENT positions.
    ls.pool.x[0] = -500;
    ls.pool.y[0] = -420;
    ls.pool.x[1] = 900;
    ls.pool.y[1] = 300;
    ls.setClock(0.37);
    ls.update(0.02);
    // Wind reads no position, so both stored velocities are bit-identical.
    expect(ls.pool.velX[0]!).toBe(ls.pool.velX[1]!);
    expect(ls.pool.velY[0]!).toBe(ls.pool.velY[1]!);
    // And they are the coherent vector, not zero (sanity: wind actually fired).
    expect(Math.abs(ls.pool.velX[0]!)).toBeGreaterThan(0);
  });

  it("gust is exactly 1 + gustAmount·sin(2π·gustFrequency·clock) (sine exactness)", () => {
    // gustFrequency 0.5, clock 0.5 ⇒ sin(2π·0.5·0.5) = sin(π/2) = 1 ⇒ gust = 1.4.
    // direction 0 ⇒ cos 1 / sin 0; strength constant 100; dt 0.02.
    const S = 100;
    const dt = 0.02;
    const ls = stepOnce(w({ direction: 0, strength: ct(S), gustFrequency: 0.5, gustAmount: 0.4 }), 0.5, dt);
    expect(ls.pool.velX[0]!).toBeCloseTo(S * 1.4 * dt, 5); // 100 × 1.4 × 0.02 = 2.8
    expect(ls.pool.velY[0]!).toBeCloseTo(0, 6);
  });

  it("applies the direction basis via cos/sin of degrees (direction 90 ⇒ +y in the y-down frame)", () => {
    const S = 100;
    const dt = 0.02;
    const dir = 90;
    // gustFrequency 0 ⇒ gust 1 (steady), so the delta is purely the direction basis.
    const ls = stepOnce(w({ direction: dir, strength: ct(S), gustFrequency: 0, gustAmount: 0.5 }), 0.3, dt);
    expect(ls.pool.velX[0]!).toBeCloseTo(S * Math.cos(dir * RAD) * dt, 5); // ≈ 0
    expect(ls.pool.velY[0]!).toBeCloseTo(S * Math.sin(dir * RAD) * dt, 5); // = S·dt
  });

  it("evaluates strength at each particle's ageNorm (authorable ease-in over life)", () => {
    // A curve strength 0→100 over ageNorm; direction 0, steady gust. Two particles
    // at DIFFERENT ages in the SAME step must get deltas proportional to strength(t).
    const wind: WindConfig = w({ direction: 0, strength: curve(0, 100), gustFrequency: 0, gustAmount: 0 });
    const ls = new LayerSim(windLayer(wind), seed);
    expect(ls.spawn()).toBe(true);
    expect(ls.spawn()).toBe(true);
    const lifetime = ls.pool.lifetime[0]!;
    ls.pool.age[0] = 0.25 * lifetime; // ageNorm 0.25 ⇒ strength 25
    ls.pool.age[1] = 0.75 * lifetime; // ageNorm 0.75 ⇒ strength 75
    const dt = 0.02;
    ls.setClock(0);
    ls.update(dt);
    expect(ls.pool.velX[0]!).toBeCloseTo(25 * dt, 5);
    expect(ls.pool.velX[1]!).toBeCloseTo(75 * dt, 5);
    // The ratio is exactly 25:75 = 1:3 (per-particle ageNorm evaluation).
    expect(ls.pool.velX[1]! / ls.pool.velX[0]!).toBeCloseTo(3, 4);
  });

  it("gustAmount 0 ⇒ steady wind (gust = 1 at every clock)", () => {
    const wind: WindConfig = w({ direction: 0, strength: ct(100), gustFrequency: 2, gustAmount: 0 });
    const dt = 0.02;
    const a = stepOnce(wind, 0.1, dt).pool.velX[0]!;
    const b = stepOnce(wind, 0.6, dt).pool.velX[0]!; // different clock
    expect(a).toBe(b); // no gust modulation ⇒ identical regardless of clock
    expect(a).toBeCloseTo(100 * dt, 5); // gust exactly 1
  });

  it("gustFrequency 0 ⇒ steady wind (sin(0) = 0, gust = 1)", () => {
    const wind: WindConfig = w({ direction: 0, strength: ct(100), gustFrequency: 0, gustAmount: 0.9 });
    const dt = 0.02;
    const a = stepOnce(wind, 0.1, dt).pool.velX[0]!;
    const b = stepOnce(wind, 5.3, dt).pool.velX[0]!;
    expect(a).toBe(b);
    expect(a).toBeCloseTo(100 * dt, 5); // 1 + 0.9·sin(0) = 1
  });

  it("a null wind leaves the stored velocity exactly at the gravity result (determinism law: null path unchanged)", () => {
    // No wind, no gravity ⇒ velocity stays 0 after any number of steps. The
    // null-gated branch is never entered, so no existing digest can move.
    const ls = new LayerSim(windLayer(null), seed);
    expect(ls.spawn()).toBe(true);
    for (let s = 0; s < 10; s++) {
      ls.setClock(s * 0.05);
      ls.update(0.02);
    }
    expect(ls.pool.velX[0]!).toBe(0);
    expect(ls.pool.velY[0]!).toBe(0);
  });

  it("composes with drag toward a bounded terminal drift (does not run away)", () => {
    // Steady wind S along +x, drag d. Per step: v ← (v + S·dt)·(1 − d·dt). The fixed
    // point is v* = S(1 − d·dt)/d — a BOUNDED steady drift, proving drag damps wind
    // (wind is applied before the drag block, per the normative order).
    const S = 200;
    const d = 2;
    const dt = 0.02;
    const wind: WindConfig = w({ direction: 0, strength: ct(S), gustFrequency: 0, gustAmount: 0 });
    const ls = new LayerSim(windLayer(wind, { drag: ct(d) }), seed);
    expect(ls.spawn()).toBe(true);
    let prev = 0;
    for (let s = 0; s < 800; s++) {
      ls.setClock(0);
      ls.update(dt);
      prev = ls.pool.velX[0]!;
    }
    const terminal = (S * (1 - d * dt)) / d; // = 96
    expect(prev).toBeCloseTo(terminal, 3); // converged to the bounded fixed point
    // One more step barely moves it (steady state reached, no runaway).
    ls.update(dt);
    expect(Math.abs(ls.pool.velX[0]! - prev)).toBeLessThan(1e-3);
  });

  it("scrub-resim determinism: the same (clock, dt) sequence yields bit-identical state", () => {
    const wind: WindConfig = w({ direction: 37, strength: curve(10, 90), gustFrequency: 0.6, gustAmount: 0.5 });
    const clocks = [0.05, 0.1, 0.17, 0.31, 0.5, 0.72, 0.9];
    const dt = 0.02;
    const run = (): { vx: number; vy: number; x: number; y: number } => {
      const ls = new LayerSim(windLayer(wind), seed);
      expect(ls.spawn()).toBe(true);
      expect(ls.spawn()).toBe(true);
      for (const c of clocks) {
        ls.setClock(c);
        ls.update(dt);
      }
      return { vx: ls.pool.velX[0]!, vy: ls.pool.velY[0]!, x: ls.pool.x[0]!, y: ls.pool.y[0]! };
    };
    expect(run()).toEqual(run()); // identical inputs ⇒ identical frames
  });
});
