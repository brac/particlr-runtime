// particlr blend string -> Phaser blend index, per the normative table in the
// plan/README. Native Phaser modes cover normal/multiply/screen/erase exactly
// (Phaser's ERASE is REVERSE_SUBTRACT ZERO,OMSA — same result as our
// AddEquation destination-out). Phaser's built-in ADD is ONE,DST_ALPHA which
// diverges from our ONE,ONE on non-opaque targets, so `add` registers a custom
// slot per renderer.
//
// 4.2.1 bug: addBlendMode returns index-1 (off by one). We read
// blendModes.length - 1 instead, which is correct on fixed versions too.
import type { BlendMode } from "../format/types.js";

/** The slice of Phaser's WebGLRenderer this module needs (structural, so unit
 * tests need no real renderer). */
export interface PhaserBlendRegistry {
  blendModes: unknown[];
  addBlendMode(func: number[], equation: number): number;
}

const GL_ONE = 1;
const GL_FUNC_ADD = 0x8006;

// Phaser.BlendModes constants (canary-pinned in test/phaser/canary.test.ts).
const NATIVE: Partial<Record<BlendMode, number>> = {
  normal: 0, // NORMAL
  multiply: 2, // MULTIPLY
  screen: 3, // SCREEN
  erase: 17, // ERASE
};

const customAdd = new WeakMap<PhaserBlendRegistry, number>();

export function phaserBlendIndex(renderer: PhaserBlendRegistry, mode: BlendMode): number {
  const native = NATIVE[mode];
  if (native !== undefined) return native;
  // mode === "add"
  const existing = customAdd.get(renderer);
  if (existing !== undefined) return existing;
  renderer.addBlendMode([GL_ONE, GL_ONE], GL_FUNC_ADD);
  const idx = renderer.blendModes.length - 1;
  customAdd.set(renderer, idx);
  return idx;
}
