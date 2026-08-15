import { describe, it, expect } from "vitest";
import { LayerSim, Effect, deriveLayerSeed, mulberry32, validateParticle, type Layer, type SubEmitterRef } from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

// An independent copy of the child-stream seed formula (§0.2). Duplicated on
// purpose: if the production formula in effect.ts drifts (constants, operand
// order, imul vs *), the golden assertions here break — that is the protection.
const SEED_MIX_ORDINAL = 0x9e3779b9;
const SEED_MIX_EVENTCODE = 0x85ebca6b;
const SEED_MIX_REFINDEX = 0xc2b2ae35; // S-7
const eventSeedOf = (parentLayerSeed: number, ordinal: number, eventCode: number, refIndex = 0): number =>
  (parentLayerSeed ^
    Math.imul(ordinal + 1, SEED_MIX_ORDINAL) ^
    Math.imul(eventCode, SEED_MIX_EVENTCODE) ^
    Math.imul(refIndex, SEED_MIX_REFINDEX)) >>>
  0;

const sub = (
  trigger: SubEmitterRef["trigger"],
  layerId: string,
  count: number,
  probability = 1,
  inheritVelocity = 0,
): SubEmitterRef => ({ trigger, layerId, count, probability, inheritVelocity });

// Full nested-object builders (makeLayer replaces these wholesale on override).
const ol = (
  over: Partial<Layer["overLifetime"]["velocity"]> = {},
  size: Layer["overLifetime"]["size"] = null,
): Layer["overLifetime"] => ({
  size,
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
  maxParticles: 200,
  ...over,
});
const burst = (count: number, time = 0): Layer["emission"]["bursts"][number] => ({ time, count, spread: 0, cycles: 1, interval: 0, probability: 1 });

// A child layer: point shape, zero launch speed, emits ONLY via events by default
// (rateOverTime 0), so any particle it holds proves a trigger fired.
function childLayer(id: string, over: Partial<Layer> = {}): Layer {
  return makeLayer({
    id,
    name: id,
    shape: { kind: "point", emitFrom: "volume" },
    emission: emit({ maxParticles: 400 }),
    initial: init(1),
    overLifetime: ol(),
    ...over,
  });
}

describe("sub-emitters — child-stream seed formula (§0.2, M8)", () => {
  it("eventSeed golden values are stable (guards the mix constants against drift)", () => {
    // refIndex 0 (the default) reproduces the PRE-S-7 goldens unchanged — that is the
    // no-op property the amendment promises: `imul(0, k) === 0` and `x ^ 0 === x`.
    expect(eventSeedOf(deriveLayerSeed(1337, 0), 0, 2)).toBe(2514544726);
    expect(eventSeedOf(deriveLayerSeed(1337, 0), 5, 1)).toBe(816256260);
    expect(eventSeedOf(deriveLayerSeed(4242, 1), 3, 3)).toBe(1999188974);
    expect(eventSeedOf(deriveLayerSeed(1337, 0), 0, 2, 0)).toBe(2514544726);
    // refIndex ≥ 1 diverges, and distinct indices stay distinct (imul by an odd
    // constant is injective mod 2^32).
    expect(eventSeedOf(deriveLayerSeed(1337, 0), 0, 2, 1)).toBe(1465009763);
    expect(eventSeedOf(deriveLayerSeed(1337, 0), 0, 2, 2)).toBe(277197884);
    // The derived stream's first draws are exactly mulberry32(eventSeed).
    const rng = mulberry32(2514544726);
    expect(rng()).toBeCloseTo(0.976087756222114, 15);
    expect(rng()).toBeCloseTo(0.5685831855516881, 15);
  });

  it("a real death-triggered child matches spawnFrom(mulberry32(eventSeed)) — production uses the formula", () => {
    const parent = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "c", 1)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(1)] }),
      initial: init(0.2), // dies ~step 13, ordinal 0 (the only spawn)
      overLifetime: ol(),
    });
    const child = childLayer("c");
    const doc = makeDoc({ duration: 2, looping: false, layers: [parent, child] });
    const fx = new Effect(doc, { seed: 1337 });
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);

    // Reference: the child config spawned from the event stream directly. Parent
    // dies at rest at the origin ⇒ ox/oy/bvx/bvy all 0 (local→local, zero velocity).
    const eventSeed = eventSeedOf(deriveLayerSeed(1337, 0), 0, 2 /* death */);
    const ref = new LayerSim(childLayer("c"), deriveLayerSeed(999, 5)); // its own seed is irrelevant to spawnFrom
    expect(ref.spawnFrom(mulberry32(eventSeed), 0, 0, 0, 0)).toBe(true);

    const c = fx.layers[1]!.pool;
    expect(c.rand0[0]).toBe(ref.pool.rand0[0]);
    expect(c.rand1[0]).toBe(ref.pool.rand1[0]);
    expect(c.velX[0]).toBe(ref.pool.velX[0]);
    expect(c.velY[0]).toBe(ref.pool.velY[0]);
    expect(c.x[0]).toBe(ref.pool.x[0]);
    expect(c.y[0]).toBe(ref.pool.y[0]);
  });
});

describe("sub-emitters — each trigger fires (M8)", () => {
  it("death: children appear only when parents die", () => {
    const parent = makeLayer({
      id: "rocket",
      name: "rocket",
      subEmitters: [sub("death", "spark", 5)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(3)], maxParticles: 16 }),
      initial: init(0.2),
      overLifetime: ol(),
    });
    const doc = makeDoc({ duration: 2, looping: false, layers: [parent, childLayer("spark")] });
    const fx = new Effect(doc, { seed: 4242 });
    fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(0); // no deaths yet ⇒ no children
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      fx.step(1 / 60);
      peak = Math.max(peak, fx.layers[1]!.count);
    }
    expect(peak).toBe(15); // 3 rockets × 5 sparks each
  });

  it("birth: a continuous parent spawns children on every birth", () => {
    const parent = makeLayer({
      id: "src",
      name: "src",
      subEmitters: [sub("birth", "dust", 2)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ rateOverTime: { mode: "constant", value: 30 }, maxParticles: 64 }),
      initial: init(2),
      overLifetime: ol(),
    });
    const doc = makeDoc({ duration: 3, looping: false, layers: [parent, childLayer("dust")] });
    const fx = new Effect(doc, { seed: 77 });
    for (let i = 0; i < 30; i++) fx.step(1 / 60);
    // Every parent birth fires two children; with the parent emitting continuously
    // the child count tracks ~2× the parent births so far.
    expect(fx.layers[0]!.count).toBeGreaterThan(0);
    expect(fx.layers[1]!.count).toBeGreaterThanOrEqual(2 * fx.layers[0]!.count);
  });

  it("collision: a floor-bounce parent fires children on contact", () => {
    const parent = makeLayer({
      id: "ball",
      name: "ball",
      subEmitters: [sub("collision", "splash", 3)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(1)], maxParticles: 8 }),
      initial: init(100, 0),
      overLifetime: ol({ gravity: { x: 0, y: 400 } }),
      collision: { shape: { kind: "floor", y: 50 }, bounce: 0.5, dampen: 0, lifetimeLoss: 0 },
    });
    const doc = makeDoc({ duration: 3, looping: false, layers: [parent, childLayer("splash")] });
    const fx = new Effect(doc, { seed: 9 });
    for (let i = 0; i < 60; i++) fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBeGreaterThanOrEqual(3); // at least one bounce ⇒ ≥ 3 splashes
  });
});

describe("sub-emitters — child stream independence (M8)", () => {
  it("a child's OWN continuous stream is byte-identical with or without a parent firing into it", () => {
    const childCfg = (): Layer =>
      childLayer("c", {
        emission: emit({ rateOverTime: { mode: "constant", value: 40 }, maxParticles: 300 }),
        initial: init(1, 20),
        shape: { kind: "circle", radius: 5, innerRadius: 0, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
      });
    const parentBody = (subEmitters: SubEmitterRef[] | null): Layer =>
      makeLayer({
        id: "p",
        name: "p",
        subEmitters,
        shape: { kind: "point", emitFrom: "volume" },
        emission: emit({ bursts: [burst(4)], maxParticles: 16 }),
        initial: init(0.15),
        overLifetime: ol(),
      });
    // Twin A: parent fires into the child but with probability 0 (gate draws come
    // from the EVENT stream, never the child's). Twin B: parent has no sub-emitters.
    const withParent = makeDoc({ duration: 2, looping: false, layers: [parentBody([sub("death", "c", 8, 0)]), childCfg()] });
    const noParent = makeDoc({ duration: 2, looping: false, layers: [parentBody(null), childCfg()] });
    const a = new Effect(withParent, { seed: 1337 });
    const b = new Effect(noParent, { seed: 1337 });
    for (let i = 0; i < 120; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    const ca = a.layers[1]!;
    const cb = b.layers[1]!;
    expect(ca.count).toBe(cb.count);
    expect(ca.count).toBeGreaterThan(0);
    const n = ca.count;
    expect(Array.from(ca.pool.x.slice(0, n))).toEqual(Array.from(cb.pool.x.slice(0, n)));
    expect(Array.from(ca.pool.velX.slice(0, n))).toEqual(Array.from(cb.pool.velX.slice(0, n)));
    expect(Array.from(ca.pool.rand0.slice(0, n))).toEqual(Array.from(cb.pool.rand0.slice(0, n)));
  });
});

describe("sub-emitters — sibling refs are decorrelated (S-7)", () => {
  // The audit repro, INVERTED. Pre-fix the eventSeed mixed only (parentLayerSeed,
  // ordinal, eventCode), so two refs on ONE parent sharing a trigger drew a
  // bit-identical stream: same angle, radius, life, speed, size, rotation, tint,
  // flip bits — the canonical "on death spawn smoke AND sparks" fired both along
  // exactly the same rays. Folding the ref's AUTHORED index in decorrelates them
  // without touching determinism.

  // Two structurally IDENTICAL children (only the id differs), spawned on a circle
  // with a random direction so the shape draws actually reach x/y/velX.
  const spread = (id: string): Layer =>
    childLayer(id, {
      initial: init(5, 60),
      shape: { kind: "circle", radius: 30, innerRadius: 0, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
    });
  const twinParent = (subs: SubEmitterRef[]): Layer =>
    makeLayer({
      id: "p",
      name: "p",
      subEmitters: subs,
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(4)], maxParticles: 16 }),
      initial: init(0.2), // parents die ~step 12, four deaths ⇒ four events per ref
      overLifetime: ol(),
    });
  const twinDoc = (probability = 1): ReturnType<typeof makeDoc> =>
    makeDoc({
      duration: 2,
      looping: false,
      layers: [twinParent([sub("death", "a", 4, probability), sub("death", "b", 4, probability)]), spread("a"), spread("b")],
    });
  const runTwins = (seed: number, steps = 40): Effect => {
    const fx = new Effect(twinDoc(), { seed });
    for (let i = 0; i < steps; i++) fx.step(1 / 60);
    return fx;
  };

  it("two refs on one parent with the SAME trigger produce DIFFERENT child streams", () => {
    const fx = runTwins(1337);
    const a = fx.layers[1]!;
    const b = fx.layers[2]!;
    // Same number of children (the gate is open at probability 1) but different draws.
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);
    const n = a.count;
    const ax = Array.from(a.pool.x.slice(0, n));
    const bx = Array.from(b.pool.x.slice(0, n));
    const ar = Array.from(a.pool.rand0.slice(0, n));
    const br = Array.from(b.pool.rand0.slice(0, n));
    expect(ax).not.toEqual(bx); // RED pre-fix: bit-identical
    expect(ar).not.toEqual(br);
    // Not just "some element differs" — EVERY spawn is independently drawn.
    for (let i = 0; i < n; i++) expect(ar[i]).not.toBe(br[i]);
  });

  it("each decorrelated stream is still bit-stable across runs with the same seed", () => {
    const one = runTwins(1337);
    const two = runTwins(1337);
    for (const li of [1, 2]) {
      const x = one.layers[li]!;
      const y = two.layers[li]!;
      expect(x.count).toBe(y.count);
      const n = x.count;
      expect(Array.from(x.pool.x.slice(0, n))).toEqual(Array.from(y.pool.x.slice(0, n)));
      expect(Array.from(x.pool.rand0.slice(0, n))).toEqual(Array.from(y.pool.rand0.slice(0, n)));
    }
    expect(stateHash(one)).toBe(stateHash(two));
  });

  it("the ref at index 1 draws from mulberry32(eventSeed with refIndex 1) — production uses the amended formula", () => {
    // One parent particle (ordinal 0) dying at rest at the origin, two death refs.
    const parent = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "a", 1), sub("death", "b", 1)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(1)] }),
      initial: init(0.2),
      overLifetime: ol(),
    });
    const doc = makeDoc({ duration: 2, looping: false, layers: [parent, spread("a"), spread("b")] });
    const fx = new Effect(doc, { seed: 1337 });
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    expect(fx.layers[2]!.count).toBe(1);

    const parentSeed = deriveLayerSeed(1337, 0);
    for (const [layerIndex, refIndex, id] of [
      [1, 0, "a"],
      [2, 1, "b"],
    ] as const) {
      const ref = new LayerSim(spread(id), deriveLayerSeed(999, 5)); // own seed irrelevant to spawnFrom
      expect(ref.spawnFrom(mulberry32(eventSeedOf(parentSeed, 0, 2 /* death */, refIndex)), 0, 0, 0, 0)).toBe(true);
      // Spawn-time invariants only: the live child has integrated ~28 steps of its
      // launch velocity by now, so x/y have moved on; velocity is untouched (zero
      // gravity/drag) and rand0/rand1 are the raw drawn uniforms.
      const p = fx.layers[layerIndex]!.pool;
      expect(p.rand0[0]).toBe(ref.pool.rand0[0]);
      expect(p.rand1[0]).toBe(ref.pool.rand1[0]);
      expect(p.velX[0]).toBe(ref.pool.velX[0]);
      expect(p.velY[0]).toBe(ref.pool.velY[0]);
    }
  });

  it("the probability gate is no longer all-or-nothing across siblings (seed 5, fixed expectation)", () => {
    // probability 0.5 on BOTH refs, one parent particle ⇒ ONE death event ⇒ exactly
    // one gate draw per ref. Pre-fix both refs drew the same number, so the counts
    // were always (4,4) or (0,0) — never split. Seed 5 is a FIXED case where the two
    // gates disagree (ref 0 blocked, ref 1 open); the assertion is exact, not
    // statistical — the same seed always yields the same split.
    const parent = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "a", 4, 0.5), sub("death", "b", 4, 0.5)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(1)] }),
      initial: init(0.2),
      overLifetime: ol(),
    });
    const doc = makeDoc({ duration: 2, looping: false, layers: [parent, spread("a"), spread("b")] });
    const fx = new Effect(doc, { seed: 5 });
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect([fx.layers[1]!.count, fx.layers[2]!.count]).toEqual([0, 4]);
  });

  it("a MUTED sibling at index 0 does not reseed the enabled ref at index 1 (S-2 interaction)", () => {
    // The authored index is the seed input, so dropping ref 0 (its target is muted)
    // must leave ref 1's stream byte-identical. Guards the complement of the S-2 test
    // below, which pins the index-0 side.
    const build = (firstEnabled: boolean) =>
      makeDoc({
        duration: 2,
        looping: false,
        layers: [
          twinParent([sub("death", "a", 4), sub("death", "b", 4)]),
          childLayer("a", { enabled: firstEnabled, initial: init(5) }),
          spread("b"),
        ],
      });
    const withMuted = new Effect(build(false), { seed: 1337 });
    const withEnabled = new Effect(build(true), { seed: 1337 });
    for (let i = 0; i < 40; i++) {
      withMuted.step(1 / 60);
      withEnabled.step(1 / 60);
    }
    const m = withMuted.layers[2]!;
    const e = withEnabled.layers[2]!;
    expect(m.count).toBe(e.count);
    expect(m.count).toBeGreaterThan(0);
    const n = m.count;
    expect(Array.from(m.pool.x.slice(0, n))).toEqual(Array.from(e.pool.x.slice(0, n)));
    expect(Array.from(m.pool.rand0.slice(0, n))).toEqual(Array.from(e.pool.rand0.slice(0, n)));
    expect(withMuted.layers[1]!.count).toBe(0); // muted 'a' received nothing
  });
});

describe("sub-emitters — replay determinism (M8)", () => {
  it("a mixed death+collision graph is bit-identical across two runs over 600 mixed-dt steps", () => {
    const parent = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "a", 6, 1, 0.2), sub("collision", "b", 4, 0.7, 0.1)],
      shape: { kind: "cone", direction: -90, spread: 40, radius: 4, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
      emission: emit({ rateOverTime: { mode: "constant", value: 50 }, bursts: [burst(6)], maxParticles: 200 }),
      initial: {
        life: { mode: "range", min: 0.4, max: 1 },
        speed: { mode: "range", min: 120, max: 260 },
        size: { mode: "constant", value: 3 },
        rotation: { mode: "range", min: 0, max: 360 },
        angularVelocity: { mode: "range", min: -90, max: 90 },
      },
      overLifetime: ol({ gravity: { x: 0, y: 300 }, drag: { mode: "constant", value: 0.5 } }),
      collision: { shape: { kind: "floor", y: 120 }, bounce: 0.5, dampen: 0.2, lifetimeLoss: 0.05 },
    });
    const childA = childLayer("a", { initial: init(0.8, 60), emission: emit({ maxParticles: 400 }) });
    const childB = childLayer("b", { initial: init(0.6, 40), emission: emit({ maxParticles: 400 }) });
    const doc = makeDoc({ duration: 2, looping: true, layers: [parent, childA, childB] });

    const runA = new Effect(doc, { seed: 1337 });
    const runB = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(31, 600);
    const checkpoints = new Set([1, 60, 150, 300, 600]);
    for (let i = 1; i <= 600; i++) {
      runA.step(dts[i - 1]!);
      runB.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(runA)).toBe(stateHash(runB));
    }
    expect(runA.layers[1]!.count + runA.layers[2]!.count).toBeGreaterThan(0); // children actually spawned
  });
});

describe("sub-emitters — frame conversion (E22, M8)", () => {
  // A parent whose single burst particle dies at rest one step after spawn, firing
  // one point-shape child (no spread) so the child position is exactly the
  // converted event location.
  const parentDeath = (space: Layer["space"]): Layer =>
    makeLayer({
      id: "p",
      name: "p",
      space,
      subEmitters: [sub("death", "c", 1)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(1)] }),
      initial: init(0.2, 0),
      overLifetime: ol(),
    });

  it("parent-local + child-world ⇒ children spawn at the emitter-relative world position", () => {
    const doc = makeDoc({ duration: 2, looping: false, layers: [parentDeath("local"), childLayer("c", { space: "world" })] });
    const fx = new Effect(doc, { seed: 5, x: 300, y: 200 });
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    // Parent-local death at (0,0); child-world adds the (stationary) emitter position.
    expect(fx.layers[1]!.pool.x[0]).toBeCloseTo(300, 6);
    expect(fx.layers[1]!.pool.y[0]).toBeCloseTo(200, 6);
  });

  it("parent-world + child-local ⇒ children spawn at the emitter-subtracted local position", () => {
    const doc = makeDoc({ duration: 2, looping: false, layers: [parentDeath("world"), childLayer("c", { space: "local" })] });
    const fx = new Effect(doc, { seed: 5, x: 300, y: 200 });
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    expect(fx.layers[1]!.count).toBe(1);
    // Parent-world death at the emitter (300,200); child-local subtracts it ⇒ (0,0).
    expect(fx.layers[1]!.pool.x[0]).toBeCloseTo(0, 6);
    expect(fx.layers[1]!.pool.y[0]).toBeCloseTo(0, 6);
  });
});

describe("sub-emitters — prewarm suppression (E19, M8)", () => {
  it("no event-children at t=0, but ordinals were assigned during prewarm", () => {
    const parent = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "c", 4)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ rateOverTime: { mode: "constant", value: 40 }, prewarm: true, maxParticles: 64 }),
      initial: init(0.3),
      overLifetime: ol(),
    });
    const doc = makeDoc({ duration: 1, looping: true, layers: [parent, childLayer("c")] });
    const fx = new Effect(doc, { seed: 3 });
    // E19: prewarm captured no events, so no children exist yet.
    expect(fx.layers[1]!.count).toBe(0);
    // But ordinals ARE assigned during prewarm: many particles were spawned and
    // died, so the live particles carry ordinals well past the current live count.
    const pl = fx.layers[0]!;
    expect(pl.count).toBeGreaterThan(0);
    let maxOrd = 0;
    for (let i = 0; i < pl.count; i++) maxOrd = Math.max(maxOrd, pl.pool.ordinal![i]!);
    expect(maxOrd).toBeGreaterThan(pl.count); // counter advanced through prewarm

    // Post-prewarm deaths now fire children (with valid ordinals).
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      fx.step(1 / 60);
      peak = Math.max(peak, fx.layers[1]!.count);
    }
    expect(peak).toBeGreaterThan(0);
  });
});

describe("sub-emitters — pool cap (E7, M8)", () => {
  it("a full child pool drops silently, sets capped, and stays deterministic", () => {
    const parent = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "c", 100)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(3)], maxParticles: 8 }),
      initial: init(0.15),
      overLifetime: ol(),
    });
    const child = childLayer("c", { emission: emit({ maxParticles: 10 }), initial: init(5) });
    const doc = makeDoc({ duration: 2, looping: false, layers: [parent, child] });
    const a = new Effect(doc, { seed: 1 });
    const b = new Effect(doc, { seed: 1 });
    // `capped` is a per-step flag (cleared each advance), so observe it across the
    // run — it must trip on the overflow step when 300 children hit the 10-slot pool.
    let everCapped = false;
    for (let i = 0; i < 30; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
      everCapped ||= a.layers[1]!.capped;
    }
    expect(a.layers[1]!.count).toBe(10); // capped at maxParticles
    expect(everCapped).toBe(true);
    expect(stateHash(a)).toBe(stateHash(b)); // cap path is deterministic
  });
});

describe("sub-emitters — ordinal survives swap-remove (M7 placeholder regression, M8)", () => {
  it("later death events carry the true monotone ordinal, not a reused live index", () => {
    // A parent LayerSim (subEmitters non-null ⇒ ordinal column). Record death events
    // directly. Spawn 5 (ordinals 0..4 at indices 0..4); make indices 0 AND 4 die in
    // ONE update so the swap-remove moves ordinal-4 into slot 0 and it dies there.
    const layer = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "x", 1)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit(),
      initial: init(100, 0),
      overLifetime: ol(),
    });
    const sim = new LayerSim(layer, deriveLayerSeed(1337, 0));
    sim.recordDeathEvents = true;
    for (let k = 0; k < 5; k++) expect(sim.spawn()).toBe(true);
    expect(sim.pool.ordinal).not.toBeNull();
    // ordinals 0..4 assigned in spawn order.
    for (let k = 0; k < 5; k++) expect(sim.pool.ordinal![k]).toBe(k);
    // Kill the first (index 0, ord 0) and the last (index 4, ord 4) this step.
    sim.pool.lifetime[0] = 0.01;
    sim.pool.lifetime[4] = 0.01;

    sim.update(0.02);

    const ev = sim.deathEvents!;
    expect(ev.length).toBe(10); // two quintuples
    // First death: index 0, ordinal 0. Second death: the swapped-in particle at
    // index 0 whose TRUE ordinal is 4 — the old code recorded the live index (0),
    // this asserts the durable ordinal.
    expect(ev[4]).toBe(0);
    expect(ev[9]).toBe(4);
    // Three survivors (ordinals 1,2,3) remain.
    expect(sim.count).toBe(3);
  });
});

describe("sub-emitters — disabled child layers receive no event spawns (S-2)", () => {
  // The audit repro: a non-looping doc whose parent bursts 5 particles (life 0.2s)
  // and fires 3 children per death into a MUTED child (enabled:false). Pre-fix the
  // 15 children spawn into a layer advance() never updates ⇒ immortal, so the child
  // pool pins at 15, particleCount stays > 0, isDone never goes true and onDone never
  // fires. Post-fix the ref is dropped at plan-build ⇒ child count stays 0, the parent
  // drains, isDone flips true and onDone fires exactly once.
  const buildRepro = (childEnabled: boolean) => {
    const parent = makeLayer({
      id: "p",
      name: "p",
      subEmitters: [sub("death", "c", 3)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(5)], maxParticles: 16 }),
      initial: init(0.2), // parent particles die ~step 12
      overLifetime: ol(),
    });
    const child = childLayer("c", { enabled: childEnabled, initial: init(0.1), emission: emit({ maxParticles: 100 }) });
    return makeDoc({ duration: 2, looping: false, layers: [parent, child] });
  };

  it("a muted child never accumulates children; the effect completes and onDone fires once", () => {
    const doc = buildRepro(false);
    // Editor-relevant: the muted-child doc validates clean (it did before and must continue to).
    expect(validateParticle(doc).ok).toBe(true);
    const fx = new Effect(doc, { seed: 1337 });
    let onDoneCalls = 0;
    fx.onDone = () => onDoneCalls++;
    for (let i = 0; i < 600; i++) fx.step(1 / 60);
    // RED pre-fix: child count 15, isDone false, onDone never fires.
    expect(fx.layers[1]!.count).toBe(0);
    expect(fx.layers[0]!.count).toBe(0); // parent drained
    expect(fx.isDone).toBe(true);
    expect(onDoneCalls).toBe(1);
  });

  it("enabled-child control: children spawn, drain, and the effect still completes (no drift)", () => {
    const doc = buildRepro(true);
    expect(validateParticle(doc).ok).toBe(true);
    const fx = new Effect(doc, { seed: 1337 });
    let onDoneCalls = 0;
    fx.onDone = () => onDoneCalls++;
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      fx.step(1 / 60);
      peak = Math.max(peak, fx.layers[1]!.count);
    }
    expect(peak).toBe(15); // 5 deaths × 3 children each spawned into the enabled child
    expect(fx.layers[1]!.count).toBe(0); // children (life 0.1) drained by step 600
    expect(fx.isDone).toBe(true);
    expect(onDoneCalls).toBe(1);
  });

  it("an ENABLED sibling's stream is byte-identical whether or not a muted sibling shares the parent", () => {
    // Two refs on one parent, both death-triggered: 'a' is enabled, 'b' is muted.
    // Dropping 'b' must not perturb 'a' — the eventSeed derives from
    // (parentLayerSeed, ordinal, eventCode, AUTHORED refIndex), never the entry's
    // index in the disabled-filtered `entries` list. 'a' is authored at index 0 in
    // both docs, so its stream is byte-identical (and, refIndex 0 being a no-op,
    // identical to the pre-S-7 stream too). The S-7 block above pins the mirror
    // case: a muted sibling at index 0 not reseeding the enabled ref at index 1.
    const parentBody = (subs: SubEmitterRef[]): Layer =>
      makeLayer({
        id: "p",
        name: "p",
        subEmitters: subs,
        shape: { kind: "point", emitFrom: "volume" },
        emission: emit({ bursts: [burst(5)], maxParticles: 16 }),
        initial: init(0.2),
        overLifetime: ol(),
      });
    const childA = () => childLayer("a", { initial: init(5) });
    const mutedB = () => childLayer("b", { enabled: false, initial: init(5) });
    const withMuted = makeDoc({
      duration: 2,
      looping: false,
      layers: [parentBody([sub("death", "a", 4), sub("death", "b", 4)]), childA(), mutedB()],
    });
    const noMuted = makeDoc({
      duration: 2,
      looping: false,
      layers: [parentBody([sub("death", "a", 4)]), childA(), mutedB()],
    });
    const a = new Effect(withMuted, { seed: 1337 });
    const b = new Effect(noMuted, { seed: 1337 });
    for (let i = 0; i < 40; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    const ca = a.layers[1]!;
    const cb = b.layers[1]!;
    expect(ca.count).toBe(cb.count);
    expect(ca.count).toBeGreaterThan(0);
    const n = ca.count;
    expect(Array.from(ca.pool.x.slice(0, n))).toEqual(Array.from(cb.pool.x.slice(0, n)));
    expect(Array.from(ca.pool.rand0.slice(0, n))).toEqual(Array.from(cb.pool.rand0.slice(0, n)));
    expect(a.layers[2]!.count).toBe(0); // muted 'b' never received children
  });
});

describe("sub-emitters — no cascade past depth 1 (M8)", () => {
  it("a child (subEmitters null) never spawns downstream even when it holds particles", () => {
    const parent = makeLayer({
      id: "a",
      name: "a",
      subEmitters: [sub("death", "b", 4)],
      shape: { kind: "point", emitFrom: "volume" },
      emission: emit({ bursts: [burst(3)], maxParticles: 8 }),
      initial: init(0.15),
      overLifetime: ol(),
    });
    const childB = childLayer("b", { subEmitters: null }); // valid depth-1 target
    const inertC = childLayer("c"); // no incoming trigger; must stay empty
    const doc = makeDoc({ duration: 2, looping: false, layers: [parent, childB, inertC] });
    const fx = new Effect(doc, { seed: 8 });
    let bPeak = 0;
    for (let i = 0; i < 40; i++) {
      fx.step(1 / 60);
      bPeak = Math.max(bPeak, fx.layers[1]!.count);
      expect(fx.layers[2]!.count).toBe(0); // C never receives a cascade
    }
    expect(bPeak).toBeGreaterThan(0);
  });
});
