// Trail ribbons -> `BatchHandlerStrip.batchStrip` (the Rope path). Pure-ish:
// every Phaser object passes through opaquely, so this unit-tests with fakes.
//
// ---------------------------------------------------------------------------
// STEP-1 FINDINGS — the two real APIs this module sits between. Read before
// changing anything here; both were verified against the installed sources.
//
// A. `core/trailGeometry.ts` (TrailGeometry, the producer)
//   - positions: 2 floats/vertex (sim frame, y-down — same frame the quads use,
//     so NO axis flip is needed for Phaser); uvs: 2 floats/vertex (u = t along
//     the trail, v = 0/1 across); colors: 4 FLOATS/vertex (r,g,b,a straight
//     alpha, 0..1); indices: Uint32; `vertexCount`/`indexCount` are the live
//     prefix written this frame — the buffers themselves are worst-case sized.
//   - Layout: `emitStrip` writes 2 vertices per trail POINT, +normal first then
//     −normal, points ordered head (newest, t=0) -> tail. Ribbons are packed
//     back to back into the same buffers; a ribbon of `len` points occupies
//     `2*len` consecutive vertices. A ribbon of len < 2 emits nothing.
//   - There is NO per-ribbon length array. Boundaries are recovered from the
//     index stream: each segment writes 6 indices starting at `a = vbase + j*2`,
//     so within a ribbon consecutive segment starts advance by exactly 2, while
//     the first segment of the NEXT ribbon jumps by 4 (the last point of the
//     previous ribbon contributes 2 vertices but no segment). That +4 jump is
//     the ribbon boundary. The last ribbon ends at `lastA + 4`.
//   - Connect mode produces exactly ONE ribbon (`computeConnectGeometry`), so
//     the same walk yields a single call.
//
// B. `phaser/src/renderer/webgl/renderNodes/BatchHandlerStrip.js` (the consumer)
//   - `batchStrip(drawingContext, src, calcMatrix, glTexture, vertices, uv,
//      colors, alphas, alpha, tintMode, renderOptions, debugCallback?)`.
//   - It TRANSFORMS THE VERTICES ITSELF: `tx = x*a + y*c + e`, `ty = x*b + y*d
//     + f` using `calcMatrix.a..f`. So we pass LOCAL vertices plus Phaser's own
//     `TransformMatrix` straight through — this module never multiplies, and it
//     therefore has no use for a `Mat2D` argument (see the brief's sketch).
//   - `vertices` MUST be exactly the ribbon: instance count is derived as
//     `vertices.length / 4` (2 verts per instance), and a strip is one draw of
//     that whole array. Hence one call per ribbon with an exact-length view.
//   - COLOUR PACKING: it calls `getTintAppendFloatAlpha(colors[i/2],
//     alphas[i/2] * alpha)`, i.e. `colors` is a Uint24 **0xRRGGBB** word and the
//     alpha rides the separate float array — NOT a packed ABGR/RGBA word.
//   - Strips are linked inside one batch by degenerate triangles that the
//     handler inserts itself (it repeats the previous last vertex and our first
//     vertex when `instanceCount > 0`), so consecutive calls need no padding
//     from us and do not break the draw call.
//   - `renderOptions` is diffed by `updateRenderOptions` and a change FLUSHES
//     the batch, so the caller must pass ONE persistent object (same rule as
//     BatchHandlerQuad).
// ---------------------------------------------------------------------------
import type { TrailGeometry } from "../core/trailGeometry.js";
import { to255 } from "./submit.js";

/**
 * The slice of `Phaser.Renderer.WebGL.RenderNodes.BatchHandlerStrip` this
 * module needs. Structural, so the unit test drives it with a capture double.
 */
export interface StripBatchLike {
  batchStrip(
    drawingContext: unknown,
    src: unknown,
    calcMatrix: unknown,
    glTexture: unknown,
    vertices: Float32Array,
    uv: Float32Array,
    colors: Uint32Array,
    alphas: Float32Array,
    alpha: number,
    tintMode: number,
    renderOptions: object,
  ): void;
}

/**
 * Per-layer submission scratch: the four arrays `batchStrip` reads, sized once
 * for the longest ribbon the layer can produce. `batchStrip` needs an array
 * whose LENGTH is the ribbon, so the exact-length views are memoised on the
 * last ribbon size seen — ribbons within a layer overwhelmingly share a length
 * (saturated per-particle rings; connect mode has a single ribbon), so steady
 * state allocates nothing at all.
 */
export interface TrailScratch {
  readonly verts: Float32Array;
  readonly uv: Float32Array;
  readonly colors: Uint32Array;
  readonly alphas: Float32Array;
  /** Vertex count the cached views below are cut to (0 = none yet). */
  n: number;
  vView: Float32Array;
  uvView: Float32Array;
  cView: Uint32Array;
  aView: Float32Array;
}

/** `maxVerts` = the most vertices ONE ribbon of this layer can hold. */
export function makeTrailScratch(maxVerts: number): TrailScratch {
  const verts = new Float32Array(maxVerts * 2);
  const uv = new Float32Array(maxVerts * 2);
  const colors = new Uint32Array(maxVerts);
  const alphas = new Float32Array(maxVerts);
  return {
    verts,
    uv,
    colors,
    alphas,
    n: 0,
    vView: verts.subarray(0, 0),
    uvView: uv.subarray(0, 0),
    cView: colors.subarray(0, 0),
    aView: alphas.subarray(0, 0),
  };
}

/** Multiply mode — the same tint mode the quad path submits with. */
const TINT_MODE_MULTIPLY = 0;

/**
 * The GO-level alpha multiplier. Held at 1 deliberately: the quad path bakes
 * per-particle alpha into the tint and ignores the Game Object's own alpha, so
 * a trail must too or a layer's ribbons and sprites would fade apart.
 */
const GO_ALPHA = 1;

function views(s: TrailScratch, n: number): void {
  if (s.n === n) return;
  s.n = n;
  s.vView = s.verts.subarray(0, n * 2);
  s.uvView = s.uv.subarray(0, n * 2);
  s.cView = s.colors.subarray(0, n);
  s.aView = s.alphas.subarray(0, n);
}

/**
 * Submit the live range of `geom` as one `batchStrip` call per ribbon.
 * `calcMatrix` is Phaser's composed transform, passed straight through —
 * `batchStrip` applies it to every vertex itself (finding B above).
 */
export function submitTrailStrips(
  handler: StripBatchLike,
  ctx: unknown,
  src: unknown,
  calcMatrix: unknown,
  glTexture: unknown,
  geom: TrailGeometry,
  scratch: TrailScratch,
  renderOptions: object,
): void {
  const ic = geom.indexCount;
  if (ic === 0) return;
  const idx = geom.indices;
  const cap = scratch.alphas.length;

  // Walk the segment starts; a jump of more than 2 opens a new ribbon.
  let start = idx[0]!;
  let prev = start;
  for (let k = 6; k < ic; k += 6) {
    const a = idx[k]!;
    if (a !== prev + 2) {
      emit(handler, ctx, src, calcMatrix, glTexture, geom, scratch, renderOptions, start, prev + 4, cap);
      start = a;
    }
    prev = a;
  }
  emit(handler, ctx, src, calcMatrix, glTexture, geom, scratch, renderOptions, start, prev + 4, cap);
}

/** One ribbon: vertices `[v0, v1)` of the geometry, copied into the scratch. */
function emit(
  handler: StripBatchLike,
  ctx: unknown,
  src: unknown,
  calcMatrix: unknown,
  glTexture: unknown,
  geom: TrailGeometry,
  s: TrailScratch,
  renderOptions: object,
  v0: number,
  v1: number,
  cap: number,
): void {
  const n = v1 - v0;
  // A ribbon longer than the scratch cannot happen (the scratch is sized from
  // the same geometry), but a mis-sized layer must drop the ribbon, not write
  // out of bounds.
  if (n < 2 || n > cap) return;
  views(s, n);

  const pos = geom.positions;
  const guv = geom.uvs;
  const gcol = geom.colors;
  const verts = s.verts;
  const uv = s.uv;
  const colors = s.colors;
  const alphas = s.alphas;

  for (let i = 0; i < n; i++) {
    const src2 = (v0 + i) * 2;
    const dst2 = i * 2;
    verts[dst2] = pos[src2]!;
    verts[dst2 + 1] = pos[src2 + 1]!;
    uv[dst2] = guv[src2]!;
    uv[dst2 + 1] = guv[src2 + 1]!;
    const o4 = (v0 + i) * 4;
    colors[i] = (to255(gcol[o4]!) << 16) | (to255(gcol[o4 + 1]!) << 8) | to255(gcol[o4 + 2]!);
    const a = gcol[o4 + 3]!;
    alphas[i] = a < 0 ? 0 : a > 1 ? 1 : a;
  }

  handler.batchStrip(
    ctx,
    src,
    calcMatrix,
    glTexture,
    s.vView,
    s.uvView,
    s.cView,
    s.aView,
    GO_ALPHA,
    TINT_MODE_MULTIPLY,
    renderOptions,
  );
}
