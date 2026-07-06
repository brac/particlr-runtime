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

export function sampleShape(shape: Shape, uPos1: number, uPos2: number, uDir: number): SpawnSample {
  switch (shape.kind) {
    case "point":
      return { px: 0, py: 0, dirDeg: uDir * 360 };

    case "circle": {
      const theta = uPos1 * TAU;
      const r = shape.emitFrom === "surface" ? shape.radius : shape.radius * Math.sqrt(uPos2);
      const px = r * Math.cos(theta);
      const py = r * Math.sin(theta);
      // radially outward; a particle exactly at the centre gets a random angle.
      const dirDeg = r === 0 ? uDir * 360 : theta * DEG;
      return { px, py, dirDeg };
    }

    case "cone": {
      // Angle sampled first, then radius, so position and direction stay
      // consistent for emitFrom:"volume" (§2.1).
      const a = shape.direction - shape.spread / 2 + uPos1 * shape.spread;
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
  }
}
