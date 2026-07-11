import { describe, it, expect } from "vitest";
import { LayerSim, deriveLayerSeed, type Layer, type ByEmitterSpeedConfig, type ScalarTrack } from "../../src/index.js";
import { makeLayer } from "../format/_helpers.js";

const seed = deriveLayerSeed(1337, 0);
const ct = (value: number): ScalarTrack => ({ mode: "constant", value });
const curve = (a: number, b: number): ScalarTrack => ({ mode: "curve", keys: [{ t: 0, v: a }, { t: 1, v: b }] });

// A single-particle layer with CONSTANT initials (so the drawn size/speed/life are
// exact, seed-independent) and a byEmitterSpeed config merged in. Point shape, no
// gravity/drag, so right after spawn the pool holds exactly the baked spawn values:
// sizeInit = size, lifetime = life, and √(velX²+velY²) = speed.
function besLayer(byEmitterSpeed: ByEmitterSpeedConfig | null, base = { life: 2, speed: 100, size: 10 }): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    initial: {
      life: { mode: "constant", value: base.life },
      lifeParam: null,
      speed: { mode: "constant", value: base.speed },
      speedParam: null,
      size: { mode: "constant", value: base.size },
      sizeParam: null,
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: null,
      color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
      rotation: null,
      velocity: { gravity: { x: 0, y: 0 }, gravityParam: null, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
    byEmitterSpeed,
  });
}

// Spawn one particle with a chosen emitter velocity pushed via setEmitterStep, and
// report the baked spawn state.
function spawnWithEmitterVel(byEmitterSpeed: ByEmitterSpeedConfig | null, evx: number, evy: number, base?: { life: number; speed: number; size: number }): { size: number; life: number; speed: number } {
  const ls = new LayerSim(besLayer(byEmitterSpeed, base), seed);
  ls.setEmitterStep(0, 0, 0, 0, evx, evy); // emVX/emVY = (evx, evy)
  expect(ls.spawn()).toBe(true);
  return {
    size: ls.pool.sizeInit[0]!,
    life: ls.pool.lifetime[0]!,
    speed: Math.hypot(ls.pool.velX[0]!, ls.pool.velY[0]!),
  };
}

describe("byEmitterSpeed — spawn-time multiply from emitter speed (B5)", () => {
  it("scales the drawn size/speed/life by the track at the emitter-speed-normalized t", () => {
    // range {0,400}: an emitter at speed 200 → t = 0.5. Linear curves 0.5→1.5 land
    // at 1.0 (mid); a constant track applies flat. emVX=200, emVY=0 ⇒ emSpeed 200.
    const bes: ByEmitterSpeedConfig = { range: { min: 0, max: 400 }, size: curve(0.5, 1.5), speed: ct(1.25), life: curve(0.5, 1.5) };
    const out = spawnWithEmitterVel(bes, 200, 0);
    expect(out.size).toBeCloseTo(10 * 1.0, 6); // 10 × curve(0.5) = 10
    expect(out.life).toBeCloseTo(2 * 1.0, 6); //  2 × curve(0.5) = 2
    expect(out.speed).toBeCloseTo(100 * 1.25, 4); // 100 × const 1.25 = 125
  });

  it("evaluates emitter speed as √(emVX²+emVY²) (both components contribute)", () => {
    // (120, 160) → speed 200 → t = 0.5 with range {0,400}. A diagonal emitter must
    // give the same t as a 200-along-x emitter (proves the magnitude, not a lone axis).
    const bes: ByEmitterSpeedConfig = { range: { min: 0, max: 400 }, size: curve(0, 2), speed: null, life: null };
    expect(spawnWithEmitterVel(bes, 120, 160).size).toBeCloseTo(10 * 1.0, 6); // curve(0.5) = 1 ⇒ ×1
    expect(spawnWithEmitterVel(bes, 200, 0).size).toBeCloseTo(10 * 1.0, 6);
  });

  it("clamps t to the range ends (below min → t0, above max → t1)", () => {
    const bes: ByEmitterSpeedConfig = { range: { min: 100, max: 300 }, size: curve(0.5, 1.5), speed: null, life: null };
    expect(spawnWithEmitterVel(bes, 50, 0).size).toBeCloseTo(10 * 0.5, 6); // below min → t0 → 0.5
    expect(spawnWithEmitterVel(bes, 500, 0).size).toBeCloseTo(10 * 1.5, 6); // above max → t1 → 1.5
    expect(spawnWithEmitterVel(bes, 200, 0).size).toBeCloseTo(10 * 1.0, 6); // mid → t0.5 → 1.0
  });

  it("min === max is a HARD STEP at the shared bound, matching the bySpeed ruling", () => {
    // render.ts bySpeed degenerate: `tSpeed = speed >= bsMax ? 1 : 0`. Mirror exactly:
    // below the bound → t0, at/above → t1. size curve 0.5→1.5 makes the step visible.
    const bes: ByEmitterSpeedConfig = { range: { min: 200, max: 200 }, size: curve(0.5, 1.5), speed: null, life: null };
    expect(spawnWithEmitterVel(bes, 199, 0).size).toBeCloseTo(10 * 0.5, 6); // below → t0
    expect(spawnWithEmitterVel(bes, 200, 0).size).toBeCloseTo(10 * 1.5, 6); // at bound → t1
    expect(spawnWithEmitterVel(bes, 250, 0).size).toBeCloseTo(10 * 1.5, 6); // above → t1
  });

  it("a static emitter (emVX/emVY = 0) evaluates at t = 0", () => {
    // The inert-in-static-preview reality: no setEmitterStep motion ⇒ emSpeed 0 ⇒ t0.
    const bes: ByEmitterSpeedConfig = { range: { min: 0, max: 300 }, size: curve(0.4, 1.7), speed: null, life: curve(0.7, 1.6) };
    const out = spawnWithEmitterVel(bes, 0, 0);
    expect(out.size).toBeCloseTo(10 * 0.4, 6); // curve at t0 = 0.4
    expect(out.life).toBeCloseTo(2 * 0.7, 6); // curve at t0 = 0.7
  });

  it("composes with the A9 param multiply — order pinned (byEmitterSpeed BEFORE param), result identical either way (commute)", () => {
    // Both multiply the same drawn scalar. The code applies byEmitterSpeed FIRST,
    // then lifeParamMul/speedParamMul (TIERB T4, documented at the spawn site). The
    // product is base × bes × param regardless of order; this test pins the composed
    // value so a future reorder that broke the pinned SEMANTICS (not just arithmetic)
    // would still be caught by the surrounding size/life/speed assertions.
    const bes: ByEmitterSpeedConfig = { range: { min: 0, max: 200 }, size: null, speed: ct(2), life: ct(3) };
    const ls = new LayerSim(besLayer(bes), seed);
    ls.lifeParamMul = 5; // A9 host lifeParam bound at 5
    ls.speedParamMul = 7; // A9 host speedParam bound at 7
    ls.setEmitterStep(0, 0, 0, 0, 200, 0); // emSpeed 200 ⇒ t1 (range {0,200})
    expect(ls.spawn()).toBe(true);
    // life  = 2   × bes.life(3)   × lifeParamMul(5)  = 30
    // speed = 100 × bes.speed(2)  × speedParamMul(7) = 1400
    expect(ls.pool.lifetime[0]!).toBeCloseTo(2 * 3 * 5, 4);
    expect(Math.hypot(ls.pool.velX[0]!, ls.pool.velY[0]!)).toBeCloseTo(100 * 2 * 7, 2);
  });

  it("a null byEmitterSpeed ignores emitter speed entirely (determinism law: null path unchanged)", () => {
    // With no module, a fast-moving emitter must produce the SAME baked spawn values
    // as a static one — the null-gated branch is never entered, so no digest can move.
    const still = spawnWithEmitterVel(null, 0, 0);
    const fast = spawnWithEmitterVel(null, 5000, 5000);
    expect(fast.size).toBe(still.size);
    expect(fast.life).toBe(still.life);
    expect(fast.speed).toBeCloseTo(still.speed, 6);
    // And they are exactly the plain drawn constants (no scaling at all).
    expect(still.size).toBe(10);
    expect(still.life).toBe(2);
    expect(still.speed).toBeCloseTo(100, 4);
  });

  it("only the non-null tracks scale; a null channel leaves its scalar untouched", () => {
    // size responds, speed/life do not — the per-channel null gate.
    const bes: ByEmitterSpeedConfig = { range: { min: 0, max: 100 }, size: ct(3), speed: null, life: null };
    const out = spawnWithEmitterVel(bes, 100, 0); // t1
    expect(out.size).toBeCloseTo(10 * 3, 6);
    expect(out.speed).toBeCloseTo(100, 4); // unscaled
    expect(out.life).toBeCloseTo(2, 6); // unscaled
  });
});
