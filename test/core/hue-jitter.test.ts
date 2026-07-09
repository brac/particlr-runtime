import { describe, it, expect } from "vitest";
import { LayerSim, Effect, deriveLayerSeed, mulberry32, hueRotateRGB, type Layer, type StartColor, type GradientTrack, type RGBA } from "../../src/index.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);

// A minimal point-shape, zero-speed, effectively-immortal layer so spawn draws
// are isolated (mirrors start-color-flip.test.ts). `startColor` is merged per test.
function scLayer(extra: Partial<Layer> = {}, color?: GradientTrack): Layer {
  return makeLayer({
    shape: { kind: "point", emitFrom: "volume" },
    initial: {
      life: { mode: "constant", value: 100 },
      speed: { mode: "constant", value: 0 },
      size: { mode: "constant", value: 1 },
      rotation: { mode: "constant", value: 0 },
      angularVelocity: { mode: "constant", value: 0 },
    },
    overLifetime: {
      size: null,
      color: color ?? { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
      rotation: null,
      velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
    },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
describe("hueRotateRGB — HSV round-trip on knowns (§0.3c)", () => {
  const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };

  it("pure red rotated +120° is pure green; +240° is pure blue", () => {
    hueRotateRGB(1, 0, 0, 120, out);
    expect(out.r).toBeCloseTo(0, 6);
    expect(out.g).toBeCloseTo(1, 6);
    expect(out.b).toBeCloseTo(0, 6);
    hueRotateRGB(1, 0, 0, 240, out);
    expect(out.r).toBeCloseTo(0, 6);
    expect(out.g).toBeCloseTo(0, 6);
    expect(out.b).toBeCloseTo(1, 6);
  });

  it("+360° is the identity (full wrap)", () => {
    hueRotateRGB(0.8, 0.3, 0.1, 360, out);
    expect(out.r).toBeCloseTo(0.8, 6);
    expect(out.g).toBeCloseTo(0.3, 6);
    expect(out.b).toBeCloseTo(0.1, 6);
  });

  it("0° is the identity BITWISE for an in-range color", () => {
    const r = 0.37;
    const g = 0.62;
    const b = 0.18;
    hueRotateRGB(r, g, b, 0, out);
    expect(out.r).toBe(r);
    expect(out.g).toBe(g);
    expect(out.b).toBe(b);
  });

  it("gray (saturation 0) is unchanged by ANY rotation (bitwise)", () => {
    for (const deg of [30, -45, 90, 179, -180]) {
      hueRotateRGB(0.5, 0.5, 0.5, deg, out);
      expect(out.r).toBe(0.5);
      expect(out.g).toBe(0.5);
      expect(out.b).toBe(0.5);
    }
  });

  it("preserves value and saturation (a rotation only moves hue)", () => {
    // A mid color: max=0.8, min=0.2 ⇒ v=0.8, s=0.75. After any rotation, the
    // rotated color must keep the same max and min (magnitudes), just reassigned.
    hueRotateRGB(0.8, 0.5, 0.2, 47, out);
    const mx = Math.max(out.r, out.g, out.b);
    const mn = Math.min(out.r, out.g, out.b);
    expect(mx).toBeCloseTo(0.8, 6);
    expect(mn).toBeCloseTo(0.2, 6);
  });

  it("leaves out.a untouched (caller owns alpha)", () => {
    out.a = 0.42;
    hueRotateRGB(1, 0, 0, 90, out);
    expect(out.a).toBe(0.42);
  });
});

// ---------------------------------------------------------------------------
describe("hue jitter — spawn stores the offset from draw 19 (§0.3c, no new draw)", () => {
  const DEG = 60;
  const hue: StartColor = { mode: "hueJitter", degrees: DEG };
  const palette: StartColor = { mode: "palette", colors: [{ r: 0.1, g: 0.2, b: 0.3, a: 1 }] };

  it("tintR holds (u−0.5)·2·degrees from the draw-19 uniform (pinned)", () => {
    const sim = new LayerSim(scLayer({ startColor: hue }), seed);
    expect(sim.pool.tintR).not.toBeNull();
    sim.spawn();
    const rng = mulberry32(seed);
    for (let k = 0; k < 13; k++) rng(); // the 13 standard spawn draws
    const u = rng(); // draw 19
    expect(sim.pool.tintR![0]).toBe(Math.fround((u - 0.5) * 2 * DEG));
    // The other channels carry the neutral placeholders (G=0, B=0, A=1).
    expect(sim.pool.tintG![0]).toBe(0);
    expect(sim.pool.tintB![0]).toBe(0);
    expect(sim.pool.tintA![0]).toBe(1);
  });

  it("consumes EXACTLY one draw at 19 — its spawn stream matches a palette twin byte-for-byte", () => {
    // Both modes draw one uniform at draw 19, so every downstream draw (and the
    // next spawn's whole stream) lines up. Spawn several from each and compare the
    // pre-19 rand columns AND the second spawn's rand0 (proves the draw count is
    // identical: a differing count would desync spawn #2).
    const hueSim = new LayerSim(scLayer({ startColor: hue }), seed);
    const palSim = new LayerSim(scLayer({ startColor: palette }), seed);
    for (let i = 0; i < 4; i++) {
      hueSim.spawn();
      palSim.spawn();
    }
    for (let i = 0; i < 4; i++) {
      expect(hueSim.pool.rand0[i]).toBe(palSim.pool.rand0[i]);
      expect(hueSim.pool.rand1[i]).toBe(palSim.pool.rand1[i]);
      expect(hueSim.pool.rand2[i]).toBe(palSim.pool.rand2[i]);
      expect(hueSim.pool.rand3[i]).toBe(palSim.pool.rand3[i]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("hue jitter — render (§0.3c / E29)", () => {
  function liveSim(startColor: StartColor | null, color?: GradientTrack): LayerSim {
    const ls = new LayerSim(scLayer(startColor === null ? {} : { startColor }, color), seed);
    const i = ls.pool.spawn();
    ls.pool.age[i] = 0;
    ls.pool.lifetime[i] = 1;
    ls.pool.sizeInit[i] = 10;
    return ls;
  }

  it("offset 0 ⇒ rendered color equals the no-startColor path BITWISE", () => {
    const green: GradientTrack = { keys: [{ t: 0, r: 0.2, g: 0.7, b: 0.35, a: 0.9 }] };
    const hueLs = liveSim({ mode: "hueJitter", degrees: 90 }, green);
    hueLs.pool.tintR![0] = 0; // the u=0.5 spawn: no jitter
    const nullLs = liveSim(null, green);
    const hueBuf = makeRenderBuffers(hueLs.pool.capacity);
    const nullBuf = makeRenderBuffers(nullLs.pool.capacity);
    computeRenderState(hueLs, hueBuf);
    computeRenderState(nullLs, nullBuf);
    expect(hueBuf.r[0]).toBe(nullBuf.r[0]);
    expect(hueBuf.g[0]).toBe(nullBuf.g[0]);
    expect(hueBuf.b[0]).toBe(nullBuf.b[0]);
    expect(hueBuf.a[0]).toBe(nullBuf.a[0]);
  });

  it("hue-rotates the gradient RGB by the stored offset; alpha unchanged", () => {
    const color: GradientTrack = { keys: [{ t: 0, r: 0.9, g: 0.2, b: 0.1, a: 0.75 }] };
    const ls = liveSim({ mode: "hueJitter", degrees: 120 }, color);
    ls.pool.tintR![0] = 120; // a known offset
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    // Expected via the SAME helper on the SAME gradient color.
    const exp: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    hueRotateRGB(0.9, 0.2, 0.1, 120, exp);
    expect(buf.r[0]).toBe(Math.fround(exp.r));
    expect(buf.g[0]).toBe(Math.fround(exp.g));
    expect(buf.b[0]).toBe(Math.fround(exp.b));
    expect(buf.a[0]).toBe(Math.fround(0.75)); // alpha is the gradient's, untouched
  });

  it("null-pin: a palette startColor still multiplies (the hueJitter branch left it byte-identical)", () => {
    const color: GradientTrack = { keys: [{ t: 0, r: 0.8, g: 0.6, b: 0.4, a: 1 }] };
    const ls = liveSim({ mode: "palette", colors: [{ r: 0.5, g: 0.25, b: 0.75, a: 0.5 }] }, color);
    ls.pool.tintR![0] = 0.5;
    ls.pool.tintG![0] = 0.25;
    ls.pool.tintB![0] = 0.75;
    ls.pool.tintA![0] = 0.5;
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.r[0]).toBe(Math.fround(0.8 * 0.5));
    expect(buf.g[0]).toBe(Math.fround(0.6 * 0.25));
    expect(buf.b[0]).toBe(Math.fround(0.4 * 0.75));
    expect(buf.a[0]).toBe(Math.fround(1 * 0.5));
  });
});

// ---------------------------------------------------------------------------
describe("hue jitter — determinism", () => {
  function jitterDoc() {
    return makeDoc({
      duration: 2,
      looping: true,
      layers: [
        makeLayer({
          space: "world",
          startColor: { mode: "hueJitter", degrees: 40 },
          shape: { kind: "cone", direction: -90, spread: 40, radius: 6, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
          overLifetime: {
            size: null,
            color: { keys: [{ t: 0, r: 0.4, g: 0.6, b: 0.2, a: 1 }, { t: 1, r: 0.3, g: 0.4, b: 0.15, a: 0 }] },
            rotation: null,
            velocity: { gravity: { x: 0, y: 200 }, drag: { mode: "constant", value: 0.4 }, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
          },
          noise: { strength: { mode: "constant", value: 24 }, frequency: 0.01, scrollSpeed: 0.2, octaves: 2 },
        }),
      ],
    });
  }

  it("two-run bit identity over 600 mixed-dt steps (offset rides the hashed tint column)", () => {
    const doc = jitterDoc();
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(29, 600);
    const checkpoints = new Set([1, 200, 400, 600]);
    for (let i = 1; i <= 600; i++) {
      a.step(dts[i - 1]!);
      b.step(dts[i - 1]!);
      if (checkpoints.has(i)) expect(stateHash(a)).toBe(stateHash(b));
    }
  });
});
