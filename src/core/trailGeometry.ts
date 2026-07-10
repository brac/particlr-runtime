// Per-frame trail ribbon geometry (schemaVersion 3, M9; connect mode v9, M1).
// Pure math over LayerSim state — NO pixi imports — so every renderer builds the
// identical mesh and preview/runtime parity holds by construction (L4). Fills
// caller-preallocated buffers (2 vertices per point, perpendicular extrusion) and
// reports the live vertex/index counts; a renderer uploads the buffers and draws
// the reported index count. Two point sources feed ONE strip builder (`emitStrip`):
// per-particle ribbons unpack each particle's own position ring, while a
// connect-mode layer threads ONE ribbon through all live particles' CURRENT
// positions (RIBBON_INHERIT_PLAN R2/R4). Deferred (not built here): texture
// tiling, mitered joins, linger after death, per-vertex width randomness.
import type { LayerSim } from "./layerSim.js";
import type { LayerRenderBuffers } from "./render.js";
import type { ScalarTrack, GradientTrack } from "../format/types.js";
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
 * indices per segment). Sized once at build; every frame writes a prefix. For a
 * per-particle layer call `makeTrailGeometry(capacity, maxPoints)`; a connect-mode
 * layer builds ONE ribbon of up to `capacity` points, so it calls
 * `makeTrailGeometry(1, capacity)` (verts = capacity·2, segs = capacity−1). */
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

// Ordered-point scratch (index 0 = newest/head → higher indices = older). Per-
// particle ribbons need only maxPoints (≤ 32) slots; a connect ribbon needs one
// slot per live particle (up to the layer capacity), so the buffers grow on
// demand and are reused thereafter — NO per-frame allocation in steady state.
// OX/OY carry the ordered positions, OCR..OCA each point's own particle RGBA, and
// ORD (connect only) the live-particle indices being sorted. Compute is
// synchronous and non-reentrant, so module-level scratch avoids per-call churn.
let SC = 32;
let OX = new Float32Array(SC);
let OY = new Float32Array(SC);
let OCR = new Float32Array(SC);
let OCG = new Float32Array(SC);
let OCB = new Float32Array(SC);
let OCA = new Float32Array(SC);
let ORD = new Uint32Array(SC);
function ensureScratch(n: number): void {
  if (n <= SC) return;
  SC = n;
  OX = new Float32Array(n);
  OY = new Float32Array(n);
  OCR = new Float32Array(n);
  OCG = new Float32Array(n);
  OCB = new Float32Array(n);
  OCA = new Float32Array(n);
  ORD = new Uint32Array(n);
}
// One gradient scratch shared by both builders (overwritten per vertex).
const GRAD: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Emit ONE ribbon strip of `len` ordered points (already staged in OX/OY and the
 * per-point OCR..OCA colour scratch) into `out`, starting at vertex `vc` and index
 * `ic`. Point k (k = 0 is the head = newest) sits at (OX[k], OY[k]); its two
 * vertices are extruded ±width/2 along the averaged unit normal of its adjacent
 * segments (NO mitering). `tTrail = k/(len−1)` runs 0 at the head to 1 at the tail;
 * `width` is evaluated at tTrail. Vertex RGBA: with `colorTrack` non-null it is the
 * gradient at tTrail (its rgb AND a) with the alpha scaled by the point's particle
 * alpha (OCA[k]); with `colorTrack` null it is the point's particle RGBA. Writes
 * (len−1)·6 indices; returns the new vertex count (the caller advances ic). Assumes
 * len ≥ 2.
 */
function emitStrip(out: TrailGeometry, vc: number, ic: number, len: number, width: ScalarTrack, colorTrack: GradientTrack | null): number {
  const pos = out.positions;
  const uv = out.uvs;
  const col = out.colors;
  const idx = out.indices;
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
      evalGradient(colorTrack, tT, GRAD);
      cr = GRAD.r;
      cg = GRAD.g;
      cb = GRAD.b;
      ca = GRAD.a * OCA[j]!;
    } else {
      cr = OCR[j]!;
      cg = OCG[j]!;
      cb = OCB[j]!;
      ca = OCA[j]!;
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
  return vc;
}

/**
 * Build one frame of PER-PARTICLE ribbon geometry from a layer's trail ring
 * buffers into `out`. `buf` supplies each particle's CURRENT render RGBA (used
 * when the trail has no own color). Points are read newest→oldest; a 1-point trail
 * emits no geometry (a ribbon needs ≥ 2 points). No-op (zero counts) when the layer
 * has no per-particle trail (a connect-mode layer has no ring store — see
 * `computeConnectGeometry`).
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
    const count = p.count;
    for (let i = 0; i < count; i++) {
      const len = store.len[i]!;
      if (len < 2) continue; // a ribbon needs at least two points
      const base = i * mp * 2;
      const head = store.head[i]!;
      const pr = buf.r[i]!;
      const pg = buf.g[i]!;
      const pb = buf.b[i]!;
      const pa = buf.a[i]!;
      // Unpack the ring newest→oldest into the ordered scratch; every point of a
      // per-particle ribbon shares its particle's current colour.
      for (let j = 0; j < len; j++) {
        let s = head - j;
        if (s < 0) s += mp;
        OX[j] = pts[base + s * 2]!;
        OY[j] = pts[base + s * 2 + 1]!;
        OCR[j] = pr;
        OCG[j] = pg;
        OCB[j] = pb;
        OCA[j] = pa;
      }
      vc = emitStrip(out, vc, ic, len, width, colorTrack);
      ic += (len - 1) * 6;
    }
  }
  out.vertexCount = vc;
  out.indexCount = ic;
}

/**
 * Build one frame of CONNECT-mode geometry (RIBBON_INHERIT_PLAN R2/R4): ONE ribbon
 * threaded through ALL of the layer's live particles' CURRENT positions, ordered
 * oldest→newest by their STABLE spawn ordinal (`pool.ordinal`) so a swap-remove kill
 * cannot reorder survivors (R3). `t = 0` is the NEWEST particle (head), matching the
 * per-particle head convention; `width`/`color` are sampled over t exactly as
 * `emitStrip` does for per-particle ribbons. `color` null ⇒ each vertex takes its own
 * particle's current render RGBA (from `buf`). Fewer than 2 live particles ⇒ empty
 * geometry (no degenerate quad). No ring store is read or allocated in connect mode
 * (R1/R2); `maxPoints`/`minVertexDistance` are ignored. The sim is NEVER reordered —
 * only this frame's view of it (a reusable index scratch, sorted per call).
 */
export function computeConnectGeometry(ls: LayerSim, buf: LayerRenderBuffers, out: TrailGeometry): void {
  const p = ls.pool;
  const trail = ls.layer.trail;
  const ord = p.ordinal;
  const count = p.count;
  let vc = 0;
  let ic = 0;
  // ord is the connect-mode ordinal column (allocated for connect layers, M1);
  // guard defensively so a mis-wired call is a no-op rather than a crash.
  if (trail !== null && ord !== null && count >= 2) {
    ensureScratch(count);
    for (let i = 0; i < count; i++) ORD[i] = i;
    // Order live particles newest→oldest by the stable spawn ordinal. Ordinals are
    // unique per spawn, so this is a deterministic total order (no ties, so sort
    // stability is irrelevant) and it is immune to swap-remove compaction.
    ORD.subarray(0, count).sort((a, b) => ord[b]! - ord[a]!);
    for (let k = 0; k < count; k++) {
      const i = ORD[k]!;
      OX[k] = p.x[i]!;
      OY[k] = p.y[i]!;
      OCR[k] = buf.r[i]!;
      OCG[k] = buf.g[i]!;
      OCB[k] = buf.b[i]!;
      OCA[k] = buf.a[i]!;
    }
    vc = emitStrip(out, 0, 0, count, trail.width, trail.color);
    ic = (count - 1) * 6;
  }
  out.vertexCount = vc;
  out.indexCount = ic;
}
