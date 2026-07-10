import { describe, it, expect } from "vitest";
import {
  LayerSim,
  Effect,
  deriveLayerSeed,
  makeRenderBuffers,
  computeRenderState,
  makeTrailGeometry,
  computeConnectGeometry,
  type Layer,
  type TrailConfig,
} from "../../src/index.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";
import { stateHash, dtSequence } from "./_statehash.js";

const seed = deriveLayerSeed(1337, 0);

const constWidth = (v: number): TrailConfig["width"] => ({ mode: "constant", value: v });
const connectTrail = (over: Partial<TrailConfig> = {}): TrailConfig => ({
  mode: "connect",
  maxPoints: 8, // documented-ignored in connect mode (R1)
  minVertexDistance: 2, // documented-ignored in connect mode (R1)
  width: constWidth(4),
  color: null,
  ...over,
});
const connectLayer = (trail: TrailConfig, over: Partial<Layer> = {}): Layer => makeLayer({ trail, ...over });

/** A connect-mode LayerSim plus a render buffer and a connect-sized geometry
 * buffer (ONE ribbon of up to `capacity` points). */
function connectSim(trail: TrailConfig = connectTrail()) {
  const ls = new LayerSim(connectLayer(trail), seed);
  const cap = ls.pool.capacity;
  const buf = makeRenderBuffers(cap);
  const out = makeTrailGeometry(1, cap);
  return { ls, buf, out, cap };
}

/** Spawn `n` particles and stamp each pool slot's position to a caller value so a
 * geometry assertion can identify which particle a vertex came from. Returns after
 * the spawns (ordinals 0..n−1 assigned to slots 0..n−1). */
function spawnAt(ls: LayerSim, xs: number[]): void {
  for (let i = 0; i < xs.length; i++) {
    ls.spawn();
    ls.pool.x[i] = xs[i]!;
    ls.pool.y[i] = 0; // horizontal ribbon: normal is (0,±1), so x survives extrusion
  }
}

// --- zero new state for existing docs (no-op law) --------------------------

describe("connect ribbon — pool state gating (v9 M1)", () => {
  it("a perParticle trail layer allocates NO ordinal column (no new state vs pre-M1)", () => {
    const ls = new LayerSim(makeLayer({ trail: connectTrail({ mode: "perParticle" }) }), seed);
    expect(ls.pool.ordinal).toBeNull(); // ordinal is connect/sub-emitter only
    expect(ls.pool.trail).not.toBeNull(); // per-particle keeps its ring store
  });

  it("a trail-null, sub-emitter-null layer allocates neither ordinal nor trail", () => {
    const ls = new LayerSim(makeLayer({ trail: null }), seed);
    expect(ls.pool.ordinal).toBeNull();
    expect(ls.pool.trail).toBeNull();
  });

  it("a connect layer allocates the ordinal column but NO trail ring store (R2)", () => {
    const { ls } = connectSim();
    expect(ls.pool.ordinal).not.toBeNull();
    expect(ls.pool.trail).toBeNull(); // no position history in connect mode
  });

  it("connect ordinals come from the spawn counter — zero extra PRNG draws vs trail-null", () => {
    // Two layers identical but for the connect trail; their spawn PRNG streams
    // (hence every drawn column) must be byte-identical — the ordinal draws nothing.
    const a = new LayerSim(makeLayer({ trail: null }), seed);
    const b = new LayerSim(connectLayer(connectTrail()), seed);
    for (let i = 0; i < 20; i++) {
      a.spawn();
      b.spawn();
    }
    expect(Array.from(a.pool.x.slice(0, a.count))).toEqual(Array.from(b.pool.x.slice(0, b.count)));
    expect(Array.from(a.pool.velY.slice(0, a.count))).toEqual(Array.from(b.pool.velY.slice(0, b.count)));
    // The ordinal column is a monotone 0..n−1 from the counter, no PRNG involved.
    expect(Array.from(b.pool.ordinal!.slice(0, b.count))).toEqual([...Array(b.count).keys()]);
  });
});

// --- ordering by stable ordinal (R3) ---------------------------------------

describe("connect ribbon — ordering by stable spawn ordinal (v9 M1, R3)", () => {
  it("threads A→C in spawn order after a mid-ribbon swap-remove kill of B", () => {
    const { ls, buf, out } = connectSim();
    spawnAt(ls, [10, 20, 30]); // A=ord0@x10, B=ord1@x20, C=ord2@x30
    // Kill B (pool.kill(1)) — swap-remove moves the LAST particle (C) into slot 1,
    // so pool index order becomes [A, C] while ordinals stay [0, 2].
    ls.pool.kill(1);
    expect(ls.count).toBe(2);
    expect(Array.from(ls.pool.ordinal!.slice(0, 2))).toEqual([0, 2]); // C's ordinal survived the move
    computeConnectGeometry(ls, buf, out);
    // 2 points ⇒ 4 verts, 1 segment (6 indices). Head (t=0) = newest = C(x30);
    // tail = oldest = A(x10). B is gone. x survives the (0,±1) normal extrusion.
    expect(out.vertexCount).toBe(4);
    expect(out.indexCount).toBe(6);
    expect(out.positions[0]).toBe(30); // head vertex A x  (C)
    expect(out.positions[2]).toBe(30); // head vertex B x  (C)
    expect(out.positions[4]).toBe(10); // tail vertex A x  (A)
    expect(out.positions[6]).toBe(10); // tail vertex B x  (A)
  });

  it("same-age burst: the ordinal, not age, sets the order (all ages equal)", () => {
    const { ls, buf, out } = connectSim();
    spawnAt(ls, [0, 1, 2, 3, 4]); // ordinals 0..4, every particle age 0
    for (let i = 0; i < ls.count; i++) expect(ls.pool.age[i]).toBe(0);
    computeConnectGeometry(ls, buf, out);
    // Newest→oldest by ordinal = x 4,3,2,1,0; each point's first (head-side) vertex
    // x is at stride 4 floats. Deterministic despite the age tie.
    const headXs = [0, 1, 2, 3, 4].map((k) => out.positions[k * 4]);
    expect(headXs).toEqual([4, 3, 2, 1, 0]);
  });
});

// --- degenerate cases + sampling (R4) --------------------------------------

describe("connect ribbon — degenerate cases and width/color sampling (v9 M1, R4)", () => {
  it("fewer than 2 live particles ⇒ empty geometry (no degenerate quad)", () => {
    const { ls, buf, out } = connectSim();
    computeConnectGeometry(ls, buf, out); // 0 live
    expect(out.vertexCount).toBe(0);
    expect(out.indexCount).toBe(0);
    spawnAt(ls, [5]); // 1 live
    computeConnectGeometry(ls, buf, out);
    expect(out.vertexCount).toBe(0);
    expect(out.indexCount).toBe(0);
  });

  it("exactly 2 live particles ⇒ one segment (4 verts, 6 indices)", () => {
    const { ls, buf, out } = connectSim();
    spawnAt(ls, [0, 100]);
    computeConnectGeometry(ls, buf, out);
    expect(out.vertexCount).toBe(4);
    expect(out.indexCount).toBe(6);
  });

  it("width is sampled over ribbon t with t=0 at the NEWEST particle (head)", () => {
    const { ls, buf, out } = connectSim(connectTrail({ width: { mode: "curve", keys: [{ t: 0, v: 8 }, { t: 1, v: 0 }] } }));
    spawnAt(ls, [0, 100]); // ord0@x0 (oldest/tail), ord1@x100 (newest/head)
    computeConnectGeometry(ls, buf, out);
    // Head (newest, t=0): width 8 ⇒ y = ±4. Tail (oldest, t=1): width 0 ⇒ y = 0.
    expect(Math.abs(out.positions[1]!)).toBeCloseTo(4, 6); // head vertex A, y
    expect(Math.abs(out.positions[3]!)).toBeCloseTo(4, 6); // head vertex B, y
    expect(out.positions[5]).toBeCloseTo(0, 6); // tail vertex A, y
    expect(out.positions[7]).toBeCloseTo(0, 6); // tail vertex B, y
  });

  it("null color: each vertex takes its OWN particle's current render RGBA", () => {
    const { ls, buf, out } = connectSim(); // color: null
    spawnAt(ls, [0, 100]); // slot0 = ord0 (oldest), slot1 = ord1 (newest)
    buf.r[0] = 0.1; buf.g[0] = 0.2; buf.b[0] = 0.3; buf.a[0] = 0.4; // oldest particle
    buf.r[1] = 0.6; buf.g[1] = 0.7; buf.b[1] = 0.8; buf.a[1] = 0.9; // newest particle
    computeConnectGeometry(ls, buf, out);
    // Head (point 0 = newest = slot1): its two vertices carry slot1's RGBA.
    expect([out.colors[0], out.colors[1], out.colors[2], out.colors[3]]).toEqual([
      buf.r[1], buf.g[1], buf.b[1], buf.a[1],
    ]);
    // Tail (point 1 = oldest = slot0): vertex 2 (colors offset 8) carries slot0's RGBA.
    expect([out.colors[8], out.colors[9], out.colors[10], out.colors[11]]).toEqual([
      buf.r[0], buf.g[0], buf.b[0], buf.a[0],
    ]);
  });

  it("non-null color: gradient rgb over t, alpha × the per-vertex particle alpha", () => {
    const { ls, buf, out } = connectSim(
      connectTrail({ color: { keys: [{ t: 0, r: 1, g: 0, b: 0, a: 1 }, { t: 1, r: 0, g: 0, b: 1, a: 0 }] } }),
    );
    spawnAt(ls, [0, 100]);
    buf.a[0] = 0.5; // oldest (tail, t=1) alpha
    buf.a[1] = 0.5; // newest (head, t=0) alpha
    computeConnectGeometry(ls, buf, out);
    // Head (t=0): red, alpha 1 × 0.5 = 0.5.
    expect([out.colors[0], out.colors[1], out.colors[2], out.colors[3]]).toEqual([1, 0, 0, 0.5]);
    // Tail (t=1): blue, alpha 0 × 0.5 = 0.
    expect([out.colors[8], out.colors[10], out.colors[11]]).toEqual([0, 1, 0]);
  });
});

// --- determinism ------------------------------------------------------------

describe("connect ribbon — determinism (v9 M1)", () => {
  const connectDoc = () =>
    makeDoc({
      layers: [
        connectLayer(connectTrail({ color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }, { t: 1, r: 1, g: 0, b: 0, a: 0 }] } })),
      ],
    });

  it("two runs, same seed ⇒ identical geometry buffers and stateHash across 300 kill-heavy steps", () => {
    const doc = connectDoc();
    const a = new Effect(doc, { seed: 1337 });
    const b = new Effect(doc, { seed: 1337 });
    const dts = dtSequence(11, 300);
    for (let i = 0; i < 300; i++) {
      a.step(dts[i]!);
      b.step(dts[i]!);
    }
    // stateHash folds the ordinal column (present for connect layers); identical
    // runs — including all the swap-remove kills over 300 steps — must agree.
    expect(stateHash(a)).toBe(stateHash(b));

    const cap = a.layers[0]!.pool.capacity;
    const geoA = makeTrailGeometry(1, cap);
    const geoB = makeTrailGeometry(1, cap);
    const bufA = makeRenderBuffers(cap);
    const bufB = makeRenderBuffers(cap);
    computeRenderState(a.layers[0]!, bufA);
    computeRenderState(b.layers[0]!, bufB);
    computeConnectGeometry(a.layers[0]!, bufA, geoA);
    computeConnectGeometry(b.layers[0]!, bufB, geoB);
    expect(geoA.vertexCount).toBe(geoB.vertexCount);
    expect(geoA.indexCount).toBe(geoB.indexCount);
    expect(geoA.vertexCount).toBeGreaterThan(0); // the ribbon is actually populated
    expect(Array.from(geoA.positions.slice(0, geoA.vertexCount * 2))).toEqual(
      Array.from(geoB.positions.slice(0, geoB.vertexCount * 2)),
    );
    expect(Array.from(geoA.colors.slice(0, geoA.vertexCount * 4))).toEqual(
      Array.from(geoB.colors.slice(0, geoB.vertexCount * 4)),
    );
  });
});
