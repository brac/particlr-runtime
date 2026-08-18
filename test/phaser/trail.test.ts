// @vitest-environment jsdom
// Trail ribbons: `submitTrailStrips` against a capturing double (ribbon
// splitting, Phaser's colour packing, scratch reuse), plus the renderer-level
// wiring (trail GO added BEFORE its particle layer GO, geometry driven in
// `sync()`, strips submitted through the scene's BatchHandlerStrip).
//
// `src/phaser/trailStrip.ts` imports no phaser, so it is imported statically;
// `src/phaser/renderer.ts` does, so it goes through the `_phaserEnv` stub +
// dynamic-import dance (see `_phaserEnv.ts`).
import { describe, it, expect, beforeAll } from "vitest";
import { makeFakeScene, makeEffectDoc } from "./_fakes.js";
import { installPhaserCanvasStub } from "./_phaserEnv.js";
import { parseParticle, Effect } from "../../src/index.js";
import type { ParticleDoc, TrailConfig } from "../../src/index.js";
import { makeTrailGeometry, type TrailGeometry } from "../../src/core/trailGeometry.js";
import { submitTrailStrips, makeTrailScratch, type StripBatchLike } from "../../src/phaser/trailStrip.js";

beforeAll(() => {
  installPhaserCanvasStub();
});

interface Recorded {
  verts: number;
  firstColor: number;
  firstAlpha: number;
  firstX: number;
  firstY: number;
  firstU: number;
  /** Identity of the backing store, to prove the scratch is not reallocated. */
  buffer: ArrayBufferLike;
}

function capture(): StripBatchLike & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    // Values are read EAGERLY: the scratch arrays are overwritten by the next
    // ribbon, so holding the array reference would capture the last ribbon.
    batchStrip(_ctx, _src, _m, _tex, vertices, uv, colors, alphas) {
      calls.push({
        verts: vertices.length / 2,
        firstColor: colors[0]!,
        firstAlpha: alphas[0]!,
        firstX: vertices[0]!,
        firstY: vertices[1]!,
        firstU: uv[0]!,
        buffer: vertices.buffer,
      });
    },
  };
}

/**
 * Two per-particle ribbons of 2 points each, in the exact layout
 * `core/trailGeometry.emitStrip` writes: 2 vertices per point (+normal then
 * −normal), ribbons packed back to back, and 6 indices per segment starting at
 * `vbase + j*2`. Ribbon A is opaque white, ribbon B is red at alpha 0.5.
 */
function twoRibbonFixture(): TrailGeometry {
  const g = makeTrailGeometry(2, 2); // 2 ribbons × 2 points → 8 verts, 2 segs
  const rgba = [
    [1, 1, 1, 1],
    [1, 0, 0, 0.5],
  ];
  for (let ribbon = 0; ribbon < 2; ribbon++) {
    for (let v = 0; v < 4; v++) {
      const i = ribbon * 4 + v;
      g.positions[i * 2] = ribbon * 100 + v;
      g.positions[i * 2 + 1] = ribbon * 10 + v;
      g.uvs[i * 2] = v < 2 ? 0 : 1; // point index 0 → t=0, point 1 → t=1
      g.uvs[i * 2 + 1] = v % 2; // +normal side v=0, −normal side v=1
      const c = rgba[ribbon]!;
      g.colors[i * 4] = c[0]!;
      g.colors[i * 4 + 1] = c[1]!;
      g.colors[i * 4 + 2] = c[2]!;
      g.colors[i * 4 + 3] = c[3]!;
    }
    const a = ribbon * 4;
    const ic = ribbon * 6;
    g.indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], ic);
  }
  g.vertexCount = 8;
  g.indexCount = 12;
  return g;
}

/** ONE connect-mode ribbon of 3 points (6 verts, 2 segments). */
function oneRibbonFixture(): TrailGeometry {
  const g = makeTrailGeometry(1, 3);
  for (let i = 0; i < 6; i++) {
    g.positions[i * 2] = i;
    g.positions[i * 2 + 1] = -i;
    g.colors[i * 4] = 1;
    g.colors[i * 4 + 1] = 1;
    g.colors[i * 4 + 2] = 1;
    g.colors[i * 4 + 3] = 1;
  }
  g.indices.set([0, 1, 2, 2, 1, 3], 0);
  g.indices.set([2, 3, 4, 4, 3, 5], 6);
  g.vertexCount = 6;
  g.indexCount = 12;
  return g;
}

describe("submitTrailStrips", () => {
  it("splits ribbons into one batchStrip call each and packs colours Phaser-style", () => {
    const geom = twoRibbonFixture();
    const h = capture();
    const scratch = makeTrailScratch(64);
    submitTrailStrips(h, null, null, null, null, geom, scratch, {});

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.verts).toBe(4);
    expect(h.calls[1]!.verts).toBe(4);
    // Phaser's BatchHandlerStrip packs with `getTintAppendFloatAlpha(colors[i],
    // alphas[i] * alpha)`, so `colors` is a Uint24 0xRRGGBB and the alpha rides
    // the separate float array — NOT a packed ABGR word.
    expect(h.calls[0]!.firstColor).toBe(0xffffff);
    expect(h.calls[0]!.firstAlpha).toBe(1);
    expect(h.calls[1]!.firstColor).toBe(0xff0000);
    expect(h.calls[1]!.firstAlpha).toBeCloseTo(0.5);
    // Each call carries its OWN ribbon's vertices/uvs, not the whole buffer.
    expect([h.calls[0]!.firstX, h.calls[0]!.firstY]).toEqual([0, 0]);
    expect([h.calls[1]!.firstX, h.calls[1]!.firstY]).toEqual([100, 10]);
    expect(h.calls[1]!.firstU).toBe(0);
  });

  it("emits ONE call for a connect-mode ribbon and none for empty geometry", () => {
    const h = capture();
    const scratch = makeTrailScratch(64);
    submitTrailStrips(h, null, null, null, null, oneRibbonFixture(), scratch, {});
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.verts).toBe(6);

    const empty = makeTrailGeometry(2, 4); // vertexCount/indexCount still 0
    submitTrailStrips(h, null, null, null, null, empty, scratch, {});
    expect(h.calls).toHaveLength(1);
  });

  it("reuses the scratch buffers across ribbons and across frames", () => {
    const geom = twoRibbonFixture();
    const h = capture();
    const scratch = makeTrailScratch(64);
    submitTrailStrips(h, null, null, null, null, geom, scratch, {});
    submitTrailStrips(h, null, null, null, null, geom, scratch, {});
    expect(h.calls).toHaveLength(4);
    const first = h.calls[0]!.buffer;
    for (const call of h.calls) expect(call.buffer).toBe(first);
  });
});

// --- renderer wiring -------------------------------------------------------

const TRAIL: TrailConfig = {
  mode: "perParticle",
  maxPoints: 8,
  minVertexDistance: 0.5,
  width: { mode: "constant", value: 4 },
  color: null,
};

function trailDoc(mode: "perParticle" | "connect"): ParticleDoc {
  const doc = makeEffectDoc(1);
  doc.layers[0]!.trail = { ...TRAIL, mode };
  return doc;
}

function effectFrom(doc: ParticleDoc): Effect {
  const parsed = parseParticle(JSON.stringify(doc));
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
  return new Effect(parsed.doc!, { seed: 1337 });
}

async function loadRenderer() {
  return (await import("../../src/phaser/renderer.js")).PhaserParticleRenderer;
}

describe("PhaserParticleRenderer trails", () => {
  it("adds the trail GO BEFORE its particle layer GO so ribbons paint under", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const view = new PhaserParticleRenderer(effectFrom(trailDoc("perParticle")), {
      scene: scene as never,
      autoStep: false,
    });

    const children = view.gameObject.list as Array<{ type: string }>;
    expect(children).toHaveLength(2);
    expect(children[0]!.type).toBe("ParticlrTrailLayer");
    expect(children[1]!.type).toBe("ParticlrLayer");
    view.destroy();
  });

  it("has no trail child when the layer has no trail module", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const view = new PhaserParticleRenderer(effectFrom(makeEffectDoc(1)), { scene: scene as never, autoStep: false });
    expect(view.gameObject.list).toHaveLength(1);
    view.destroy();
  });

  it("builds ribbon geometry in sync() and submits it through BatchHandlerStrip", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const Phaser = (await import("phaser")).default;
    const scene = await makeFakeScene();
    const fx = effectFrom(trailDoc("perParticle"));
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });
    for (let i = 0; i < 20; i++) {
      fx.step(1 / 60);
      view.sync();
    }

    const trailGo = (view.gameObject.list as Array<{ renderWebGLStep: (...a: never[]) => void; view: unknown }>)[0]!;
    const geom = (trailGo.view as { trail: { geom: TrailGeometry } }).trail.geom;
    expect(geom.indexCount).toBeGreaterThan(0);

    const drawingContext = {
      camera: {
        addToRenderList: () => {},
        matrixExternal: new Phaser.GameObjects.Components.TransformMatrix(),
        matrix: new Phaser.GameObjects.Components.TransformMatrix(),
        matrixCombined: new Phaser.GameObjects.Components.TransformMatrix(),
        scrollX: 0,
        scrollY: 0,
        id: 1,
      },
    };
    trailGo.renderWebGLStep(null as never, trailGo as never, drawingContext as never, null as never);
    expect(scene.stripHandler.calls.length).toBeGreaterThan(0);

    // Disabling the layer must zero the geometry, not leave a stale ribbon.
    fx.layers[0]!.layer.enabled = false;
    view.sync();
    expect(geom.indexCount).toBe(0);
    scene.stripHandler.calls.length = 0;
    trailGo.renderWebGLStep(null as never, trailGo as never, drawingContext as never, null as never);
    expect(scene.stripHandler.calls).toHaveLength(0);
    view.destroy();
  });

  it("sizes connect-mode geometry as ONE ribbon over the whole capacity", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const doc = trailDoc("connect");
    const max = doc.layers[0]!.emission.maxParticles;
    const view = new PhaserParticleRenderer(effectFrom(doc), { scene: scene as never, autoStep: false });

    const trailGo = (view.gameObject.list as Array<{ view: { trail: { geom: TrailGeometry } } }>)[0]!;
    // makeTrailGeometry(1, max): capacity·2 verts, capacity−1 segments.
    expect(trailGo.view.trail.geom.positions.length).toBe(max * 2 * 2);
    expect(trailGo.view.trail.geom.indices.length).toBe((max - 1) * 6);
    view.destroy();
  });
});
