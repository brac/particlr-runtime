// Pure per-particle quad math. Corner order TL,BL,TR,BR matches
// BatchHandlerQuad.batch. y-down, angles in degrees (buffer convention),
// P4.1 sizing: width = size*stretch, height = size*aspect (aspect =
// frameH/frameW). Flip bits mirror in LOCAL space (before rotation), matching
// the Pixi adapter's negative-scale mirror. No allocation: caller owns `out`.
const DEG2RAD = Math.PI / 180;

/** Phaser TransformMatrix component layout (a,b,c,d,tx,ty). */
export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export function computeParticleQuad(
  out: Float32Array,
  cx: number,
  cy: number,
  sizePx: number,
  aspect: number,
  stretch: number,
  angleDeg: number,
  flipBits: number,
  m: Mat2D,
): void {
  const hw = (sizePx * stretch) / 2;
  const hh = (sizePx * aspect) / 2;
  const sx = (flipBits & 1) !== 0 ? -1 : 1;
  const sy = (flipBits & 2) !== 0 ? -1 : 1;
  const rad = angleDeg * DEG2RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Local corners TL, BL, TR, BR (y-down: top = -hh), mirrored by flip.
  // Unrolled loop: four explicit corner blocks (same math, zero allocation).

  // TL corner
  let lx = -hw * sx;
  let ly = -hh * sy;
  let rx = lx * cos - ly * sin + cx;
  let ry = lx * sin + ly * cos + cy;
  out[0] = rx * m.a + ry * m.c + m.tx;
  out[1] = rx * m.b + ry * m.d + m.ty;

  // BL corner
  lx = -hw * sx;
  ly = hh * sy;
  rx = lx * cos - ly * sin + cx;
  ry = lx * sin + ly * cos + cy;
  out[2] = rx * m.a + ry * m.c + m.tx;
  out[3] = rx * m.b + ry * m.d + m.ty;

  // TR corner
  lx = hw * sx;
  ly = -hh * sy;
  rx = lx * cos - ly * sin + cx;
  ry = lx * sin + ly * cos + cy;
  out[4] = rx * m.a + ry * m.c + m.tx;
  out[5] = rx * m.b + ry * m.d + m.ty;

  // BR corner
  lx = hw * sx;
  ly = hh * sy;
  rx = lx * cos - ly * sin + cx;
  ry = lx * sin + ly * cos + cy;
  out[6] = rx * m.a + ry * m.c + m.tx;
  out[7] = rx * m.b + ry * m.d + m.ty;
}

/**
 * Flipbook window for `frame`, in the coordinates `BatchHandlerQuad.batch`
 * expects: `(texX, texY, texWidth, texHeight)` where `texY` pairs with the
 * quad's TOP vertices and the bottom vertices get `texY + texHeight`.
 *
 * **V IS BOTTOM-UP.** Phaser's own `Textures.Frame` computes its UVs as
 * `u0 = cx/tw`, `v0 = 1 - cy/th`, `u1 = (cx+cw)/tw`, `v1 = 1 - (cy+ch)/th`
 * (`node_modules/phaser/src/textures/Frame.js` `updateUVs`) — i.e. every
 * Phaser texture samples with v=0 at the BOTTOM of the source image, and a
 * frame's height (`v1 - v0`) is NEGATIVE. So a top-down `row * vh` window,
 * which is what the sibling adapters use, samples the vertically mirrored
 * image: with a 4x4 sheet, frame 0 lands on the sheet's BOTTOM-left tile and
 * each tile draws upside down. That is invisible for the built-in textures
 * (all vertically symmetric) and shows up the moment a real sheet is used —
 * `presets/blast-anim.prt` played its 16 frames in reverse.
 *
 * Mirroring v here (rather than at the quad) keeps the flip at the single
 * point where texture space is entered, so the quad math, the flip bitmask and
 * the rotation all stay in one screen-space convention.
 */
export function frameUV(out: Float32Array, frame: number, cols: number, rows: number): void {
  const uw = 1 / cols;
  const vh = 1 / rows;
  out[0] = (frame % cols) * uw;
  out[1] = 1 - Math.floor(frame / cols) * vh;
  out[2] = uw;
  out[3] = -vh;
}
