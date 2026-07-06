// Easing functions for curve segments (plan §2.2). Each maps a normalized
// position u in [0,1] between two keys to an interpolation fraction. `ease` on a
// key describes the segment FROM this key TO the next; the last key's ease is
// unused.
import type { Ease } from "../format/types.js";

export type EaseFn = (u: number) => number;

export const EASING: Record<Ease, EaseFn> = {
  linear: (u) => u,
  easeIn: (u) => u * u,
  easeOut: (u) => 1 - (1 - u) * (1 - u),
  easeInOut: (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)),
  // Hold this key's value until the next key (fraction 0 for u < 1).
  step: (u) => (u < 1 ? 0 : 1),
};

export function ease(kind: Ease | undefined, u: number): number {
  return (kind ? EASING[kind] : EASING.linear)(u);
}
