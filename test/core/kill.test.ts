import { describe, it, expect } from "vitest";
import { LayerSim, Effect, deriveLayerSeed, type Layer, type CollisionConfig, type Rect, type AttractorConfig, type ScalarTrack } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);
const ct = (value: number): ScalarTrack => ({ mode: "constant", value });

// A single-particle layer with no forces except the ones a test opts into. Point
// shape, zero launch speed, no gravity/drag (so the pre-impact velocity is exactly
// whatever the test writes into the pool — the motion loop leaves it untouched),
// long life unless overridden. collision / killZones / attractor merged in.
function killLayer(opts: {
  collision?: CollisionConfig | null;
  killZones?: Rect[] | null;
  attractor?: AttractorConfig | null;
  gravity?: { x: number; y: number };
  subEmitters?: Layer["subEmitters"];
  life?: number;
}): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    initial: {
      life: { mode: "constant", value: opts.life ?? 100 },
      lifeParam: null,
      speed: { mode: "constant", value: 0 },
      speedParam: null,
      size: { mode: "constant", value: 1 },
      sizeParam: null,
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: null,
      color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
      rotation: null,
      velocity: { gravity: opts.gravity ?? { x: 0, y: 0 }, gravityParam: null, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
    collision: opts.collision ?? null,
    killZones: opts.killZones ?? null,
    attractor: opts.attractor ?? null,
    subEmitters: opts.subEmitters ?? null,
  });
}

function one(layer: Layer): LayerSim {
  const ls = new LayerSim(layer, seed);
  expect(ls.spawn()).toBe(true);
  return ls;
}

// A collision config with the v10 kill fields explicit.
function floorCollision(over: Partial<CollisionConfig> = {}): CollisionConfig {
  return { shape: { kind: "floor", y: 0 }, bounce: 0.5, dampen: 0.25, lifetimeLoss: 0, killOnCollide: false, minKillSpeed: 0, ...over };
}

// --- B3 killOnCollide / minKillSpeed --------------------------------------

describe("killOnCollide — speed-gated kill (B3)", () => {
  // Drive one particle into a one-step floor crossing with a chosen PRE-impact
  // speed (velX = 0 ⇒ speed = |velY| exactly, no gravity to perturb it), and
  // report whether it was killed (count === 0) or bounced (count === 1).
  const strike = (velY: number, minKillSpeed: number): LayerSim => {
    const ls = one(killLayer({ collision: floorCollision({ killOnCollide: true, minKillSpeed }) }));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = -1;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = velY; // pre-impact speed = |velY|
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 100;
    ls.update(0.05); // base y = -1 + velY·0.05; crosses the floor at y=0 for velY ≥ 20
    return ls;
  };

  it("pre-impact speed ABOVE the threshold shatters (dies this step)", () => {
    expect(strike(140, 100).count).toBe(0);
  });

  it("pre-impact speed BELOW the threshold bounces (survives, reflects normally)", () => {
    const ls = strike(80, 100); // 80 < 100
    expect(ls.count).toBe(1);
    expect(ls.pool.y[0]!).toBe(0); // clamped to the floor
    expect(ls.pool.velY[0]!).toBe(-40); // -80·bounce(0.5): the ordinary M7 reflect, untouched
  });

  it("pre-impact speed EXACTLY at the threshold shatters (>= semantics, boundary KILLS)", () => {
    // 0² + 100² ⇒ speed 100.0 exactly (IEEE-exact sqrt(10000)); threshold 100.
    expect(strike(100, 100).count).toBe(0);
  });

  it("just under the threshold bounces (the boundary is closed on the kill side only)", () => {
    expect(strike(100, 100.0001).count).toBe(1);
  });

  it("minKillSpeed 0 kills on any contact (a crawling hit still shatters)", () => {
    expect(strike(30, 0).count).toBe(0); // speed 30 ≥ 0
  });

  it("killOnCollide false never kills (the branch is not entered) — ordinary bounce", () => {
    const ls = one(killLayer({ collision: floorCollision({ killOnCollide: false, minKillSpeed: 0 }) }));
    ls.pool.y[0] = -1;
    ls.pool.velY[0] = 400; // very fast, but killOnCollide is off
    ls.pool.lifetime[0] = 100;
    ls.update(0.05);
    expect(ls.count).toBe(1); // survives — false gate skips the kill
    expect(ls.pool.velY[0]!).toBe(-200); // -400·0.5, a plain reflect
  });
});

describe("killOnCollide — pre-impact speed is read BEFORE the reflect (B3)", () => {
  it("the gate uses the incoming speed, not the post-bounce (reflected/dampened) speed", () => {
    // Incoming speed 100; bounce 0.5 would drop it to 50 AFTER the reflect. With a
    // threshold of 90, reading the POST-reflect speed (50) would WRONGLY spare the
    // particle. Reading the PRE-impact speed (100 ≥ 90) correctly kills it — this
    // pins that the speed is sampled before the reflect writes vy.
    const ls = one(killLayer({ collision: floorCollision({ bounce: 0.5, killOnCollide: true, minKillSpeed: 90 }) }));
    ls.pool.y[0] = -1;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 100;
    ls.pool.lifetime[0] = 100;
    ls.update(0.05);
    expect(ls.count).toBe(0); // killed on the PRE-impact 100, not spared by the post-reflect 50
  });
});

// --- B3 killZones ----------------------------------------------------------

describe("killZones — containment death region (B3)", () => {
  // Zone covering [-50, 50] × [-50, 50] (x∈[x, x+width], y∈[y, y+height]).
  const zone: Rect = { x: -50, y: -50, width: 100, height: 100 };
  // Place a motionless particle at (px, py); the post-integration position equals
  // (px, py), so the containment test decides its fate directly.
  const place = (px: number, py: number, zones: Rect[] = [zone]): LayerSim => {
    const ls = one(killLayer({ killZones: zones }));
    ls.pool.x[0] = px;
    ls.pool.y[0] = py;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 0;
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 100;
    ls.update(0.05);
    return ls;
  };

  it("a particle inside a kill zone dies this step", () => {
    expect(place(0, 0).count).toBe(0);
  });

  it("a particle outside every kill zone survives", () => {
    expect(place(120, 0).count).toBe(1);
  });

  it("the boundary is INCLUSIVE — a particle exactly on the far corner is contained (killed)", () => {
    // x = zone.x + width = 50, y = zone.y + height = 50: the max corner. The test is
    // `k <= x+width` / `k <= y+height`, so the closed edge is INSIDE ⇒ killed.
    expect(place(50, 50).count).toBe(0);
    // The near corner (min x/y) is likewise inclusive.
    expect(place(-50, -50).count).toBe(0);
  });

  it("just outside the far edge survives (edge-exactness is one-sided)", () => {
    expect(place(50.0001, 0).count).toBe(1);
  });

  it("first-containment across multiple zones still kills exactly once (no double-decrement matters — it dies)", () => {
    const zoneB: Rect = { x: 40, y: -20, width: 60, height: 40 }; // overlaps near x=50
    // (50, 0) is inside BOTH zones; the loop breaks on the first, and the particle dies.
    expect(place(50, 0, [zone, zoneB]).count).toBe(0);
  });

  it("killZones null is inert — a particle sitting where a zone WOULD be lives", () => {
    const ls = one(killLayer({ killZones: null }));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = 0;
    ls.pool.lifetime[0] = 100;
    ls.update(0.05);
    expect(ls.count).toBe(1);
  });
});

// --- B3 double-event (collision + death, same step, same ordinal) ----------

describe("killOnCollide — records BOTH a collision and a death event this step (B3 double-event)", () => {
  it("a shattering hit pushes a collision event AND a death event carrying the STABLE ordinal", () => {
    // subEmitters non-null ⇒ the pool allocates the stable-ordinal column. We drive
    // one recorded particle into a killOnCollide floor hit with both recorders armed.
    const layer = killLayer({
      collision: floorCollision({ bounce: 0.5, dampen: 0.25, killOnCollide: true, minKillSpeed: 0 }),
      subEmitters: [{ trigger: "death", layerId: "x", count: 1, probability: 1, inheritVelocity: 0, inheritColor: false, inheritSize: false, inheritRotation: false }],
    });
    const ls = one(layer);
    ls.recordCollisionEvents = true;
    ls.recordDeathEvents = true;
    // Overwrite the ordinal with a distinctive value (42) that differs from the live
    // index (0): if either event recorded the live index instead of the stable
    // ordinal (the M7/M8 ordinal-reuse bug class), the assertions below would read 0.
    ls.pool.ordinal![0] = 42;
    ls.pool.x[0] = 7;
    ls.pool.y[0] = -1;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 120; // pre-impact speed 120 ≥ 0 ⇒ shatters
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 100;

    ls.update(0.05); // base y = -1 + 120·0.05 = 5 > 0 ⇒ hit; killOnCollide ⇒ dies this step

    expect(ls.count).toBe(0); // the particle shattered

    // Collision event: exactly one quintuple [x, y, vxAfter, vyAfter, ordinal].
    expect(ls.collisionEvents).not.toBeNull();
    const col = ls.collisionEvents!;
    expect(col.length).toBe(5);
    expect(col[1]!).toBe(0); // y clamped to floor (the collision still resolved)
    expect(col[3]!).toBe(-60); // vy reflected (-120·0.5) — the bounce write still happens
    expect(col[4]!).toBe(42); // STABLE ordinal, not the live index 0

    // Death event: exactly one quintuple, SAME stable ordinal, SAME step.
    expect(ls.deathEvents).not.toBeNull();
    const death = ls.deathEvents!;
    expect(death.length).toBe(5);
    expect(death[4]!).toBe(42); // same stable ordinal as the collision event
  });
});

// --- B3 ageLoss accumulation composes -------------------------------------

describe("ageLoss composition — the kill accumulator sums, it does not overwrite (B3)", () => {
  // An attractor whose killRadius engulfs the particle (adds a full lifetime to
  // ageLoss) but whose force is inert (strength 0, and the particle sits AT the
  // center so d < 1e-6 skips the force entirely).
  const engulfingAttractor: AttractorConfig = { x: 0, y: -1, strength: ct(0), tangential: null, radius: 0, falloff: "none", killRadius: 50 };

  it("collision lifetimeLoss ALONE (0.5·life) does not kill in one step — the survivor baseline", () => {
    const ls = one(killLayer({ collision: floorCollision({ lifetimeLoss: 0.5, killOnCollide: false }), life: 1 }));
    ls.pool.y[0] = -1;
    ls.pool.velY[0] = 100;
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 1;
    ls.update(0.05); // age → 0.05 + 0.5·1 = 0.55 < 1 ⇒ survives
    expect(ls.count).toBe(1);
    expect(ls.pool.age[0]!).toBeCloseTo(0.55, 6);
  });

  it("lifetimeLoss (0.5·life) + attractor killRadius (1·life) COMPOSE past lifetime ⇒ death", () => {
    // Same 0.5-lifetimeLoss collision, now ALSO inside the killRadius: the two
    // ageLoss contributions accumulate (0.5·life + 1·life = 1.5·life ≥ life), so the
    // particle that survived on lifetimeLoss alone now dies. If the collision kill
    // path OVERWROTE the killRadius contribution (a `=` bug), the outcome/age would
    // differ; the `+=` accumulator makes them fold into one lethal step.
    const ls = one(killLayer({ collision: floorCollision({ lifetimeLoss: 0.5, killOnCollide: false }), attractor: engulfingAttractor, life: 1 }));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = -1;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 100;
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 1;
    ls.update(0.05);
    expect(ls.count).toBe(0); // composed ageLoss (0.5 + 1)·life ⇒ dead
  });

  it("killOnCollide (1·life) stacks ON TOP of a lifetimeLoss collision in the same block ⇒ death, event still records", () => {
    const layer = killLayer({
      collision: floorCollision({ lifetimeLoss: 0.5, killOnCollide: true, minKillSpeed: 0 }),
      subEmitters: [{ trigger: "collision", layerId: "x", count: 1, probability: 1, inheritVelocity: 0, inheritColor: false, inheritSize: false, inheritRotation: false }],
    });
    const ls = one(layer);
    ls.recordCollisionEvents = true;
    ls.pool.y[0] = -1;
    ls.pool.velY[0] = 100;
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 1;
    ls.update(0.05);
    expect(ls.count).toBe(0); // dies (0.5·life from lifetimeLoss + 1·life from killOnCollide)
    expect(ls.collisionEvents!.length).toBe(5); // the collision was STILL recorded before the kill
  });
});

// --- B3 determinism law: false/null gates are inert -----------------------

describe("killOnCollide false + killZones null are digest-identical to a doc without the kill knobs (B3)", () => {
  it("a colliding effect is bit-identical whether or not the (inert) kill knobs are populated", () => {
    // Baseline: a colliding fountain with the migration defaults (killOnCollide
    // false, minKillSpeed 0, killZones null).
    const baseLayer = (killZones: Rect[] | null, minKillSpeed: number): Layer =>
      makeLayer({
        shape: { kind: "cone", direction: -90, spread: 50, radius: 5, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
        initial: {
          life: { mode: "range", min: 0.6, max: 1.6 },
          lifeParam: null,
          speed: { mode: "range", min: 200, max: 420 },
          speedParam: null,
          size: { mode: "constant", value: 4 },
          sizeParam: null,
          rotation: { mode: "range", min: 0, max: 360 },
          angularVelocity: { mode: "range", min: -120, max: 120 },
        },
        overLifetime: {
          size: null,
          color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
          rotation: null,
          velocity: { gravity: { x: 0, y: 500 }, gravityParam: null, drag: ct(0.4), speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
        },
        // killOnCollide FALSE in both docs; the twin merely populates minKillSpeed and
        // a far-off kill zone the particle can never reach. Both must be inert.
        collision: { shape: { kind: "floor", y: 80 }, bounce: 0.5, dampen: 0.2, lifetimeLoss: 0.05, killOnCollide: false, minKillSpeed },
        killZones,
      });

    const docA = makeDoc({ layers: [baseLayer(null, 0)] });
    // Twin: killOnCollide still false (so minKillSpeed is never read), plus a kill
    // zone parked far off-screen where no particle integrates. Both gates stay unentered.
    const docB = makeDoc({ layers: [baseLayer([{ x: 100000, y: 100000, width: 10, height: 10 }], 9999)] });

    const a = new Effect(docA, { seed: 1337 });
    const b = new Effect(docB, { seed: 1337 });
    const dts = dtSequence(7, 300);
    const checkpoints = new Set([1, 60, 150, 300]);
    for (let i = 1; i <= 300; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
  });
});
