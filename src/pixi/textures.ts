// Procedural built-in textures (plan §2.11), generated as pure-math RGBA pixel
// buffers — NO canvas2d. This matters for the parity invariant: raw pixel math
// is bit-identical across browsers and GPUs, so the golden-frame test can run at
// pixel tolerance 0. RGB is white; only alpha varies, so tint colors freely.
import type { BuiltinTextureId } from "../format/types.js";

export interface TextureData {
  width: number;
  height: number;
  /** RGBA, straight (non-premultiplied) alpha, row-major. */
  pixels: Uint8Array;
}

function build(width: number, height: number, alphaAt: (x: number, y: number) => number): TextureData {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = Math.max(0, Math.min(1, alphaAt(x + 0.5, y + 0.5)));
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return { width, height, pixels };
}

const sq = (v: number) => v * v;

function circleSoft(): TextureData {
  const cx = 32;
  const cy = 32;
  return build(64, 64, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r >= 32 ? 0 : sq(1 - r / 32);
  });
}

function circleHard(): TextureData {
  const cx = 32;
  const cy = 32;
  return build(64, 64, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    if (r <= 28) return 1;
    if (r >= 30) return 0;
    return (30 - r) / 2;
  });
}

function square(): TextureData {
  // 48x48 centred in 64x64 (margin 8).
  return build(64, 64, (x, y) => (x >= 8 && x < 56 && y >= 8 && y < 56 ? 1 : 0));
}

function spark(): TextureData {
  // 64x16 streak, quadratic falloff from centre on both axes.
  const cx = 32;
  const cy = 8;
  return build(64, 16, (x, y) => {
    const ax = Math.max(0, 1 - Math.abs(x - cx) / 32);
    const ay = Math.max(0, 1 - Math.abs(y - cy) / 8);
    return sq(ax) * sq(ay);
  });
}

function smoke(): TextureData {
  // Sum of 5 fixed radial blobs (no PRNG — identical across runs).
  const blobs: [number, number, number, number][] = [
    // cx, cy, radius, weight
    [32, 32, 22, 0.55],
    [24, 26, 14, 0.4],
    [42, 30, 15, 0.4],
    [30, 42, 13, 0.35],
    [40, 40, 12, 0.3],
  ];
  return build(64, 64, (x, y) => {
    let a = 0;
    for (const [bx, by, br, bw] of blobs) {
      const r = Math.hypot(x - bx, y - by);
      if (r < br) a += bw * sq(1 - r / br);
    }
    return a;
  });
}

const GENERATORS: Record<BuiltinTextureId, () => TextureData> = {
  "circle-soft": circleSoft,
  "circle-hard": circleHard,
  square,
  spark,
  smoke,
};

export function generateBuiltinTexture(id: BuiltinTextureId): TextureData {
  return GENERATORS[id]();
}
