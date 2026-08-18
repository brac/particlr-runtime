// The per-layer hot loop: buffers -> BatchHandlerQuad.batch calls. Pure-ish
// (every Phaser object passes through opaquely) so it unit-tests with fakes.
//
// Two loop bodies (normative, core/render.ts:247 + the pixi/three adapters):
// the plain path reads `pool.rotation` and ignores stretch/velAngle/flip so the
// committed goldens stay byte-identical; the extended path — taken only when
// the layer carries a `render` or `randomFlip` module — reads the full render
// buffers. Which body runs is decided ONCE per layer, outside the loop.
import { computeParticleQuad, frameUV, type Mat2D } from "./quadMath.js";
import type { LayerRenderBuffers } from "../core/render.js";

/**
 * The slice of `Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad` this module
 * needs. Structural, so the unit test drives it with a capture double and the
 * adapter never imports the concrete node type here.
 *
 * Corners are TL, BL, TR, BR already transformed into screen space.
 */
export interface QuadBatchLike {
  batch(
    ctx: unknown,
    glTexture: unknown,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    texX: number,
    texY: number,
    texW: number,
    texH: number,
    tintMode: number,
    tTL: number,
    tBL: number,
    tTR: number,
    tBR: number,
    renderOptions: object,
  ): void;
}

/** The slice of `LayerSim` the submit loop reads. */
export interface LayerSimLike {
  count: number;
  pool: { x: Float32Array; y: Float32Array; rotation: Float32Array };
  layer: { render: unknown; randomFlip: unknown };
}

export interface FrameInfo {
  /** frameH / frameW — P4.1 sizing: a particle is `size` px wide, `size*aspect` tall. */
  aspect: number;
  cols: number;
  rows: number;
}

// Module-scope scratch: the submit loop is single-threaded and re-entrant only
// through `handler.batch`, which consumes both before returning.
const quad = new Float32Array(8);
const uv = new Float32Array(4);

/** Multiply mode — BatchHandlerQuad's default tint mode. */
const TINT_MODE_MULTIPLY = 0;

/** 0..1 float channel -> clamped 0..255 byte. Shared with `trailStrip.ts`. */
export function to255(v: number): number {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

export function submitLayerQuads(
  handler: QuadBatchLike,
  ctx: unknown,
  glTexture: unknown,
  ls: LayerSimLike,
  b: LayerRenderBuffers,
  m: Mat2D,
  frame: FrameInfo,
  renderOptions: object,
  packTint: (rgb: number, a: number) => number,
): void {
  const count = ls.count;
  const pool = ls.pool;
  const x = pool.x;
  const y = pool.y;
  const rotation = pool.rotation;
  const extended = ls.layer.render !== null || ls.layer.randomFlip !== null;
  const aspect = frame.aspect;
  const cols = frame.cols;
  const rows = frame.rows;

  for (let i = 0; i < count; i++) {
    const alpha = b.a[i]!;
    const rgb = (to255(b.r[i]!) << 16) | (to255(b.g[i]!) << 8) | to255(b.b[i]!);
    const tint = packTint(rgb, alpha < 0 ? 0 : alpha > 1 ? 1 : alpha);

    if (extended) {
      computeParticleQuad(quad, x[i]!, y[i]!, b.size[i]!, aspect, b.stretch[i]!, b.velAngle[i]!, b.flip[i]!, m);
    } else {
      computeParticleQuad(quad, x[i]!, y[i]!, b.size[i]!, aspect, 1, rotation[i]!, 0, m);
    }
    frameUV(uv, b.frame[i]!, cols, rows);

    handler.batch(
      ctx,
      glTexture,
      quad[0]!,
      quad[1]!,
      quad[2]!,
      quad[3]!,
      quad[4]!,
      quad[5]!,
      quad[6]!,
      quad[7]!,
      uv[0]!,
      uv[1]!,
      uv[2]!,
      uv[3]!,
      TINT_MODE_MULTIPLY,
      tint,
      tint,
      tint,
      tint,
      renderOptions,
    );
  }
}
