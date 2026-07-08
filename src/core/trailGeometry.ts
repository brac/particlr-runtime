// Per-frame trail ribbon geometry (schemaVersion 3, M9). Pure math over LayerSim
// state — NO pixi imports — so every renderer builds the identical mesh and
// preview/runtime parity holds by construction (L4). Fills caller-preallocated
// buffers (2 vertices per recorded point, perpendicular extrusion) and reports
// the live vertex/index counts; a renderer uploads the buffers and draws the
// reported index count. Deferred (not built here): texture tiling, mitered
// joins, linger after death, per-vertex width randomness.
import type { LayerSim } from "./layerSim.js";
import type { LayerRenderBuffers } from "./render.js";
import { evalScalarTrack, evalGradient, type RGBA } from "./tracks.js";

// Guards normal/tangent normalization against a near-zero segment (the head-to-
// first-recorded segment can be tiny even though minVertexDistance gates pushes).
const EPS = 1e-6;

export interface TrailGeometry {
  /** 2 floats per vertex (x, y in the layer's sim frame). */
  positions: Float32Array;
  /** 2 floats per vertex (u along the trail 0→1, v across 0/1). */
  uvs: Float32Array;
  /** 4 floats per vertex (r, g, b, a). */
  colors: Float32Array;
  /** Uint32 (a ribbon can exceed 65535 vertices at the memory-bound cap). */
  indices: Uint32Array;
  /** Live vertex count written this frame (≤ capacity·maxPoints·2). */
  vertexCount: number;
  /** Live index count written this frame — the renderer's draw range. */
  indexCount: number;
}

/** Preallocate the worst-case buffers for a trail layer (2 verts/point, 6
 * indices per segment). Sized once at build; every frame writes a prefix. */
export function makeTrailGeometry(capacity: number, maxPoints: number): TrailGeometry {
  const verts = capacity * maxPoints * 2;
  const segs = capacity * (maxPoints - 1);
  return {
    positions: new Float32Array(verts * 2),
    uvs: new Float32Array(verts * 2),
    colors: new Float32Array(verts * 4),
    indices: new Uint32Array(segs * 6),
    vertexCount: 0,
    indexCount: 0,
  };
}

// Ordered-point scratch (newest→oldest); maxPoints ≤ 32 (validator), and compute
// is synchronous and non-reentrant, so two module-level buffers avoid a per-
// particle allocation.
const OX = new Float32Array(32);
const OY = new Float32Array(32);

/**
 * Build one frame of ribbon geometry from a layer's trail ring buffers into
 * `out`. `buf` supplies each particle's CURRENT render RGBA (used when the trail
 * has no own color). Points are read newest→oldest; `tTrail` runs 0 at the head
 * (newest) to 1 at the tail (oldest). Width = `evalScalarTrack(trail.width,
 * tTrail, 0)`; a point's two vertices are extruded ±width/2 along the averaged-
 * segment normal. Vertex RGBA: with `trail.color` non-null it is the gradient at
 * tTrail (its own rgb AND a) with the alpha scaled by the particle's current
 * alpha; with `trail.color` null it is the particle's current render RGBA. A
 * 1-point trail emits no geometry (a ribbon needs ≥ 2 points). No-op (zero
 * counts) when the layer has no trail.
 */
export function computeTrailGeometry(ls: LayerSim, buf: LayerRenderBuffers, out: TrailGeometry): void {
  const p = ls.pool;
  const store = p.trail;
  const trail = ls.layer.trail;
  let vc = 0;
  let ic = 0;
  if (store !== null && trail !== null) {
    const mp = store.maxPoints;
    const width = trail.width;
    const colorTrack = trail.color;
    const pts = store.pts;
    const pos = out.positions;
    const uv = out.uvs;
    const col = out.colors;
    const idx = out.indices;
    const grad: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    const count = p.count;
    for (let i = 0; i < count; i++) {
      const len = store.len[i]!;
      if (len < 2) continue; // a ribbon needs at least two points
      const base = i * mp * 2;
      const head = store.head[i]!;
      // Unpack the ring newest→oldest into the ordered scratch.
      for (let j = 0; j < len; j++) {
        let s = head - j;
        if (s < 0) s += mp;
        OX[j] = pts[base + s * 2]!;
        OY[j] = pts[base + s * 2 + 1]!;
      }
      const pr = buf.r[i]!;
      const pg = buf.g[i]!;
      const pb = buf.b[i]!;
      const pa = buf.a[i]!;
      const denom = len - 1;
      const vbase = vc;
      for (let j = 0; j < len; j++) {
        const x = OX[j]!;
        const y = OY[j]!;
        // Averaged unit tangent of the (up to) two adjacent segments — a simple
        // per-vertex normal, NO mitering (deferred). Each segment guarded by EPS.
        let tx = 0;
        let ty = 0;
        if (j > 0) {
          const ax = x - OX[j - 1]!;
          const ay = y - OY[j - 1]!;
          const l = Math.sqrt(ax * ax + ay * ay);
          if (l > EPS) {
            tx += ax / l;
            ty += ay / l;
          }
        }
        if (j < denom) {
          const bx = OX[j + 1]! - x;
          const by = OY[j + 1]! - y;
          const l = Math.sqrt(bx * bx + by * by);
          if (l > EPS) {
            tx += bx / l;
            ty += by / l;
          }
        }
        let tl = Math.sqrt(tx * tx + ty * ty);
        if (tl < EPS) {
          // Fully degenerate (both neighbours coincide): pick an arbitrary axis.
          tx = 1;
          ty = 0;
          tl = 1;
        }
        const nx = -ty / tl;
        const ny = tx / tl;
        const tT = j / denom; // 0 = head (newest) → 1 = tail (oldest)
        const w = evalScalarTrack(width, tT, 0) * 0.5;
        let cr: number;
        let cg: number;
        let cb: number;
        let ca: number;
        if (colorTrack !== null) {
          evalGradient(colorTrack, tT, grad);
          cr = grad.r;
          cg = grad.g;
          cb = grad.b;
          ca = grad.a * pa;
        } else {
          cr = pr;
          cg = pg;
          cb = pb;
          ca = pa;
        }
        // Two extruded vertices: v = 0 on the +normal side, v = 1 on the −normal.
        let o2 = vc * 2;
        let o4 = vc * 4;
        pos[o2] = x + nx * w;
        pos[o2 + 1] = y + ny * w;
        uv[o2] = tT;
        uv[o2 + 1] = 0;
        col[o4] = cr;
        col[o4 + 1] = cg;
        col[o4 + 2] = cb;
        col[o4 + 3] = ca;
        vc++;
        o2 = vc * 2;
        o4 = vc * 4;
        pos[o2] = x - nx * w;
        pos[o2 + 1] = y - ny * w;
        uv[o2] = tT;
        uv[o2 + 1] = 1;
        col[o4] = cr;
        col[o4 + 1] = cg;
        col[o4 + 2] = cb;
        col[o4 + 3] = ca;
        vc++;
      }
      // Two triangles per segment between consecutive points.
      for (let j = 0; j < denom; j++) {
        const a = vbase + j * 2;
        idx[ic] = a;
        idx[ic + 1] = a + 1;
        idx[ic + 2] = a + 2;
        idx[ic + 3] = a + 2;
        idx[ic + 4] = a + 1;
        idx[ic + 5] = a + 3;
        ic += 6;
      }
    }
  }
  out.vertexCount = vc;
  out.indexCount = ic;
}
