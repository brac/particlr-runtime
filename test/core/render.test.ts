import { describe, it, expect } from "vitest";
import { Effect, LayerSim, deriveLayerSeed, type Layer, type RenderConfig } from "../../src/index.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);
const DEG = 180 / Math.PI;

// Build a LayerSim with N live particles at hand-set velocities/rotations so the
// render pass can be checked against the closed-form stretch/angle formulas.
function simWith(render: RenderConfig | null, particles: { vx: number; vy: number; rot?: number }[]): LayerSim {
  const layer: Layer = makeLayer({ render });
  const ls = new LayerSim(layer, seed);
  const p = ls.pool;
  for (const part of particles) {
    const i = p.spawn();
    p.velX[i] = part.vx;
    p.velY[i] = part.vy;
    p.rotation[i] = part.rot ?? 0;
    p.age[i] = 0;
    p.lifetime[i] = 1;
    p.sizeInit[i] = 10;
  }
  return ls;
}

describe("render module — stretch formula, clamp, alignment (M1)", () => {
  it("stretch = clamp(1 + speedScale·speed, min, max)", () => {
    const render: RenderConfig = { align: "none", speedScale: 0.01, minStretch: 1, maxStretch: 3 };
    // speed 100 → 1 + 0.01·100 = 2 (within [1,3]); speed 300 → 4 clamped to 3;
    // speed 0 → 1 clamped up to min 1.
    const ls = simWith(render, [
      { vx: 100, vy: 0 },
      { vx: 300, vy: 0 },
      { vx: 0, vy: 0 },
    ]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.stretch[0]).toBeCloseTo(2, 6);
    expect(buf.stretch[1]).toBe(3); // clamped to max
    expect(buf.stretch[2]).toBe(1); // clamped to min
  });

  it("minStretch floors the stretch even when the speed term is below 1", () => {
    const render: RenderConfig = { align: "none", speedScale: 0.01, minStretch: 1.5, maxStretch: 5 };
    const ls = simWith(render, [{ vx: 0, vy: 0 }]); // 1 + 0 = 1, floored to 1.5
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.stretch[0]).toBe(1.5);
  });

  it("align:velocity sets velAngle to atan2(velY,velX) in degrees", () => {
    const render: RenderConfig = { align: "velocity", speedScale: 0, minStretch: 1, maxStretch: 4 };
    const ls = simWith(render, [
      { vx: 10, vy: 0 }, // 0°
      { vx: 0, vy: 10 }, // 90° (clockwise from +x, Pixi y-down)
      { vx: -10, vy: 0 }, // 180°
    ]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.velAngle[0]).toBeCloseTo(0, 6);
    expect(buf.velAngle[1]).toBeCloseTo(90, 6);
    expect(buf.velAngle[2]).toBeCloseTo(180, 6);
  });

  it("falls back to pool.rotation when speed < 1e-3 (zero-speed)", () => {
    const render: RenderConfig = { align: "velocity", speedScale: 0.01, minStretch: 1, maxStretch: 4 };
    const ls = simWith(render, [{ vx: 0, vy: 0, rot: 37 }]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.velAngle[0]).toBe(37); // kept its own rotation, not atan2(0,0)=0
  });

  it("align:none keeps pool.rotation in velAngle (stretch still applies)", () => {
    const render: RenderConfig = { align: "none", speedScale: 0.01, minStretch: 1, maxStretch: 4 };
    const ls = simWith(render, [{ vx: 100, vy: 0, rot: 12 }]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    expect(buf.velAngle[0]).toBe(12);
    expect(buf.stretch[0]).toBeCloseTo(2, 6);
  });

  it("null render leaves stretch/velAngle buffers untouched (defaults 1 / 0)", () => {
    const ls = simWith(null, [{ vx: 500, vy: 500, rot: 90 }]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    // size/color still computed; stretch/velAngle never written.
    expect(buf.size[0]).toBeGreaterThan(0);
    expect(buf.stretch[0]).toBe(1); // makeRenderBuffers fill(1) default
    expect(buf.velAngle[0]).toBe(0); // default zero, never touched
  });

  it("randomFlip non-null + render null fills velAngle = pool.rotation, stretch untouched", () => {
    // randomFlip's presence routes the Pixi adapter through its extended loop
    // body, which reads velAngle/stretch — so an inert randomFlip must see the
    // fallback values (own rotation, stretch 1), not an all-zeros buffer.
    const layer: Layer = makeLayer({ render: null, randomFlip: { x: 0.5, y: 0.5 } });
    const ls = new LayerSim(layer, seed);
    const p = ls.pool;
    const i = p.spawn();
    p.velX[i] = 500;
    p.velY[i] = 500;
    p.rotation[i] = 33;
    p.age[i] = 0;
    p.lifetime[i] = 1;
    p.sizeInit[i] = 10;
    const buf = makeRenderBuffers(p.capacity);
    computeRenderState(ls, buf);
    expect(buf.velAngle[0]).toBe(33); // own rotation, NOT atan2 (render is null)
    expect(buf.stretch[0]).toBe(1); // pre-filled identity, never written
  });

  it("atan2 stretch axis is independent (scaleX would differ from scaleY)", () => {
    // A diagonal fast particle: stretch > 1 while angle points along the diagonal.
    const render: RenderConfig = { align: "velocity", speedScale: 0.01, minStretch: 1, maxStretch: 6 };
    const ls = simWith(render, [{ vx: 300, vy: 300 }]);
    const buf = makeRenderBuffers(ls.pool.capacity);
    computeRenderState(ls, buf);
    const speed = Math.hypot(300, 300);
    expect(buf.stretch[0]).toBeCloseTo(Math.min(6, 1 + 0.01 * speed), 6);
    expect(buf.velAngle[0]).toBeCloseTo(45, 6);
    expect(buf.stretch[0]).toBeGreaterThan(1); // scaleX = s·stretch ≠ scaleY = s
  });
});

describe("render module — determinism pin (zero draws, zero sim effect)", () => {
  const render: RenderConfig = { align: "velocity", speedScale: 0.02, minStretch: 1, maxStretch: 5 };
  const run = (doc: ReturnType<typeof makeDoc>): string => {
    const fx = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(99, 300);
    for (let i = 0; i < 300; i++) fx.step(dts[i]!);
    return stateHash(fx);
  };

  it("render:non-null produces the SAME sim stateHash as render:null (render is render-only)", () => {
    const withNull = makeDoc({ layers: [makeLayer({ render: null })] });
    const withRender = makeDoc({ layers: [makeLayer({ render })] });
    // render adds no PRNG draws and no pool writes, so simulation state is identical.
    expect(run(withRender)).toBe(run(withNull));
  });

  it("a render:non-null doc is bit-identical across two runs", () => {
    const doc = makeDoc({ layers: [makeLayer({ render })] });
    expect(run(doc)).toBe(run(doc));
  });
});
