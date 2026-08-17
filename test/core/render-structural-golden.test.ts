// Structural sim-parity golden (V2_DESIGN Part 1 §Parity layer 1): hash the
// renderer-agnostic state every adapter consumes — pool x/y/rotation plus the
// full LayerRenderBuffers — at frames 15/30/60 of every preset at seed 1337,
// dt 1/60. Bitwise: any change to these hashes means the sim state adapters
// receive has changed, which is either an intentional format/sim change
// (regenerate with sign-off, like raster goldens) or a bug.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { computeRenderState, makeRenderBuffers, type LayerRenderBuffers } from "../../src/core/render.js";
import { presetsDir, hasPresets } from "../_presets.js";

const FRAMES = [15, 30, 60];
const SEED = 1337;
const DT = 1 / 60;

/** FNV-1a over the bytes of a typed array — cheap, stable, endian-fixed by
 * always hashing via a DataView in little-endian order. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function hashF32(a: Float32Array, count: number): string {
  const out = new Uint8Array(count * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < count; i++) dv.setFloat32(i * 4, a[i]!, true);
  return fnv1a(out);
}

function layerHash(count: number, x: Float32Array, y: Float32Array, rot: Float32Array, b: LayerRenderBuffers): string {
  const frame = new Uint8Array(b.frame.buffer, b.frame.byteOffset, count * 2);
  return [
    count.toString(16),
    hashF32(x, count), hashF32(y, count), hashF32(rot, count),
    hashF32(b.size, count), hashF32(b.r, count), hashF32(b.g, count), hashF32(b.b, count), hashF32(b.a, count),
    fnv1a(frame), hashF32(b.stretch, count), hashF32(b.velAngle, count),
    fnv1a(b.flip.subarray(0, count)),
  ].join(".");
}

const presets = hasPresets
  ? readdirSync(presetsDir).filter((f) => f.endsWith(".prt")).map((f) => f.replace(/\.prt$/, "")).sort()
  : [];

describe.skipIf(!hasPresets)("structural sim goldens", () => {
  for (const name of presets) {
    it(`${name} frames ${FRAMES.join("/")}`, () => {
      const parsed = parseParticle(readFileSync(resolve(presetsDir, `${name}.prt`), "utf8"));
      if (!parsed.ok) throw new Error(`preset ${name} invalid`);
      const fx = new Effect(parsed.doc!, { seed: SEED });
      const buffers = fx.layers.map((ls) => makeRenderBuffers(ls.layer.emission.maxParticles));
      const result: Record<string, string[]> = {};
      let frame = 0;
      for (const target of FRAMES) {
        for (; frame < target; frame++) fx.step(DT);
        result[`f${target}`] = fx.layers.map((ls, i) => {
          const b = buffers[i]!;
          computeRenderState(ls, b);
          return layerHash(ls.count, ls.pool.x, ls.pool.y, ls.pool.rotation, b);
        });
      }
      expect(result).toMatchSnapshot();
    });
  }
});
