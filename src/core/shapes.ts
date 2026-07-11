// Spawn-position + initial-velocity-direction sampling per shape (plan §2.1).
// Coordinates are Pixi: +x right, +y down, angles in degrees clockwise from +x
// (so -90 deg points up). The caller draws exactly three uniforms first
// (uPos1, uPos2, uDir) regardless of shape; shapes that need fewer discard the
// surplus — this keeps the PRNG draw count shape-independent (§2.7).
import type { Shape } from "../format/types.js";

export interface SpawnSample {
  px: number;
  py: number;
  /** Direction of initial velocity, degrees (magnitude comes from initial.speed). */
  dirDeg: number;
}

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * `arcT` (schemaVersion 3): a driven angle fraction in [0,1] that REPLACES the
 * circle/cone angle uniform (`uPos1`) when the shape's `arcMode !== "random"`.
 * `arcT < 0` (the default) means "no override — use the drawn `uPos1`". The
 * caller ALWAYS draws `uPos1` upstream regardless, so `arcT` never changes the
 * PRNG draw count: it is only consulted here, and the discarded `uPos1` keeps
 * the fixed 13-draw spawn order intact (§0.2). Point/rect/edge ignore `arcT`.
 */
export function sampleShape(shape: Shape, uPos1: number, uPos2: number, uDir: number, arcT = -1): SpawnSample {
  switch (shape.kind) {
    case "point":
      return { px: 0, py: 0, dirDeg: uDir * 360 };

    case "circle": {
      // Angle fraction across the arc span. A non-random arc mode with a driven
      // arcT replaces the angle uniform (uPos1 is still drawn upstream and here
      // discarded). arc° / 360 is exactly 1.0 for the default full disc, so the
      // v2 `uPos1 * TAU` is reproduced bit-for-bit.
      const af = shape.arcMode !== "random" && arcT >= 0 ? arcT : uPos1;
      const theta = af * (shape.arc / 360) * TAU;
      // Radius: surface = the OUTER circumference only; volume with innerRadius 0
      // keeps the v2 form byte-identically; a donut (innerRadius > 0) draws an
      // area-uniform radius in the annulus, r = √(lerp(inner², outer², uPos2)).
      let r: number;
      if (shape.emitFrom === "surface") {
        r = shape.radius;
      } else if (shape.innerRadius > 0) {
        const inner2 = shape.innerRadius * shape.innerRadius;
        const outer2 = shape.radius * shape.radius;
        r = Math.sqrt(inner2 + (outer2 - inner2) * uPos2);
      } else {
        r = shape.radius * Math.sqrt(uPos2);
      }
      const px = r * Math.cos(theta);
      const py = r * Math.sin(theta);
      // radially outward; a particle exactly at the centre gets a random angle.
      const dirDeg = r === 0 ? uDir * 360 : theta * DEG;
      return { px, py, dirDeg };
    }

    case "cone": {
      // Angle sampled first, then radius, so position and direction stay
      // consistent for emitFrom:"volume" (§2.1). A non-random arc mode with a
      // driven arcT replaces the angle uniform within the spread (uPos1 is still
      // drawn upstream and here discarded — 13-draw order intact).
      const af = shape.arcMode !== "random" && arcT >= 0 ? arcT : uPos1;
      const a = shape.direction - shape.spread / 2 + af * shape.spread;
      const r = shape.emitFrom === "surface" ? shape.radius : shape.radius * Math.sqrt(uPos2);
      const aRad = a * RAD;
      return { px: r * Math.cos(aRad), py: r * Math.sin(aRad), dirDeg: a };
    }

    case "rect": {
      if (shape.emitFrom === "surface") {
        const w = shape.width;
        const h = shape.height;
        const perim = 2 * (w + h);
        let d = uPos1 * perim; // walk the perimeter, weighted by side length
        let px: number;
        let py: number;
        if (d < w) {
          px = d - w / 2;
          py = -h / 2;
        } else if ((d -= w) < h) {
          px = w / 2;
          py = d - h / 2;
        } else if ((d -= h) < w) {
          px = w / 2 - d;
          py = h / 2;
        } else {
          d -= w;
          px = -w / 2;
          py = h / 2 - d;
        }
        return { px, py, dirDeg: -90 };
      }
      return { px: (uPos1 - 0.5) * shape.width, py: (uPos2 - 0.5) * shape.height, dirDeg: -90 };
    }

    case "edge":
      return { px: (uPos1 - 0.5) * shape.length, py: 0, dirDeg: -90 };

    case "polyline":
      // schemaVersion 10 (B1): arc-length polyline sampling lands in M1 (via a
      // dedicated PolylineSampler built once in the LayerSim constructor, keyed
      // off uPos1). Here it keeps the switch exhaustive AND is the E37
      // degenerate/zero-length fallback: spawn at the origin with a random
      // direction (point-shape behavior). No existing document carries this kind,
      // so this branch is unreachable across the current determinism/golden suites.
      return { px: 0, py: 0, dirDeg: uDir * 360 };

    case "texture":
      // schemaVersion 4: emit-from-texture mask sampling lands in M1 (via a
      // dedicated MaskSampler). Here it keeps the switch exhaustive AND is the
      // E23 corrupt/empty-mask fallback: spawn at the origin with a random
      // direction (point-shape behavior). No existing document has this kind, so
      // this branch is unreachable across the current determinism/golden suites.
      return { px: 0, py: 0, dirDeg: uDir * 360 };
  }
}
