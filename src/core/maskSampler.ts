// Emit-from-texture mask sampling (schemaVersion 4, §0.3a). Decodes the base64
// alpha mask ONCE, applies the threshold gate + alpha weights, and builds an
// integer prefix-sum CDF for O(log n) weighted position sampling. The sampler is
// config-derived (built in the LayerSim constructor and reused across resets);
// it returns null on ANY E23 condition (undecodable data, decoded length ≠
// width·height, or zero passing pixels) so the caller falls back to point-shape
// spawning. Pixi-free and Node-safe — the only format import is base64 (which is
// itself pixi-free), so `core/` never reaches into the renderer.
import type { Shape } from "../format/types.js";
import { decodeBase64 } from "../format/base64.js";
import type { SpawnSample } from "./shapes.js";

/** Texture-shape variant, narrowed for the sampler's build + sample math. */
type TextureShape = Extract<Shape, { kind: "texture" }>;

export class MaskSampler {
  /** Prefix-sum of the (gated, alpha-weighted) per-pixel weights, row-major. The
   * last entry equals `total`. Zero-weight pixels leave the CDF flat, so the
   * binary search can never land on one. */
  private readonly cdf: Uint32Array;
  /** Sum of all pixel weights (> 0 by construction — a zero total returns null). */
  private readonly total: number;
  private readonly mw: number;
  private readonly mh: number;

  constructor(cdf: Uint32Array, total: number, mw: number, mh: number) {
    this.cdf = cdf;
    this.total = total;
    this.mw = mw;
    this.mh = mh;
  }

  /**
   * Map three spawn uniforms to a position + direction (§0.3a). `uIdx` selects a
   * pixel by its weight (CDF binary search), `jx`/`jy` jitter inside that pixel,
   * and `uDir` gives a random outward-independent direction (like a point shape).
   * `shape` supplies the rendered `width`/`height` (mask centered on the origin,
   * y-down matching image rows). Returns the same struct `sampleShape` returns.
   */
  sample(uIdx: number, jx: number, jy: number, shape: TextureShape, uDir: number): SpawnSample {
    const target = uIdx * this.total;
    // First CDF entry strictly greater than target (upper-bound). Because uIdx is
    // in [0,1) and target < total = cdf[last], `lo` never exceeds the last index.
    let lo = 0;
    let hi = this.cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid]! > target) hi = mid;
      else lo = mid + 1;
    }
    const idx = lo;
    const col = idx % this.mw;
    const row = Math.floor(idx / this.mw);
    const px = ((col + jx) / this.mw - 0.5) * shape.width;
    const py = ((row + jy) / this.mh - 0.5) * shape.height;
    return { px, py, dirDeg: uDir * 360 };
  }
}

/**
 * Build a mask sampler for a texture shape, or null on any E23 condition. The
 * gate comparison is NORMATIVE and MUST match `validate.ts checkMask` exactly:
 * a pixel contributes weight iff `bytes[i] > 0 && bytes[i] >= threshold * 255`
 * (integer byte vs. the float `threshold*255`). If the two ever disagree a
 * document could warn-but-work or pass-but-degrade — so both sites share this
 * single comparison. Weight per passing pixel is the raw byte value (alpha
 * weights density, §0.3a); the CDF is an exact integer prefix sum (max
 * 128·128·255 < 2³²).
 */
export function buildMaskSampler(shape: TextureShape): MaskSampler | null {
  const mask = shape.mask;
  const bytes = decodeBase64(mask.data);
  if (bytes === null) return null; // E23: undecodable base64
  const mw = mask.width;
  const mh = mask.height;
  if (bytes.length !== mw * mh) return null; // E23: length mismatch
  const gate = shape.threshold * 255; // float compare — mirrors checkMask exactly
  const cdf = new Uint32Array(bytes.length);
  let total = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b > 0 && b >= gate) total += b;
    cdf[i] = total;
  }
  if (total === 0) return null; // E23: zero passing pixels
  return new MaskSampler(cdf, total, mw, mh);
}
