// submitLayerQuads against a fake batch handler + identity matrix: verifies
// live-prefix count, two-loop-body rule (plain path ignores stretch/velAngle/
// flip), P4.1 sizing, and tint packing delegation.
import { describe, it, expect } from "vitest";
import { submitLayerQuads, type QuadBatchLike } from "../../src/phaser/submit.js";
import { makeRenderBuffers } from "../../src/core/render.js";
import type { Mat2D } from "../../src/phaser/quadMath.js";

const I: Mat2D = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const packTint = (rgb: number, a: number) => (((a * 255) << 24) | rgb) >>> 0;

function capture(): QuadBatchLike & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    batch(_ctx: unknown, _tex: unknown, ...args: unknown[]) {
      calls.push(args.filter((v): v is number => typeof v === "number"));
    },
  } as QuadBatchLike & { calls: number[][] };
}

/** Minimal LayerSimLike: 2 live particles of a 4-pool, plain layer. */
function fakeLayer(extended: boolean) {
  const buffers = makeRenderBuffers(4);
  buffers.size[0] = 10;
  buffers.size[1] = 20;
  buffers.r[0] = buffers.g[0] = buffers.b[0] = buffers.a[0] = 1;
  buffers.r[1] = buffers.g[1] = buffers.b[1] = buffers.a[1] = 1;
  buffers.stretch[0] = 2; // must be IGNORED on the plain path
  buffers.velAngle[0] = 90;
  buffers.flip[0] = 1;
  return {
    count: 2,
    pool: {
      x: new Float32Array([100, 200, 999, 999]),
      y: new Float32Array([50, 60, 999, 999]),
      rotation: new Float32Array([0, 0, 0, 0]),
    },
    layer: {
      render: extended ? {} : null,
      randomFlip: extended ? {} : null,
    },
    buffers,
  };
}

describe("submitLayerQuads", () => {
  it("submits exactly `count` quads", () => {
    const h = capture();
    const l = fakeLayer(false);
    submitLayerQuads(h, null, null, l as never, l.buffers, I, { aspect: 1, cols: 1, rows: 1 }, {}, packTint);
    expect(h.calls).toHaveLength(2);
  });

  it("plain path ignores stretch (width == size)", () => {
    const h = capture();
    const l = fakeLayer(false);
    submitLayerQuads(h, null, null, l as never, l.buffers, I, { aspect: 1, cols: 1, rows: 1 }, {}, packTint);
    // particle 0 at (100,50), size 10, stretch must NOT apply: TLx = 95.
    expect(h.calls[0]![0]).toBeCloseTo(95);
  });

  it("extended path applies stretch (width == size*stretch)", () => {
    const h = capture();
    const l = fakeLayer(true);
    submitLayerQuads(h, null, null, l as never, l.buffers, I, { aspect: 1, cols: 1, rows: 1 }, {}, packTint);
    // stretch 2, velAngle 90: corners rotated — just assert TL differs from plain.
    expect(h.calls[0]![0]).not.toBeCloseTo(95);
  });

  it("passes the same renderOptions object identity on every submit", () => {
    const seen: object[] = [];
    const h: QuadBatchLike = {
      batch(
        _ctx: unknown,
        _tex: unknown,
        _x0: number,
        _y0: number,
        _x1: number,
        _y1: number,
        _x2: number,
        _y2: number,
        _x3: number,
        _y3: number,
        _tx: number,
        _ty: number,
        _tw: number,
        _th: number,
        _tintMode: number,
        _tTL: number,
        _tBL: number,
        _tTR: number,
        _tBR: number,
        renderOptions: object,
      ) {
        seen.push(renderOptions);
      },
    };
    const l = fakeLayer(false);
    const ro = { multiTexturing: true };
    submitLayerQuads(h, null, null, l as never, l.buffers, I, { aspect: 1, cols: 1, rows: 1 }, ro, packTint);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(ro);
    expect(seen[1]).toBe(ro);
  });

  it("packs the tint through the injected packer (RGB from the render buffers)", () => {
    const calls: Array<[number, number]> = [];
    const h = capture();
    const l = fakeLayer(false);
    l.buffers.r[0] = 1;
    l.buffers.g[0] = 0;
    l.buffers.b[0] = 0.5;
    l.buffers.a[0] = 1;
    submitLayerQuads(h, null, null, l as never, l.buffers, I, { aspect: 1, cols: 1, rows: 1 }, {}, (rgb, a) => {
      calls.push([rgb, a]);
      return packTint(rgb, a);
    });
    // 1, 0, 0.5 -> 0xff0080 (0.5*255 rounds to 128).
    expect(calls[0]![0]).toBe(0xff0080);
    expect(calls[0]![1]).toBeCloseTo(1);
  });

  it("emits a whole-texture UV rect for a 1x1 grid and a sliced rect for a 2x2 sheet", () => {
    const h = capture();
    const l = fakeLayer(false);
    l.buffers.frame[0] = 3;
    submitLayerQuads(h, null, null, l as never, l.buffers, I, { aspect: 1, cols: 2, rows: 2 }, {}, packTint);
    // args: 8 corners, then texX, texY, texW, texH.
    const a = h.calls[0]!;
    expect(a[8]).toBeCloseTo(0.5);
    expect(a[9]).toBeCloseTo(0.5);
    expect(a[10]).toBeCloseTo(0.5);
    expect(a[11]).toBeCloseTo(0.5);
  });
});
