import { describe, it, expect } from "vitest";
import { LayerSim, Effect, deriveLayerSeed, type Layer, type CollisionConfig, type ScalarTrack } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);
const ct = (value: number): ScalarTrack => ({ mode: "constant", value });

// A single-particle layer whose ONLY forces are the ones a test asks for: point
// shape, zero launch speed, effectively infinite life (unless overridden), and no
// over-lifetime motion. Collision + optional gravity are merged in. Tests spawn
// one particle and then overwrite its position/velocity directly.
function collideLayer(collision: CollisionConfig, extra: Partial<Layer["overLifetime"]["velocity"]> = {}, life = 100): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    initial: {
      life: { mode: "constant", value: life },
      speed: { mode: "constant", value: 0 },
      size: { mode: "constant", value: 1 },
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: null,
      color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
      rotation: null,
      velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null, ...extra },
    },
    collision,
  });
}

// Spawn one particle and place it at a chosen state. Returns the sim + index 0.
function one(layer: Layer): LayerSim {
  const ls = new LayerSim(layer, seed);
  expect(ls.spawn()).toBe(true);
  return ls;
}

describe("collision floor — reflect exactness (M7)", () => {
  it("a particle crossing the floor in one step clamps, reflects vy by bounce, dampens vx, and loses life", () => {
    const ls = one(collideLayer({ shape: { kind: "floor", y: 0 }, bounce: 0.5, dampen: 0.25, lifetimeLoss: 0.06 }));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = -5;
    ls.pool.velX[0] = 40;
    ls.pool.velY[0] = 100; // moving down (y-down); base step takes y to +5, past the floor
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 100;

    ls.update(0.1); // base integration: y = -5 + 100*0.1 = 5 > 0 && vy > 0 ⇒ resolve

    expect(ls.pool.y[0]!).toBe(0); // clamped exactly to the floor
    expect(ls.pool.velY[0]!).toBe(-50); // -vy·bounce = -(100)(0.5)
    expect(ls.pool.velX[0]!).toBe(30); // vx·(1-dampen) = 40·0.75
    // age = 0 + dt + lifetimeLoss·lifetime = 0.1 + 0.06·100 = 6.1
    expect(ls.pool.age[0]!).toBeCloseTo(6.1, 6);
  });

  it("no crossing ⇒ no resolve (velocity and age untouched by the branch)", () => {
    const ls = one(collideLayer({ shape: { kind: "floor", y: 100 }, bounce: 0.5, dampen: 0.5, lifetimeLoss: 0.5 }));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = -5;
    ls.pool.velX[0] = 40;
    ls.pool.velY[0] = 100;
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 100;
    ls.update(0.1); // y -> 5, still far above the floor at y=100
    expect(ls.pool.velX[0]!).toBe(40);
    expect(ls.pool.velY[0]!).toBe(100);
    expect(ls.pool.age[0]!).toBeCloseTo(0.1, 6); // no lifetimeLoss added
  });
});

describe("collision floor — energy loss (M7)", () => {
  it("with bounce < 1, successive bounce apexes get lower (monotone)", () => {
    // Floor at y=0, downward gravity, thrown upward (negative y) from the floor.
    const ls = one(collideLayer({ shape: { kind: "floor", y: 0 }, bounce: 0.6, dampen: 0, lifetimeLoss: 0 }, { gravity: { x: 0, y: 600 } }));
    ls.pool.x[0] = 0;
    ls.pool.y[0] = 0;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = -260; // up
    ls.pool.age[0] = 0;
    ls.pool.lifetime[0] = 100;

    const apexes: number[] = [];
    let prevVy = ls.pool.velY[0]!;
    for (let i = 0; i < 400; i++) {
      ls.update(1 / 120);
      const vy = ls.pool.velY[0]!;
      // Apex: velocity crosses from up (<0) to down (>0) without a collision — the
      // highest point (most-negative y) of a hop.
      if (prevVy < 0 && vy >= 0) apexes.push(ls.pool.y[0]!);
      prevVy = vy;
    }
    expect(apexes.length).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < apexes.length; k++) {
      // Later apexes are lower ⇒ their y (negative, up) is closer to 0.
      expect(apexes[k]!).toBeGreaterThan(apexes[k - 1]!);
    }
  });
});

describe("collision floor — bounce extremes (M7)", () => {
  const cross = (bounce: number): LayerSim => {
    const ls = one(collideLayer({ shape: { kind: "floor", y: 0 }, bounce, dampen: 0, lifetimeLoss: 0 }));
    ls.pool.y[0] = -1;
    ls.pool.velY[0] = 100;
    ls.pool.lifetime[0] = 100;
    ls.update(0.05); // y -> 4, crosses
    return ls;
  };

  it("bounce 0 sticks: normal velocity is zeroed", () => {
    const ls = cross(0);
    expect(ls.pool.y[0]!).toBe(0);
    // -vy·0 is IEEE -0; a stuck particle has zero normal speed either sign.
    expect(Math.abs(ls.pool.velY[0]!)).toBe(0);
  });

  it("bounce 1 is a perfect reflect: |vy| preserved", () => {
    const ls = cross(1);
    expect(ls.pool.y[0]!).toBe(0);
    expect(Math.abs(ls.pool.velY[0]!)).toBe(100);
    expect(ls.pool.velY[0]!).toBe(-100);
  });
});

describe("collision rect — keep-inside, all faces + corner (M7)", () => {
  // Anchor is top-left: faces left=-100, right=100, top=-100, bottom=100.
  const rect: CollisionConfig["shape"] = { kind: "rect", x: -100, y: -100, width: 200, height: 200 };
  const mk = (): LayerSim => {
    const ls = one(collideLayer({ shape: rect, bounce: 0.5, dampen: 0.2, lifetimeLoss: 0 }));
    ls.pool.lifetime[0] = 100;
    return ls;
  };

  it("right face reflects inward", () => {
    const ls = mk();
    ls.pool.x[0] = 90;
    ls.pool.velX[0] = 300; // base x -> 120, past right face
    ls.update(0.1);
    expect(ls.pool.x[0]!).toBe(100);
    expect(ls.pool.velX[0]!).toBe(-150); // -300·0.5
  });

  it("left face reflects inward", () => {
    const ls = mk();
    ls.pool.x[0] = -90;
    ls.pool.velX[0] = -300;
    ls.update(0.1);
    expect(ls.pool.x[0]!).toBe(-100);
    expect(ls.pool.velX[0]!).toBe(150);
  });

  it("bottom face reflects inward", () => {
    const ls = mk();
    ls.pool.y[0] = 90;
    ls.pool.velY[0] = 300;
    ls.update(0.1);
    expect(ls.pool.y[0]!).toBe(100);
    expect(ls.pool.velY[0]!).toBe(-150);
  });

  it("top face reflects inward", () => {
    const ls = mk();
    ls.pool.y[0] = -90;
    ls.pool.velY[0] = -300;
    ls.update(0.1);
    expect(ls.pool.y[0]!).toBe(-100);
    expect(ls.pool.velY[0]!).toBe(150);
  });

  it("corner: both axes violated in one step resolve both this step", () => {
    const ls = mk();
    ls.pool.x[0] = 90;
    ls.pool.y[0] = 90;
    ls.pool.velX[0] = 300;
    ls.pool.velY[0] = 300; // base (120,120): past BOTH right and bottom faces
    ls.update(0.1);
    expect(ls.pool.x[0]!).toBe(100);
    expect(ls.pool.y[0]!).toBe(100);
    expect(ls.pool.velX[0]!).toBeLessThan(0); // reflected inward on x
    expect(ls.pool.velY[0]!).toBeLessThan(0); // reflected inward on y
  });
});

describe("collision lifetimeLoss kills (M7)", () => {
  it("enough accumulated loss pushes age past lifetime and the particle dies", () => {
    const bounce = (loss: number): LayerSim => {
      const ls = one(collideLayer({ shape: { kind: "floor", y: 0 }, bounce: 0.8, dampen: 0, lifetimeLoss: loss }, { gravity: { x: 0, y: 800 } }, 5));
      ls.pool.y[0] = 0;
      ls.pool.velY[0] = -300; // thrown up; will fall and bounce repeatedly
      ls.pool.age[0] = 0;
      ls.pool.lifetime[0] = 5;
      return ls;
    };
    // lifetimeLoss 0.4 ⇒ each bounce adds 0.4·5 = 2.0 to age; a few bounces exceed 5.
    const lossy = bounce(0.4);
    for (let i = 0; i < 150 && lossy.count > 0; i++) lossy.update(1 / 60);
    expect(lossy.count).toBe(0);

    // Control: same window, no lifetimeLoss ⇒ natural age (~2.5 s) < life 5 ⇒ alive.
    const control = bounce(0);
    for (let i = 0; i < 150; i++) control.update(1 / 60);
    expect(control.count).toBe(1);
  });
});

describe("collision — null pin & zero-draw pin (M7)", () => {
  it("non-null collision adds ZERO spawn draws (stream identical to a collision-null twin)", () => {
    const col: CollisionConfig = { shape: { kind: "rect", x: -50, y: -50, width: 100, height: 100 }, bounce: 0.5, dampen: 0.3, lifetimeLoss: 0.1 };
    const nullTwin = new LayerSim(makeLayer(), seed);
    const colTwin = new LayerSim(makeLayer({ collision: col }), seed);
    for (let k = 0; k < 50; k++) {
      nullTwin.spawn();
      colTwin.spawn();
    }
    expect(colTwin.count).toBe(nullTwin.count);
    const n = nullTwin.count;
    expect(Array.from(colTwin.pool.rand0.slice(0, n))).toEqual(Array.from(nullTwin.pool.rand0.slice(0, n)));
    expect(Array.from(colTwin.pool.velX.slice(0, n))).toEqual(Array.from(nullTwin.pool.velX.slice(0, n)));
    expect(Array.from(colTwin.pool.x.slice(0, n))).toEqual(Array.from(nullTwin.pool.x.slice(0, n)));
  });

  it("a collision that never contacts is byte-identical to a collision-null layer", () => {
    // Floor far below, downward gravity: the branch is entered every step but never
    // resolves, so the trajectory must match a collision-null twin exactly.
    const grav = { gravity: { x: 0, y: 300 } };
    const nullSim = one(collideLayerNoCollision(grav));
    const colSim = one(collideLayer({ shape: { kind: "floor", y: 1e6 }, bounce: 0.5, dampen: 0.5, lifetimeLoss: 0.5 }, grav));
    for (const ls of [nullSim, colSim]) {
      ls.pool.y[0] = 0;
      ls.pool.velY[0] = 20;
      ls.pool.velX[0] = 10;
      ls.pool.lifetime[0] = 100;
    }
    for (let i = 0; i < 200; i++) {
      nullSim.update(1 / 90);
      colSim.update(1 / 90);
    }
    expect(colSim.pool.x[0]!).toBe(nullSim.pool.x[0]!);
    expect(colSim.pool.y[0]!).toBe(nullSim.pool.y[0]!);
    expect(colSim.pool.velY[0]!).toBe(nullSim.pool.velY[0]!);
    expect(colSim.pool.age[0]!).toBe(nullSim.pool.age[0]!);
  });
});

// A collision-null variant of collideLayer for the "never contacts" pin.
function collideLayerNoCollision(extra: Partial<Layer["overLifetime"]["velocity"]>): Layer {
  const l = collideLayer({ shape: { kind: "floor", y: 0 }, bounce: 0, dampen: 0, lifetimeLoss: 0 }, extra);
  l.collision = null;
  return l;
}

describe("collision — two-run bit-identity (M7)", () => {
  it("two runs with a colliding layer are bit-identical over 300 mixed-dt steps", () => {
    const doc = makeDoc({
      layers: [
        makeLayer({
          shape: { kind: "cone", direction: -90, spread: 50, radius: 5, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
          initial: {
            life: { mode: "range", min: 0.6, max: 1.6 },
            speed: { mode: "range", min: 200, max: 420 },
            size: { mode: "constant", value: 4 },
            rotation: { mode: "range", min: 0, max: 360 },
            angularVelocity: { mode: "range", min: -120, max: 120 },
          },
          overLifetime: {
            size: null,
            color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
            rotation: null,
            velocity: { gravity: { x: 0, y: 500 }, drag: ct(0.4), speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
          },
          collision: { shape: { kind: "floor", y: 80 }, bounce: 0.5, dampen: 0.2, lifetimeLoss: 0.05 },
        }),
      ],
    });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(7, 300);
    const checkpoints = new Set([1, 60, 150, 300]);
    for (let i = 1; i <= 300; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
  });
});

describe("collision — event scratch (M7 hook for M8)", () => {
  it("default (flag off): a resolved collision records nothing and allocates no array", () => {
    const ls = one(collideLayer({ shape: { kind: "floor", y: 0 }, bounce: 0.5, dampen: 0.2, lifetimeLoss: 0 }));
    ls.pool.y[0] = -1;
    ls.pool.velY[0] = 100;
    ls.pool.lifetime[0] = 100;
    ls.update(0.05); // resolves a collision
    expect(ls.recordCollisionEvents).toBe(false);
    expect(ls.collisionEvents).toBeNull(); // never allocated
  });

  it("flag on: a resolved collision appends exactly one event with the POST-resolve values", () => {
    const ls = one(collideLayer({ shape: { kind: "floor", y: 0 }, bounce: 0.5, dampen: 0.25, lifetimeLoss: 0 }));
    ls.recordCollisionEvents = true;
    ls.pool.x[0] = 7;
    ls.pool.y[0] = -1;
    ls.pool.velX[0] = 40;
    ls.pool.velY[0] = 100;
    ls.pool.lifetime[0] = 100;
    ls.update(0.05); // base: x -> 9, y -> 4 (crosses); resolve clamps y=0, vy=-50, vx=30

    expect(ls.collisionEvents).not.toBeNull();
    const ev = ls.collisionEvents!;
    expect(ev.length).toBe(5); // exactly one quintuple [x, y, vxAfter, vyAfter, ordinal]
    expect(ev[0]!).toBe(9); // base-integrated x (7 + 40·0.05); the floor never clamps x
    expect(ev[1]!).toBe(0); // y clamped to floor
    expect(ev[2]!).toBe(30); // vx dampened (40·0.75)
    expect(ev[3]!).toBe(-50); // vy reflected (-100·0.5)
    expect(ev[4]!).toBe(0); // ordinal placeholder = live index

    // A subsequent step with no contact clears the scratch back to empty.
    ls.pool.velY[0] = -10; // move up, away from the floor
    ls.update(0.01);
    expect(ls.collisionEvents!.length).toBe(0);
  });
});

describe("collision — update-order pin (resolve runs on the base position, before VoL) (M7)", () => {
  it("the floor clamp sees the base-integrated position, not the post-orbital one", () => {
    // Orbital would rotate the particle off the floor; because collision resolves
    // the BASE-integrated position FIRST, the bounce still fires (event y = floor),
    // and the orbital track THEN pushes the point back below the floor that same
    // step — the accepted normative behavior (collision resolves only the base
    // integration position).
    const ls = one(collideLayer({ shape: { kind: "floor", y: 0 }, bounce: 0.5, dampen: 0, lifetimeLoss: 0 }, { orbital: ct(90) }));
    ls.recordCollisionEvents = true;
    ls.pool.x[0] = 50;
    ls.pool.y[0] = -5;
    ls.pool.velX[0] = 0;
    ls.pool.velY[0] = 100; // base y = -5 + 100·0.1 = 5, crosses the floor
    ls.pool.lifetime[0] = 100;

    ls.update(0.1);

    const ev = ls.collisionEvents!;
    expect(ev.length).toBe(5);
    expect(ev[1]!).toBe(0); // resolve clamped the base position to the floor
    expect(ev[3]!).toBe(-50); // and reflected vy
    // Orbital rotated the clamped offset (50,0) by +9° AFTER the resolve, so the
    // final y is no longer on the floor — proving VoL runs strictly after collision.
    expect(ls.pool.y[0]!).not.toBe(0);
    expect(ls.pool.y[0]!).toBeGreaterThan(0);
  });
});
