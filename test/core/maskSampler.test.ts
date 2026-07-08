import { describe, it, expect } from "vitest";
import {
  LayerSim,
  Effect,
  buildMaskSampler,
  sampleShape,
  deriveLayerSeed,
  mulberry32,
  validateParticle,
  type Layer,
  type Shape,
  type Rng,
} from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);

// Node has Buffer; the runtime never re-encodes, so building test masks with it
// is fine (only decodeBase64 is exercised in the runtime).
const b64 = (bytes: number[]): string => Buffer.from(Uint8Array.from(bytes)).toString("base64");

type TexShape = Extract<Shape, { kind: "texture" }>;
const texShape = (over: Partial<TexShape> = {}): TexShape => ({
  kind: "texture",
  width: 64,
  height: 64,
  threshold: 0,
  mask: { width: 1, height: 1, data: "/w==" }, // 1×1 opaque
  emitFrom: "volume",
  ...over,
});
const texShapeWith = (mw: number, mh: number, bytes: number[], threshold: number, width: number, height: number): TexShape => ({
  kind: "texture",
  width,
  height,
  threshold,
  mask: { width: mw, height: mh, data: b64(bytes) },
  emitFrom: "volume",
});
const texLayer = (shapeOver: Partial<TexShape> = {}, layerOver: Partial<Layer> = {}): Layer =>
  makeLayer({ shape: texShape(shapeOver), ...layerOver });

// True iff validating a doc holding a texture shape emits the E23 "bad-mask"
// warning — the exact predicate whose agreement with the sampler we pin below.
const validatorBadMask = (shape: TexShape): boolean => {
  const r = validateParticle(makeDoc({ layers: [makeLayer({ shape })] }));
  const warns = r.ok ? r.warnings : r.warnings;
  return warns.some((w) => w.code === "bad-mask");
};

describe("maskSampler — build + weighted sampling (§0.3a)", () => {
  it("a 2-pixel mask (alpha 255 vs 85) spawns ≈3:1 for the brighter pixel", () => {
    const shape = texShapeWith(2, 1, [255, 85], 0, 2, 2); // display width 2
    const sampler = buildMaskSampler(shape);
    expect(sampler).not.toBeNull();
    const rng = mulberry32(seed);
    let bright = 0; // col 0 → px < 0
    let dim = 0; // col 1 → px >= 0
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const s = sampler!.sample(rng(), rng(), rng(), shape, rng());
      if (s.px < 0) bright++;
      else dim++;
    }
    const ratio = bright / dim;
    expect(ratio).toBeGreaterThan(2.6);
    expect(ratio).toBeLessThan(3.4);
  });

  it("threshold gates out pixels below the alpha cutoff", () => {
    // bytes [255, 100]; threshold 0.5 → gate 127.5; only the 255 pixel passes.
    const shape = texShapeWith(2, 1, [255, 100], 0.5, 2, 2);
    const sampler = buildMaskSampler(shape);
    expect(sampler).not.toBeNull();
    const rng = mulberry32(seed);
    for (let i = 0; i < 2000; i++) {
      const s = sampler!.sample(rng(), rng(), rng(), shape, rng());
      expect(s.px).toBeLessThan(0); // always the col-0 (bright) pixel
    }
  });

  it("returns null on every E23 condition", () => {
    expect(buildMaskSampler(texShape({ mask: { width: 1, height: 1, data: "not base64!!" } }))).toBeNull(); // undecodable
    expect(buildMaskSampler(texShapeWith(2, 2, [255], 0, 8, 8))).toBeNull(); // length 1 ≠ 4
    expect(buildMaskSampler(texShapeWith(2, 1, [0, 0], 0, 8, 8))).toBeNull(); // zero total weight
    expect(buildMaskSampler(texShapeWith(1, 1, [10], 0.5, 8, 8))).toBeNull(); // 10 < gate 127.5 → zero passing
  });

  it("the gate agrees with validate.ts checkMask on a boundary threshold (26/255)", () => {
    // gate = (26/255)·255; a byte of 26 passes, 25 fails — sampler and validator
    // MUST agree so a doc never warns-but-works or passes-but-degrades.
    const thr = 26 / 255;
    const pass = texShapeWith(1, 1, [26], thr, 8, 8);
    const fail = texShapeWith(1, 1, [25], thr, 8, 8);
    // sampler
    expect(buildMaskSampler(pass)).not.toBeNull();
    expect(buildMaskSampler(fail)).toBeNull();
    // validator (the E23 warning fires iff zero pixels pass)
    expect(validatorBadMask(pass)).toBe(false);
    expect(validatorBadMask(fail)).toBe(true);
  });

  it("a 1×1 opaque mask reproduces a uniform rect distribution over width×height", () => {
    const w = 40;
    const h = 24;
    const shape = texShapeWith(1, 1, [255], 0, w, h);
    const sampler = buildMaskSampler(shape);
    expect(sampler).not.toBeNull();
    const rect: Shape = { kind: "rect", width: w, height: h, emitFrom: "volume" };
    const rng = mulberry32(seed);
    for (let i = 0; i < 200; i++) {
      const a = rng();
      const b = rng();
      const sTex = sampler!.sample(0.5 /* any: 1×1 → col 0, row 0 */, a, b, shape, 0.1);
      const sRect = sampleShape(rect, a, b, 0.1);
      // Position is bit-identical to a uniform rect (direction differs by design).
      expect(sTex.px).toBe(sRect.px);
      expect(sTex.py).toBe(sRect.py);
    }
  });
});

describe("maskSampler — layerSim draw contract (draws 22–24)", () => {
  it("a texture layer appends exactly 3 draws after the 13 standard draws", () => {
    const tex = new LayerSim(texLayer(), seed);
    const pt = new LayerSim(makeLayer({ shape: { kind: "point", emitFrom: "volume" } }), seed);
    tex.spawn();
    pt.spawn();
    // Particle 0: the 13 standard draws are shared (uDir·360 direction is identical
    // for point and texture), so every field NOT derived from the mask matches.
    for (const f of ["velX", "velY", "lifetime", "sizeInit", "rotation", "angVel", "rand0", "rand1", "rand2", "rand3", "frameRand"] as const)
      expect(tex.pool[f][0], f).toBe(pt.pool[f][0]);

    tex.spawn();
    pt.spawn();
    // Reconstruct: a texture spawn consumes 16 draws (13 + uIdx/jx/jy), a point
    // spawn 13; rand0 is the 9th draw of a spawn (uPos1,uPos2,uDir,life,speed,
    // size,rot,angVel precede it).
    const rt = mulberry32(seed);
    for (let k = 0; k < 16 + 8; k++) rt();
    expect(tex.pool.rand0[1]).toBe(Math.fround(rt()));
    const rp = mulberry32(seed);
    for (let k = 0; k < 13 + 8; k++) rp();
    expect(pt.pool.rand0[1]).toBe(Math.fround(rp())); // point: NO 22–24 draws
  });

  it("every non-texture kind leaves the reference stateHash unchanged (null pin)", () => {
    // The default makeLayer (cone, all modules null) takes exactly 13 draws/spawn:
    // its Nth-spawn rand0 matches a plain mulberry32 stream, proving no draw 22–24.
    const cone = new LayerSim(makeLayer(), seed);
    cone.spawn();
    cone.spawn();
    const r = mulberry32(seed);
    for (let k = 0; k < 13 + 8; k++) r(); // spawn0 (13) + spawn1 up to rand0 (8)
    expect(cone.pool.rand0[1]).toBe(Math.fround(r()));
  });

  it("E23: a corrupt-mask texture layer spawns at (0,0) AND still takes 3 draws", () => {
    // 1 byte where 4 are expected → null sampler → shapes.ts texture fallback.
    const sim = new LayerSim(texLayer({ mask: { width: 2, height: 2, data: "/w==" } }), seed);
    let count = 0;
    const base = mulberry32(seed);
    const counting: Rng = () => {
      count++;
      return base();
    };
    // spawnFrom exercises the identical spawn body via the passed (event) rng.
    expect(sim.spawnFrom(counting, 0, 0, 0, 0)).toBe(true);
    expect(count).toBe(16); // 13 standard + 3 texture, all from the passed rng
    expect(sim.pool.x[0]).toBe(0); // E23 fallback: point-shape origin
    expect(sim.pool.y[0]).toBe(0);
  });

  it("a valid texture child draws from the EVENT rng, count intact (sub-emitter stream)", () => {
    const sim = new LayerSim(texLayer({ mask: { width: 3, height: 3, data: b64([255, 0, 255, 0, 255, 0, 255, 0, 255]) } }), seed);
    let count = 0;
    const base = mulberry32(seed);
    const counting: Rng = () => {
      count++;
      return base();
    };
    expect(sim.spawnFrom(counting, 100, 50, 0, 0)).toBe(true);
    expect(count).toBe(16); // same fixed count as a corrupt mask — content-independent
  });
});

describe("maskSampler — determinism", () => {
  it("is bit-identical across two runs (texture layer, 300 mixed-dt steps)", () => {
    const doc = makeDoc({
      duration: 3,
      layers: [texLayer({ mask: { width: 4, height: 4, data: b64([255, 0, 128, 0, 0, 255, 0, 90, 200, 0, 255, 0, 0, 60, 0, 255]) }, threshold: 0.1, width: 120, height: 120 })],
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
    for (const [la, lb] of a.layers.map((l, i) => [l, b.layers[i]!] as const)) {
      expect(la.count).toBe(lb.count);
      expect(Array.from(la.pool.x.slice(0, la.count))).toEqual(Array.from(lb.pool.x.slice(0, lb.count)));
    }
  });

  it("a texture-shape sub-emitter child is bit-identical across two runs", () => {
    // Parent (point burst) death-triggers a texture-shape child; the child stream
    // runs the mask draws off the event rng. Two runs must agree bit-for-bit.
    const child = texLayer(
      { mask: { width: 2, height: 2, data: b64([255, 200, 100, 255]) }, width: 80, height: 80 },
      { id: "child", name: "child", emission: { ...makeLayer().emission, rateOverTime: { mode: "constant", value: 0 }, bursts: [] } },
    );
    const parent = makeLayer({
      id: "parent",
      name: "parent",
      shape: { kind: "point", emitFrom: "volume" },
      initial: { ...makeLayer().initial, life: { mode: "constant", value: 0.1 } },
      emission: { ...makeLayer().emission, rateOverTime: { mode: "constant", value: 0 }, bursts: [{ time: 0, count: 6, spread: 0, cycles: 1, interval: 0, probability: 1 }] },
      subEmitters: [{ trigger: "death", layerId: "child", count: 4, probability: 1, inheritVelocity: 0 }],
    });
    const doc = makeDoc({ duration: 2, layers: [parent, child] });
    const a = new Effect(doc, { seed: 4242 });
    const b = new Effect(doc, { seed: 4242 });
    const dts = dtSequence(11, 200);
    let childEverEmitted = false; // children are short-lived; catch them mid-run
    for (let i = 0; i < 200; i++) {
      a.step(dts[i]!);
      b.step(dts[i]!);
      if (a.layers[1]!.count > 0) childEverEmitted = true;
    }
    expect(stateHash(a)).toBe(stateHash(b));
    expect(childEverEmitted).toBe(true); // the texture-shape child stream actually ran
    expect(a.layers[1]!.count).toBe(b.layers[1]!.count);
  });
});
