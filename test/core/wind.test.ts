import { describe, it, expect } from "vitest";
import { Effect, LayerSim, deriveLayerSeed, type Layer, type ParticleDoc, type ParamDef, type WindConfig, type ScalarTrack } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

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

  // ── WINDP (schemaVersion 11): host-param bindings ──────────────────────────
  // windStrengthMul (multiplier, identity 1) folds into the hoisted gust;
  // windDirOffsetDeg (degree offset, identity 0) rotates the vector before cos/sin.
  it("windStrengthMul scales the per-step wind delta exactly (2× doubles it)", () => {
    // Steady wind (gustAmount 0 ⇒ gust 1 exactly), direction 0, constant strength —
    // so the delta is S·mul·dt and a mul of 2 is an exact ×2 (power-of-two, no
    // rounding). Proves the strength-param multiplier applies at the hoist.
    const wind: WindConfig = w({ direction: 0, strength: ct(100), gustFrequency: 0, gustAmount: 0 });
    const base = new LayerSim(windLayer(wind), seed);
    expect(base.spawn()).toBe(true);
    base.setClock(0);
    base.update(0.02);
    const dBase = base.pool.velX[0]!; // = 100 · 1 · 0.02 = 2

    const scaled = new LayerSim(windLayer(wind), seed);
    scaled.windStrengthMul = 2;
    expect(scaled.spawn()).toBe(true);
    scaled.setClock(0);
    scaled.update(0.02);
    expect(scaled.pool.velX[0]!).toBe(2 * dBase); // exact doubling
    expect(dBase).toBe(2); // sanity: the base delta is what we expect
  });

  it("windDirOffsetDeg rotates the wind vector BEFORE cos/sin (90° offset swaps the axis exactly)", () => {
    // Base direction 0 (pure +x). Offset 90 ⇒ effective 90 ⇒ pure +y (y-down frame):
    // the offset must be added to the direction, not to the components. Steady wind
    // so the delta is purely the direction basis.
    const S = 100;
    const dt = 0.02;
    const off = new LayerSim(windLayer(w({ direction: 0, strength: ct(S), gustFrequency: 0, gustAmount: 0 })), seed);
    off.windDirOffsetDeg = 90;
    expect(off.spawn()).toBe(true);
    off.setClock(0);
    off.update(dt);
    expect(off.pool.velX[0]!).toBeCloseTo(S * Math.cos(90 * RAD) * dt, 6); // ≈ 0
    expect(off.pool.velY[0]!).toBeCloseTo(S * Math.sin(90 * RAD) * dt, 6); // = S·dt
    // An offset of 90 on base 0 is BIT-IDENTICAL to a natively-authored direction 90
    // (0 + 90 === 90 + 0), proving the offset composes into the same angle.
    const native = new LayerSim(windLayer(w({ direction: 90, strength: ct(S), gustFrequency: 0, gustAmount: 0 })), seed);
    expect(native.spawn()).toBe(true);
    native.setClock(0);
    native.update(dt);
    expect(off.pool.velX[0]!).toBe(native.pool.velX[0]!);
    expect(off.pool.velY[0]!).toBe(native.pool.velY[0]!);
  });

  it("identity defaults are exact IEEE no-ops: mul 1 / offset 0 ≡ the untouched hoist (bit-identical)", () => {
    // The load-bearing invariant: a bound-at-identity sim is byte-identical to the
    // pre-v11 wind. Curve strength + gust + non-axis-aligned direction to exercise
    // the full product; mul 1 and offset 0 must not perturb a single bit.
    const wind: WindConfig = w({ direction: 37, strength: curve(10, 90), gustFrequency: 0.6, gustAmount: 0.5 });
    const plain = new LayerSim(windLayer(wind), seed);
    const ident = new LayerSim(windLayer(wind), seed);
    ident.windStrengthMul = 1;
    ident.windDirOffsetDeg = 0;
    expect(plain.spawn()).toBe(true);
    expect(ident.spawn()).toBe(true);
    for (const c of [0.05, 0.2, 0.5, 0.9]) {
      plain.setClock(c);
      plain.update(0.02);
      ident.setClock(c);
      ident.update(0.02);
    }
    expect(ident.pool.velX[0]!).toBe(plain.pool.velX[0]!);
    expect(ident.pool.velY[0]!).toBe(plain.pool.velY[0]!);
  });

  // ── WINDP Effect-level binding: resolution + event-driven push ─────────────
  const P = (over: Partial<ParamDef> = {}): ParamDef => ({ kind: "scalar", name: "wind", default: 1, min: 0, max: 4, ...over });
  // A one-layer wind doc; `bind` names the param wired into windStrengthParam (null
  // = unbound). Steady wind so the strength param is the only per-instance variable.
  function windDoc(bind: string | null, params: ParamDef[]): ParticleDoc {
    const wind = w({ direction: 0, strength: ct(100), gustFrequency: 0, gustAmount: 0 });
    wind.windStrengthParam = bind;
    return makeDoc({ layers: [windLayer(wind)], params, looping: false, duration: 100 });
  }
  const drive = (fx: Effect, n: number): void => {
    const dts = dtSequence(7, n);
    for (let i = 0; i < n; i++) fx.step(dts[i]!);
  };

  it("determinism law: an identity-bound doc (param default 1) is digest-identical to the unbound doc", () => {
    // hasParams flips true for the bound doc (it declares a param), so pushParamMuls
    // now runs — but every resolved value is identity, so the whole 60-step digest
    // must match the unbound (hasParams false) control. This is the identity proof.
    const bound = new Effect(windDoc("wind", [P()]), { seed: 1337 });
    const unbound = new Effect(windDoc(null, []), { seed: 1337 });
    drive(bound, 60);
    drive(unbound, 60);
    expect(stateHash(bound)).toBe(stateHash(unbound));
  });

  it("unknown / dangling binding behaves like the A9 knobs: resolves to identity (digest-identical to unbound)", () => {
    // windStrengthParam names a param that is NOT declared, while an unrelated param
    // IS declared (so hasParams is true and paramMul actually runs the lookup). The
    // undeclared name resolves to null ⇒ the identity path, exactly as a dangling
    // sizeParam takes the untouched v5 path. Digest matches the unbound control.
    const dangling = new Effect(windDoc("ghost", [P({ name: "other" })]), { seed: 1337 });
    const unbound = new Effect(windDoc(null, []), { seed: 1337 });
    drive(dangling, 60);
    drive(unbound, 60);
    expect(stateHash(dangling)).toBe(stateHash(unbound));
  });

  it("setParam mid-run drives the NEXT step's hoist (event-driven push, not retroactive)", () => {
    const fx = new Effect(windDoc("wind", [P()]), { seed: 1337 });
    const ident = new Effect(windDoc("wind", [P()]), { seed: 1337 });
    // Identical for the first 20 steps (both at default 1).
    const dts = dtSequence(7, 40);
    for (let i = 0; i < 20; i++) {
      fx.step(dts[i]!);
      ident.step(dts[i]!);
    }
    expect(stateHash(fx)).toBe(stateHash(ident));
    // Bump fx's param, then step BOTH once: fx must diverge on this next step (the
    // new multiplier reached the hoist), proving the push is event-driven and the
    // change takes effect prospectively.
    fx.setParam("wind", 3);
    fx.step(dts[20]!);
    ident.step(dts[20]!);
    expect(stateHash(fx)).not.toBe(stateHash(ident));
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
