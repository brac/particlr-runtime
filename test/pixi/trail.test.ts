import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ParticleContainer, Mesh } from "pixi.js";
import { parseParticle, type ParticleDoc } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { PixiParticleRenderer } from "../../src/pixi/renderer.js";
import type { TrailView } from "../../src/pixi/trailMesh.js";
import { makeLayer, makeDoc } from "../format/_helpers.js";

function loadDoc(name: string) {
  const raw = readFileSync(resolve(__dirname, `../../../../presets/${name}.prt`), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${JSON.stringify(parsed.errors)}`);
  return structuredClone(parsed.doc!);
}

interface ViewProbe {
  pc: ParticleContainer;
  trail: TrailView | null;
}
const viewOf = (r: PixiParticleRenderer, i: number): ViewProbe =>
  (r as unknown as { views: ViewProbe[] }).views[i]!;

// The comet preset's layer 0 ("head") is world-space with a trail; layer 1
// ("core-glow") has none.
describe("PixiParticleRenderer — per-particle trails (M9)", () => {
  it("builds a trail view for a trail layer and none for a null-trail layer", () => {
    const r = new PixiParticleRenderer(new Effect(loadDoc("comet"), { seed: 1337 }));
    expect(viewOf(r, 0).trail).not.toBeNull();
    expect(viewOf(r, 1).trail).toBeNull();
    r.destroy();
  });

  it("adds the trail mesh BEHIND the layer's ParticleContainer (lower child index)", () => {
    const r = new PixiParticleRenderer(new Effect(loadDoc("comet"), { seed: 1337 }));
    const v = viewOf(r, 0);
    const mesh = v.trail!.mesh;
    expect(mesh).toBeInstanceOf(Mesh);
    const meshIdx = r.container.getChildIndex(mesh);
    const pcIdx = r.container.getChildIndex(v.pc);
    expect(meshIdx).toBeLessThan(pcIdx); // behind = drawn first
    r.destroy();
  });

  it("writes geometry buffers and a matching draw range after sync", () => {
    const fx = new Effect(loadDoc("comet"), { seed: 1337 });
    const r = new PixiParticleRenderer(fx);
    // Advance enough that head particles move ≥ minVertexDistance and record ≥ 2
    // trail points, so the ribbon has geometry.
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    r.sync();
    const v = viewOf(r, 0);
    const geom = v.trail!.geom;
    expect(geom.indexCount).toBeGreaterThan(0);
    expect(geom.vertexCount).toBeGreaterThan(0);
    // The index buffer's live view length equals the reported draw range.
    expect(v.trail!.geometry.indexBuffer.data.length).toBe(geom.indexCount);
    // At least one written position is non-zero (buffers uploaded, not blank).
    expect(geom.positions.some((x) => x !== 0)).toBe(true);
    r.destroy();
  });

  it("clears the ribbon to zero draws when the trail layer is disabled", () => {
    const doc = loadDoc("comet");
    doc.layers[0]!.enabled = false;
    const fx = new Effect(doc, { seed: 1337 });
    const r = new PixiParticleRenderer(fx);
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    r.sync();
    const geom = viewOf(r, 0).trail!.geom;
    expect(geom.indexCount).toBe(0);
    r.destroy();
  });

  it("rides the emitter: local trail mesh follows the emitter, world stays at origin", () => {
    const doc = loadDoc("comet"); // layer 0 world, layer 1 (no trail) local
    // Force layer 0 local so its trail mesh should ride the emitter.
    doc.layers[0]!.space = "local";
    const fx = new Effect(doc, { seed: 1337 });
    const r = new PixiParticleRenderer(fx);
    fx.setEmitterPosition(70, 30);
    fx.step(1 / 60);
    r.sync();
    const mesh = viewOf(r, 0).trail!.mesh;
    expect([mesh.position.x, mesh.position.y]).toEqual([70, 30]);
    r.destroy();
  });
});

// A connect-mode trail layer: ONE ribbon threaded through all live particles.
const connectDoc = (): ParticleDoc =>
  makeDoc({
    layers: [
      makeLayer({
        trail: { mode: "connect", maxPoints: 8, minVertexDistance: 2, width: { mode: "constant", value: 5 }, color: null },
      }),
    ],
  });

describe("PixiParticleRenderer — connect ribbon (v9 M1)", () => {
  it("builds one trail view whose ribbon is populated after stepping", () => {
    const fx = new Effect(connectDoc(), { seed: 1337 });
    const r = new PixiParticleRenderer(fx);
    const v = viewOf(r, 0);
    expect(v.trail).not.toBeNull();
    expect(v.trail!.mesh).toBeInstanceOf(Mesh);
    // The burst spawns ~12 particles at t=0; after a few steps they have distinct
    // positions, so the single connect ribbon has real geometry.
    for (let i = 0; i < 10; i++) fx.step(1 / 60);
    r.sync();
    const geom = v.trail!.geom;
    expect(geom.vertexCount).toBeGreaterThan(0);
    expect(geom.indexCount).toBeGreaterThan(0);
    expect(v.trail!.geometry.indexBuffer.data.length).toBe(geom.indexCount);
    expect(geom.positions.some((x) => x !== 0)).toBe(true);
    r.destroy();
  });
});
