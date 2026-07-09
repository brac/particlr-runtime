import { describe, it, expect } from "vitest";
import { Effect, LayerSim, deriveLayerSeed, type Flipbook, type ScalarTrack } from "../../src/index.js";
import { computeRenderState, makeRenderBuffers, flipbookFrame } from "../../src/core/render.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash } from "./_statehash.js";

// A7 flipbook upgrades (schemaVersion 5, §0.3d / E30). flipbookFrame is a pure,
// deterministic, render-only function: no PRNG draw, no statehash contribution.

const seed = deriveLayerSeed(1337, 0);

// Build a Flipbook config (total = cols·rows via cols, rows 1 unless overridden).
function fb(over: Partial<Flipbook> = {}): Flipbook {
  return { cols: 4, rows: 1, fps: 12, mode: "loop", randomStartFrame: false, frameOverLife: null, ...over };
}
const curve = (a: number, b: number): ScalarTrack => ({ mode: "curve", keys: [{ t: 0, v: a }, { t: 1, v: b }] });

// The EXACT pre-A7 implementation (HEAD before M4), inlined so the null path can
// be pinned bitwise. randomStartFrame:false + frameOverLife:null must reproduce
// this for every (age, fps, total, mode).
function oldFlipbookFrame(f: Flipbook, age: number, frameRand: number): number {
  const total = f.cols * f.rows;
  if (total <= 1) return 0;
  if (f.mode === "random") return Math.min(total - 1, Math.floor(frameRand * total));
  const idx = Math.floor(age * f.fps);
  if (f.mode === "once") return Math.min(idx, total - 1);
  return ((idx % total) + total) % total; // loop
}

describe("flipbookFrame — precedence 1: frameOverLife overrides mode entirely (E30)", () => {
  it("constant 0 ⇒ frame 0; constant 1 ⇒ clamps to total−1; 0.5 ⇒ mid", () => {
    expect(flipbookFrame(fb({ frameOverLife: { mode: "constant", value: 0 } }), 0, 0, 0.9)).toBe(0);
    expect(flipbookFrame(fb({ frameOverLife: { mode: "constant", value: 1 } }), 0, 0.5, 0.1)).toBe(3); // ⌊1·4⌋=4 → 3
    expect(flipbookFrame(fb({ frameOverLife: { mode: "constant", value: 0.5 } }), 0, 0.2, 0.7)).toBe(2); // ⌊0.5·4⌋=2
  });

  it("out-of-range values clamp on both sides", () => {
    expect(flipbookFrame(fb({ frameOverLife: { mode: "constant", value: -2 } }), 0, 0, 0)).toBe(0);
    expect(flipbookFrame(fb({ frameOverLife: { mode: "constant", value: 5 } }), 0, 0, 0)).toBe(3);
  });

  it("a 0→1 curve sweeps frames over normalized life", () => {
    const f = fb({ frameOverLife: curve(0, 1) });
    expect(flipbookFrame(f, 0, 0, 0)).toBe(0); // ⌊0·4⌋
    expect(flipbookFrame(f, 0, 0.25, 0)).toBe(1); // ⌊1·4⌋ ... ⌊0.25·4⌋=1
    expect(flipbookFrame(f, 0, 0.5, 0)).toBe(2); // ⌊2⌋
    expect(flipbookFrame(f, 0, 0.99, 0)).toBe(3); // ⌊3.96⌋
    expect(flipbookFrame(f, 0, 1, 0)).toBe(3); // ⌊4⌋ → clamp
  });

  it("overrides mode:\"random\" (uses ageNorm, ignores frameRand entirely)", () => {
    const f = fb({ mode: "random", frameOverLife: { mode: "constant", value: 0 } });
    // frameRand would pick a random frame in plain random mode; frameOverLife wins.
    expect(flipbookFrame(f, 0, 0, 0.99)).toBe(0);
    expect(flipbookFrame(f, 0, 0, 0.0)).toBe(0);
  });

  it("overrides randomStartFrame (precedence 1 before precedence 3)", () => {
    const f = fb({ mode: "loop", randomStartFrame: true, frameOverLife: { mode: "constant", value: 0.5 } });
    expect(flipbookFrame(f, 0.3, 0.2, 0.9)).toBe(2); // frameOverLife path, no age·fps / offset
  });
});

describe("flipbookFrame — precedence 2: mode random ignores randomStartFrame", () => {
  it("random frame comes from frameRand regardless of randomStartFrame", () => {
    const off = fb({ mode: "random", randomStartFrame: false });
    const on = fb({ mode: "random", randomStartFrame: true });
    for (const fr of [0, 0.1, 0.5, 0.75, 0.999]) {
      expect(flipbookFrame(on, 0.4, 0.4, fr)).toBe(flipbookFrame(off, 0.4, 0.4, fr));
      expect(flipbookFrame(off, 0.4, 0.4, fr)).toBe(Math.min(3, Math.floor(fr * 4)));
    }
  });
});

describe("flipbookFrame — precedence 3: loop/once + randomStartFrame offset (reuses frameRand)", () => {
  it("loop wraps ⌊age·fps⌋ + ⌊frameRand·total⌋ mod total", () => {
    const f = fb({ mode: "loop", randomStartFrame: true }); // total 4, fps 12
    // age 0 ⇒ base ⌊0⌋=0; offset ⌊0.5·4⌋=2 ⇒ 2 % 4 = 2
    expect(flipbookFrame(f, 0, 0, 0.5)).toBe(2);
    // age 0.25 ⇒ ⌊0.25·12⌋=3; +2 = 5 ⇒ 5 % 4 = 1
    expect(flipbookFrame(f, 0.25, 0, 0.5)).toBe(1);
    // offset ⌊0.99·4⌋=3; age 0 ⇒ 3
    expect(flipbookFrame(f, 0, 0, 0.99)).toBe(3);
  });

  it("once clamps ⌊age·fps⌋ + offset to total−1", () => {
    const f = fb({ mode: "once", randomStartFrame: true }); // total 4, fps 12
    // age 0 ⇒ base 0 + ⌊0.5·4⌋=2 ⇒ 2 (unclamped)
    expect(flipbookFrame(f, 0, 0, 0.5)).toBe(2);
    // age 0.25 ⇒ 3 + 2 = 5 ⇒ clamp to 3
    expect(flipbookFrame(f, 0.25, 0, 0.5)).toBe(3);
    // large offset immediately clamps
    expect(flipbookFrame(f, 0, 0, 0.99)).toBe(3);
  });
});

describe("flipbookFrame — the null pin (randomStartFrame:false + frameOverLife:null ⇒ bitwise-identical to pre-A7)", () => {
  it("matches the old function across a matrix of (age, fps, total, mode)", () => {
    const modes: Flipbook["mode"][] = ["loop", "once", "random"];
    let cases = 0;
    for (const mode of modes) {
      for (const total of [1, 2, 4, 9, 16]) {
        for (const fps of [1, 12, 30, 60]) {
          for (const age of [0, 0.001, 0.5, 1, 3.7, 100]) {
            for (const fr of [0, 0.25, 0.5, 0.999]) {
              const f = fb({ cols: total, rows: 1, fps, mode, randomStartFrame: false, frameOverLife: null });
              // ageNorm is irrelevant when frameOverLife is null; pass a distinct value.
              expect(flipbookFrame(f, age, 0.42, fr)).toBe(oldFlipbookFrame(f, age, fr));
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(400);
  });

  it("single-cell (total ≤ 1) always returns 0, and null fb returns 0", () => {
    expect(flipbookFrame(fb({ cols: 1, rows: 1 }), 5, 0.5, 0.9)).toBe(0);
    expect(flipbookFrame(null, 5, 0.5, 0.9)).toBe(0);
  });
});

// --------------------------------------------------------------------------
describe("flipbook A7 in computeRenderState — render-only, deterministic", () => {
  // Build a LayerSim with a flipbook and hand-set particle ages.
  function simWith(frames: Flipbook, ages: number[]): LayerSim {
    const ls = new LayerSim(makeLayer({ texture: { ref: "spark", frames } }), seed);
    const p = ls.pool;
    for (const age of ages) {
      const i = p.spawn();
      p.age[i] = age;
      p.lifetime[i] = 1;
      p.sizeInit[i] = 10;
    }
    return ls;
  }

  it("frameOverLife curve maps ageNorm → frame in the render buffer", () => {
    const ls = simWith(fb({ frameOverLife: curve(0, 1) }), [0, 0.5, 0.99]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.frame[0]).toBe(0);
    expect(buf.frame[1]).toBe(2);
    expect(buf.frame[2]).toBe(3);
  });

  it("frame index always lands in [0, total−1] (the renderer's slice contract)", () => {
    const ls = simWith(fb({ cols: 3, rows: 2, frameOverLife: curve(-1, 3) }), [0, 0.3, 0.7, 1]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    for (let i = 0; i < ls.count; i++) {
      expect(buf.frame[i]!).toBeGreaterThanOrEqual(0);
      expect(buf.frame[i]!).toBeLessThanOrEqual(3 * 2 - 1);
    }
  });
});

describe("flipbook A7 — determinism (render-only, no statehash change)", () => {
  const run = (frames: Flipbook): string => {
    const fx = new Effect(makeDoc({ layers: [makeLayer({ texture: { ref: "spark", frames } })] }), { seed: 1337 });
    for (let i = 0; i < 60; i++) fx.step(1 / 60);
    return stateHash(fx);
  };

  it("adding randomStartFrame / frameOverLife does NOT change the sim stateHash", () => {
    // frameRand is drawn unconditionally (draw 13, already in the hash); the A7
    // fields are render-only, so the simulation digest is identical.
    const plain = run(fb());
    expect(run(fb({ randomStartFrame: true }))).toBe(plain);
    expect(run(fb({ frameOverLife: curve(0, 1) }))).toBe(plain);
    expect(run(fb({ randomStartFrame: true, frameOverLife: curve(0, 1) }))).toBe(plain);
  });

  it("the rendered frame buffer is bit-identical across two runs of a flipbook doc", () => {
    const framesOf = (frames: Flipbook): number[] => {
      const fx = new Effect(makeDoc({ layers: [makeLayer({ texture: { ref: "spark", frames } })] }), { seed: 1337 });
      for (let i = 0; i < 30; i++) fx.step(1 / 60);
      const ls = fx.layers[0]!;
      const buf = makeRenderBuffers(ls.pool.capacity);
      computeRenderState(ls, buf);
      return Array.from(buf.frame.slice(0, ls.count));
    };
    const frames = fb({ mode: "loop", randomStartFrame: true });
    expect(framesOf(frames)).toEqual(framesOf(frames));
  });
});
