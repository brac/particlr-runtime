import { describe, it, expect } from "vitest";
import {
  LayerSim,
  ParticlePool,
  TrailStore,
  Effect,
  deriveLayerSeed,
  makeRenderBuffers,
  makeTrailGeometry,
  computeTrailGeometry,
  type Layer,
  type TrailConfig,
} from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);

// --- TrailStore ring buffer ------------------------------------------------

describe("TrailStore ring buffer (M9)", () => {
  it("spawn records the first head point (len 1)", () => {
    const t = new TrailStore(2, 4);
    t.spawn(0, 5, 7);
    expect(t.head[0]).toBe(0);
    expect(t.len[0]).toBe(1);
    expect([t.pts[0], t.pts[1]]).toEqual([5, 7]);
  });

  it("pushes append until maxPoints, then overwrite the oldest (wrap)", () => {
    const mp = 4;
    const t = new TrailStore(1, mp);
    t.spawn(0, 0, 0);
    t.push(0, 10, 0, 1); // dist² 100 ≥ 1 → head 1, len 2
    t.push(0, 20, 0, 1); // head 2, len 3
    t.push(0, 30, 0, 1); // head 3, len 4 (full)
    expect(t.head[0]).toBe(3);
    expect(t.len[0]).toBe(4);
    t.push(0, 40, 0, 1); // wrap: head 0, len stays 4, slot 0 overwritten
    expect(t.head[0]).toBe(0);
    expect(t.len[0]).toBe(4);
    // Slot 0 now holds the newest (40,0), not the original spawn (0,0).
    expect([t.pts[0], t.pts[1]]).toEqual([40, 0]);
    // Newest→oldest ordering (head, head-1, …): 40, 30, 20, 10.
    const ordered: number[] = [];
    for (let j = 0; j < t.len[0]!; j++) {
      let s = t.head[0]! - j;
      if (s < 0) s += mp;
      ordered.push(t.pts[s * 2]!);
    }
    expect(ordered).toEqual([40, 30, 20, 10]);
  });

  it("minVertexDistance gates pushes: below the threshold nothing records; ≥ pushes (dist² ≥ minDist²)", () => {
    const t = new TrailStore(1, 8);
    t.spawn(0, 0, 0);
    const minDistSq = 9; // minVertexDistance 3
    t.push(0, 2, 0, minDistSq); // dist² 4 < 9 → no push
    expect(t.len[0]).toBe(1);
    t.push(0, 3, 0, minDistSq); // dist² 9 ≥ 9 → push (boundary is inclusive)
    expect(t.len[0]).toBe(2);
    expect(t.head[0]).toBe(1);
    // The next gate measures from the NEW head (3,0), not the spawn point.
    t.push(0, 5, 0, minDistSq); // dist² 4 < 9 → no push
    expect(t.len[0]).toBe(2);
  });
});

// --- swap-remove moves the whole strided block -----------------------------

describe("pool swap-remove moves the trail stride block (M9)", () => {
  it("kill copies the LAST particle's entire ring block into the freed slot", () => {
    const mp = 3;
    const pool = new ParticlePool(4, { trailMaxPoints: mp });
    const store = pool.trail!;
    expect(store).not.toBeNull();
    // Three live particles; give each a distinguishable base column + ring block.
    for (let i = 0; i < 3; i++) {
      pool.spawn();
      pool.x[i] = 100 + i;
      store.head[i] = i % mp;
      store.len[i] = i + 1;
      const b = i * mp * 2;
      for (let k = 0; k < mp * 2; k++) store.pts[b + k] = i * 10 + k;
    }
    // Snapshot the last particle's (index 2) block before the kill.
    const lastHead = store.head[2]!;
    const lastLen = store.len[2]!;
    const lastBlock = Array.from(store.pts.slice(2 * mp * 2, 3 * mp * 2));

    pool.kill(1); // swap-remove: particle 2 (last) moves into slot 1

    expect(pool.count).toBe(2);
    expect(pool.x[1]).toBe(102); // base column moved
    expect(store.head[1]).toBe(lastHead); // head column moved
    expect(store.len[1]).toBe(lastLen); // len column moved
    expect(Array.from(store.pts.slice(1 * mp * 2, 2 * mp * 2))).toEqual(lastBlock); // full ring block moved
  });

  it("a trail-null pool registers no strided columns (kill stays byte-identical)", () => {
    const pool = new ParticlePool(4, {});
    expect(pool.trail).toBeNull();
    pool.spawn();
    pool.spawn();
    pool.x[0] = 1;
    pool.x[1] = 2;
    pool.kill(0);
    expect(pool.x[0]).toBe(2); // last swapped in, no strided work
  });
});

// --- geometry --------------------------------------------------------------

const trailLayer = (trail: TrailConfig): Layer => makeLayer({ trail });
const constWidth = (v: number): TrailConfig["width"] => ({ mode: "constant", value: v });

/** A LayerSim with one live particle whose trail ring we set directly, plus a
 * render buffer we can fill. Returns everything a geometry assertion needs. */
function oneTrail(trail: TrailConfig) {
  const ls = new LayerSim(trailLayer(trail), seed);
  ls.spawn(); // count → 1
  const buf = makeRenderBuffers(ls.pool.capacity);
  const out = makeTrailGeometry(ls.pool.capacity, trail.maxPoints);
  return { ls, buf, out, store: ls.pool.trail! };
}

describe("computeTrailGeometry counts + degenerate cases (M9)", () => {
  it("emits 2 verts/point and 6 indices/segment for N active points", () => {
    const { ls, buf, out, store } = oneTrail({ maxPoints: 8, minVertexDistance: 2, width: constWidth(4), color: null });
    store.spawn(0, 0, 0);
    store.push(0, 10, 0, 1);
    store.push(0, 20, 0, 1); // 3 active points
    computeTrailGeometry(ls, buf, out);
    expect(out.vertexCount).toBe(6); // 2 × 3
    expect(out.indexCount).toBe(12); // 6 × (3 − 1)
  });

  it("a 1-point trail emits zero geometry (needs ≥ 2 points)", () => {
    const { ls, buf, out, store } = oneTrail({ maxPoints: 8, minVertexDistance: 2, width: constWidth(4), color: null });
    store.spawn(0, 3, 4); // only the head point
    computeTrailGeometry(ls, buf, out);
    expect(out.vertexCount).toBe(0);
    expect(out.indexCount).toBe(0);
  });

  it("width track is evaluated at tTrail (head width ≠ tail width)", () => {
    // width 8 at head (t 0) → 0 at tail (t 1); half-width extrudes ±width/2.
    const { ls, buf, out, store } = oneTrail({
      maxPoints: 8,
      minVertexDistance: 2,
      width: { mode: "curve", keys: [{ t: 0, v: 8 }, { t: 1, v: 0 }] },
      color: null,
    });
    // Horizontal trail so the normal is (0, ±1) and the extrusion is on y only.
    store.spawn(0, 0, 0);
    store.push(0, 10, 0, 1);
    store.push(0, 20, 0, 1); // newest→oldest: (20,0)=head, (10,0), (0,0)=tail
    computeTrailGeometry(ls, buf, out);
    // Head point (first two vertices): y = ±4 (half of width 8).
    expect(Math.abs(out.positions[1]!)).toBeCloseTo(4, 6);
    expect(Math.abs(out.positions[3]!)).toBeCloseTo(4, 6);
    // Tail point (last two vertices): width 0 → both vertices at y 0.
    const last = out.vertexCount - 1;
    expect(out.positions[last * 2 + 1]).toBeCloseTo(0, 6);
    expect(out.positions[(last - 1) * 2 + 1]).toBeCloseTo(0, 6);
  });

  it("UV u is monotone along the trail (0 at head → 1 at tail), v is 0/1 across", () => {
    const { ls, buf, out, store } = oneTrail({ maxPoints: 8, minVertexDistance: 2, width: constWidth(4), color: null });
    store.spawn(0, 0, 0);
    store.push(0, 10, 0, 1);
    store.push(0, 20, 0, 1);
    computeTrailGeometry(ls, buf, out);
    // Per point the two vertices share u and carry v = 0 then 1.
    expect(out.uvs[0]).toBeCloseTo(0, 6); // head, vertex A, u
    expect(out.uvs[1]).toBeCloseTo(0, 6); // v = 0
    expect(out.uvs[3]).toBeCloseTo(1, 6); // v = 1
    const us = [out.uvs[0]!, out.uvs[4]!, out.uvs[8]!]; // u of point 0,1,2 (stride 4 floats/point)
    expect(us[0]).toBeLessThan(us[1]!);
    expect(us[1]).toBeLessThan(us[2]!);
    expect(us[2]).toBeCloseTo(1, 6);
  });

  it("color rule: null trail.color uses the particle's current render RGBA", () => {
    const { ls, buf, out, store } = oneTrail({ maxPoints: 8, minVertexDistance: 2, width: constWidth(4), color: null });
    store.spawn(0, 0, 0);
    store.push(0, 10, 0, 1);
    buf.r[0] = 0.25;
    buf.g[0] = 0.5;
    buf.b[0] = 0.75;
    buf.a[0] = 0.6;
    computeTrailGeometry(ls, buf, out);
    // buf is Float32-backed, so compare against the same-precision values it holds.
    expect(out.colors[0]).toBe(buf.r[0]);
    expect(out.colors[1]).toBe(buf.g[0]);
    expect(out.colors[2]).toBe(buf.b[0]);
    expect(out.colors[3]).toBe(buf.a[0]);
  });

  it("color rule: non-null trail.color uses the gradient rgb/a × particle alpha", () => {
    const { ls, buf, out, store } = oneTrail({
      maxPoints: 8,
      minVertexDistance: 2,
      width: constWidth(4),
      color: { keys: [{ t: 0, r: 1, g: 0, b: 0, a: 1 }, { t: 1, r: 0, g: 0, b: 1, a: 0 }] },
    });
    store.spawn(0, 0, 0);
    store.push(0, 10, 0, 1); // 2 points: head (t 0) and tail (t 1)
    buf.a[0] = 0.5; // particle alpha scales the trail alpha
    computeTrailGeometry(ls, buf, out);
    // Head vertex (t 0): red, alpha 1 × 0.5 = 0.5.
    expect([out.colors[0], out.colors[1], out.colors[2], out.colors[3]]).toEqual([1, 0, 0, 0.5]);
    // Tail vertex (last point, t 1): blue, alpha 0 × 0.5 = 0.
    const last = out.vertexCount - 1;
    expect([out.colors[last * 4], out.colors[last * 4 + 2], out.colors[last * 4 + 3]]).toEqual([0, 1, 0]);
  });
});

// --- zero-cost + determinism ------------------------------------------------

describe("trail zero-cost + determinism (M9)", () => {
  it("a trail-null layer allocates no ring buffer and draws no extra PRNG", () => {
    const ls = new LayerSim(makeLayer({ trail: null }), seed);
    expect(ls.pool.trail).toBeNull();
  });

  it("adding a trail draws NO extra PRNG (twin spawn-stream equality)", () => {
    // Two layers identical but for the trail module; their spawn PRNG streams
    // (hence every non-trail column) must be byte-identical — trails draw nothing.
    const base = makeLayer({ trail: null });
    const withTrail = makeLayer({ trail: { maxPoints: 8, minVertexDistance: 3, width: constWidth(4), color: null } });
    const a = new LayerSim(base, seed);
    const b = new LayerSim(withTrail, seed);
    for (let i = 0; i < 30; i++) {
      a.spawn();
      b.spawn();
    }
    expect(Array.from(a.pool.x.slice(0, a.count))).toEqual(Array.from(b.pool.x.slice(0, b.count)));
    expect(Array.from(a.pool.velY.slice(0, a.count))).toEqual(Array.from(b.pool.velY.slice(0, b.count)));
  });

  it("two runs with trails on are bit-identical over 300 mixed-dt steps (stateHash + pts blocks)", () => {
    const layer = makeLayer({
      trail: { maxPoints: 12, minVertexDistance: 3, width: constWidth(5), color: null },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] },
        rotation: null,
        velocity: { gravity: { x: 20, y: 60 }, drag: { mode: "constant", value: 0.5 }, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
      },
    });
    const doc = makeDoc({ layers: [layer] });
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(7, 300);
    for (let i = 0; i < 300; i++) {
      a.step(dts[i]!);
      b.step(dts[i]!);
    }
    expect(stateHash(a)).toBe(stateHash(b));
    const ta = a.layers[0]!.pool.trail!;
    const tb = b.layers[0]!.pool.trail!;
    const n = a.layers[0]!.count;
    expect(Array.from(ta.pts.slice(0, n * 12 * 2))).toEqual(Array.from(tb.pts.slice(0, n * 12 * 2)));
    expect(Array.from(ta.head.slice(0, n))).toEqual(Array.from(tb.head.slice(0, n)));
  });
});
