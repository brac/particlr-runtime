import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BufferImageSource, ParticleContainer, Particle, Texture } from "pixi.js";
import type { Flipbook } from "../../src/format/types.js";
import { parseSpark } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { PixiSparkRenderer } from "../../src/pixi/renderer.js";

function loadDoc(name: string) {
  const raw = readFileSync(resolve(__dirname, `../../../../presets/${name}.spark`), "utf8");
  const parsed = parseSpark(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${JSON.stringify(parsed.errors)}`);
  return structuredClone(parsed.doc!);
}

function fakeTexture(width: number): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(width * width * 4), width, height: width }),
  });
}

const pcOf = (r: PixiSparkRenderer, i = 0) => r.container.children[i] as ParticleContainer;

describe("PixiSparkRenderer — user textures (P0.1)", () => {
  it("does not throw for a user: ref and renders a synchronous placeholder", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:test";
    doc.textures = { test: "data:image/png;base64,PLACEHOLDER-sync" };
    const fx = new Effect(doc, { seed: doc.seed });

    // Constructing must not throw even though the data URL is never in Pixi's cache.
    const r = new PixiSparkRenderer(fx, { loadTexture: async () => fakeTexture(128) });

    // Synchronously, the layer uses the 64px circle-soft placeholder.
    expect(pcOf(r).texture.width).toBe(64);
    expect(pcOf(r).texture.destroyed).toBe(false);
    r.destroy();
  });

  it("swaps in the decoded texture and recomputes invTexWidth once ready", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:test";
    doc.textures = { test: "data:image/png;base64,PLACEHOLDER-swap" };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiSparkRenderer(fx, { loadTexture: async () => fakeTexture(128) });

    await r.ready;

    expect(pcOf(r).texture.width).toBe(128);

    // invTexWidth is now 1/128: a live particle's scale reflects the real width.
    for (let i = 0; i < 10; i++) fx.step(1 / 60);
    r.sync();
    const part = pcOf(r).particleChildren[0]!;
    // scale = size * invTexWidth; with size ~10..16 and invTexWidth 1/128, scale < 0.2.
    expect(part.scaleX).toBeGreaterThan(0);
    expect(part.scaleX).toBeLessThan(16 / 128 + 1e-6);
    r.destroy();
  });

  it("keeps the placeholder and warns if decode fails", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:broken";
    doc.textures = { broken: "data:image/png;base64,PLACEHOLDER-broken" };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiSparkRenderer(fx, {
      loadTexture: async () => {
        throw new Error("decode failed");
      },
    });

    await r.ready;
    expect(pcOf(r).texture.width).toBe(64); // still the placeholder
    expect(r.warnings.some((w) => w.includes("broken"))).toBe(true);
    r.destroy();
  });
});

describe("PixiSparkRenderer — render list tracks live count, not capacity (P4.2)", () => {
  it("keeps particleChildren equal to the live count as it rises and falls", () => {
    // A short-burst, non-looping effect: particle count rises then falls to 0.
    const doc = loadDoc("sparks"); // single burst at t=0, no continuous rate
    doc.looping = false; // let the burst die out instead of re-firing each cycle
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiSparkRenderer(fx);
    const pc = pcOf(r);
    // Nothing simulated yet: the container holds no particles despite the pool
    // being preallocated to maxParticles.
    expect(pc.particleChildren.length).toBe(0);

    // Advance to a live frame and sync — the render list equals the live count
    // (dead slots are absent, not merely alpha 0), and each is visible.
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const live = fx.layers[0]!.count;
    expect(live).toBeGreaterThan(0);
    expect(pc.particleChildren.length).toBe(live);
    expect(pc.particleChildren.every((p) => p.alpha > 0)).toBe(true);

    // Run long past the burst's lifetime so every particle dies, then sync.
    for (let i = 0; i < 120; i++) fx.step(1 / 60);
    r.sync();
    expect(fx.layers[0]!.count).toBe(0);
    expect(pc.particleChildren.length).toBe(0); // drained, nothing to upload or draw
    r.destroy();
  });

  it("caps the render list far below capacity for a sparse high-capacity layer", () => {
    // The pathological shape: huge maxParticles, few live. The container must
    // never carry capacity-many children.
    const doc = loadDoc("rain");
    const layer = doc.layers[0]!;
    layer.emission.maxParticles = 5000;
    layer.emission.bursts = [];
    layer.emission.prewarm = true;
    layer.emission.rateOverTime = { mode: "constant", value: 30 };
    layer.initial.life = { mode: "constant", value: 1 }; // ~30 live steady state
    const fx = new Effect(doc, { seed: 1 });
    const r = new PixiSparkRenderer(fx);
    for (let i = 0; i < 60; i++) fx.step(1 / 60);
    r.sync();
    const live = fx.layers[0]!.count;
    expect(live).toBeLessThan(200); // sparse
    expect(pcOf(r).particleChildren.length).toBe(live); // not 5000
    r.destroy();
  });

  it("re-renders a slot correctly after it dies and is reused (burst → die → burst)", () => {
    // Guards the giant-particle bug's cousin: a slot removed from the container
    // then re-added must carry fresh vertex/scale data, not a stale upload.
    const doc = loadDoc("sparks");
    doc.looping = true;
    doc.duration = 0.5; // burst re-fires each short cycle
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiSparkRenderer(fx);
    const pc = pcOf(r);

    // First burst alive.
    for (let i = 0; i < 6; i++) fx.step(1 / 60);
    r.sync();
    expect(pc.particleChildren.length).toBeGreaterThan(0);

    // Let it fully die (render list drains), then the next cycle re-bursts.
    for (let i = 0; i < 30; i++) fx.step(1 / 60);
    r.sync();
    expect(pc.particleChildren.length).toBe(fx.layers[0]!.count);

    for (let i = 0; i < 6; i++) fx.step(1 / 60);
    r.sync();
    expect(pc.particleChildren.length).toBeGreaterThan(0);
    // The reused slot carries THIS frame's computed scale (size × invFrameWidth),
    // not a frozen leftover or a default-1 giant-particle quad.
    const v = viewOf(r);
    const reused = pc.particleChildren[0]!;
    expect(reused.scaleX).toBeCloseTo(v.buffers.size[0]! * v.invFrameWidth, 10);
    expect(reused.scaleX).toBeLessThan(1); // not a full-texture giant
    r.destroy();
  });
});

describe("PixiSparkRenderer — every per-frame attribute is GPU-dynamic", () => {
  // Regression: the option key for the scale-carrying attribute is `vertex`,
  // not `scale`. Pixi accepts unknown keys silently (Record<string, boolean>),
  // leaving vertex static: it uploads once at first render, freezing every
  // not-yet-live pool slot at the default scale 1. When the live count later
  // grew past the first-render count, that slot rendered as a full-texture-size
  // "giant particle" at the newborn's position, and size-over-lifetime never
  // animated on the GPU. Goldens can't catch this (each golden render IS a
  // first render), so guard the container config directly.
  it("marks vertex, position, rotation, and color dynamic on each ParticleContainer", () => {
    const doc = loadDoc("rain");
    const r = new PixiSparkRenderer(new Effect(doc, { seed: doc.seed }));
    for (const child of r.container.children) {
      const props = (child as ParticleContainer & { _properties: Record<string, { dynamic: boolean }> })._properties;
      for (const key of ["vertex", "position", "rotation", "color"]) {
        expect(props[key]!.dynamic, `${key} must be dynamic`).toBe(true);
      }
    }
    r.destroy();
  });
});

// White-box view of a layer's render state. Mirrors the existing `_properties`
// cast below — a unit test may read the renderer's private slices to prove the
// flipbook wiring without exposing them as public API.
interface ViewProbe {
  frames: Texture[] | null;
  invFrameWidth: number;
  buffers: { size: Float32Array };
  particles: Particle[];
}
const viewOf = (r: PixiSparkRenderer, i = 0): ViewProbe =>
  (r as unknown as { views: ViewProbe[] }).views[i]!;

const uvsDynamic = (pc: ParticleContainer): boolean =>
  (pc as ParticleContainer & { _properties: Record<string, { dynamic: boolean }> })._properties.uvs!.dynamic;

// Flipbook a built-in texture: single-frame in practice, but the slicing +
// frame-advance mechanism is texture-agnostic, so a built-in gives us the whole
// pipeline synchronously (no async decode). Pin circle-soft (64×64) so cells are
// a clean 32×32 — rain's own `spark` texture is 64×16.
function flipbookDoc(fb: Flipbook) {
  const doc = loadDoc("rain");
  doc.layers[0]!.texture.ref = "circle-soft";
  doc.layers[0]!.texture.frames = fb;
  return doc;
}

describe("PixiSparkRenderer — flipbook rendering (P4.1)", () => {
  it("slices a cols×rows sheet row-major with a top-left origin", () => {
    const r = new PixiSparkRenderer(new Effect(flipbookDoc({ cols: 2, rows: 2, fps: 10, mode: "loop" }), { seed: 1 }));
    const v = viewOf(r);
    expect(v.frames).not.toBeNull();
    expect(v.frames!.length).toBe(4);
    // circle-soft is 64×64 → 32×32 cells; index i → col i%2, row ⌊i/2⌋.
    const rect = (i: number) => ({ x: v.frames![i]!.frame.x, y: v.frames![i]!.frame.y, w: v.frames![i]!.frame.width, h: v.frames![i]!.frame.height });
    expect(rect(0)).toEqual({ x: 0, y: 0, w: 32, h: 32 });
    expect(rect(1)).toEqual({ x: 32, y: 0, w: 32, h: 32 });
    expect(rect(2)).toEqual({ x: 0, y: 32, w: 32, h: 32 });
    expect(rect(3)).toEqual({ x: 32, y: 32, w: 32, h: 32 });
    // invFrameWidth is 1/cellWidth = cols/sheetWidth, not 1/sheetWidth.
    expect(v.invFrameWidth).toBeCloseTo(2 / 64, 10);
    r.destroy();
  });

  it("advances each particle's frame by age in loop mode", () => {
    const fps = 10;
    const cols = 2;
    const fx = new Effect(flipbookDoc({ cols, rows: 2, fps, mode: "loop" }), { seed: 1 });
    const r = new PixiSparkRenderer(fx);
    const v = viewOf(r);
    for (let i = 0; i < 30; i++) fx.step(1 / 60);
    r.sync();
    const count = fx.layers[0]!.count;
    expect(count).toBeGreaterThan(0);
    const total = cols * 2;
    for (let j = 0; j < count; j++) {
      const age = fx.layers[0]!.pool.age[j]!;
      const expected = ((Math.floor(age * fps) % total) + total) % total;
      const rect = v.particles[j]!.texture.frame;
      const got = (rect.y / 32) * cols + rect.x / 32;
      expect(got, `particle ${j} age ${age}`).toBe(expected);
    }
    r.destroy();
  });

  it("clamps to the last frame in once mode", () => {
    const fps = 60;
    const fx = new Effect(flipbookDoc({ cols: 2, rows: 2, fps, mode: "once" }), { seed: 1 });
    const r = new PixiSparkRenderer(fx);
    const v = viewOf(r);
    // Step long enough that particle 0's age·fps exceeds the 4-frame count.
    for (let i = 0; i < 40; i++) fx.step(1 / 60);
    r.sync();
    const age = fx.layers[0]!.pool.age[0]!;
    expect(age * fps).toBeGreaterThan(4); // past the sheet
    const rect = v.particles[0]!.texture.frame;
    expect({ x: rect.x, y: rect.y }).toEqual({ x: 32, y: 32 }); // frame 3 (last)
    r.destroy();
  });

  it("picks a stable per-particle frame in random mode", () => {
    const fx = new Effect(flipbookDoc({ cols: 2, rows: 2, fps: 10, mode: "random" }), { seed: 1 });
    const r = new PixiSparkRenderer(fx);
    const v = viewOf(r);
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const first = v.particles[0]!.texture;
    fx.step(1 / 60);
    r.sync();
    expect(v.particles[0]!.texture).toBe(first); // same frame across syncs
    r.destroy();
  });

  it("scales by frame width, not sheet width", () => {
    const fx = new Effect(flipbookDoc({ cols: 2, rows: 2, fps: 10, mode: "loop" }), { seed: 1 });
    const r = new PixiSparkRenderer(fx);
    const v = viewOf(r);
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const part = v.particles[0]!;
    // scaleX == renderSize * invFrameWidth (frame basis), not / sheetWidth.
    expect(part.scaleX).toBeCloseTo(v.buffers.size[0]! * v.invFrameWidth, 10);
    expect(part.scaleX).not.toBeCloseTo(v.buffers.size[0]! / 64, 6); // would be the sheet-width bug
    r.destroy();
  });

  it("leaves non-flipbook layers single-frame with static uvs", () => {
    const r = new PixiSparkRenderer(new Effect(loadDoc("rain"), { seed: 1 }));
    const v = viewOf(r);
    expect(v.frames).toBeNull();
    expect(uvsDynamic(pcOf(r))).toBe(false);
    r.destroy();
  });

  it("marks uvs dynamic only when a flipbook is present", () => {
    const r = new PixiSparkRenderer(new Effect(flipbookDoc({ cols: 2, rows: 2, fps: 10, mode: "loop" }), { seed: 1 }));
    expect(uvsDynamic(pcOf(r))).toBe(true);
    r.destroy();
  });

  it("treats a single-cell flipbook as a no-op", () => {
    const r = new PixiSparkRenderer(new Effect(flipbookDoc({ cols: 1, rows: 1, fps: 10, mode: "loop" }), { seed: 1 }));
    expect(viewOf(r).frames).toBeNull();
    // uvs is still marked dynamic (frames !== null in the doc) but harmless.
    r.destroy();
  });

  it("slices the flipbook only after an async user texture decodes", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:fb";
    doc.textures = { fb: "data:image/png;base64,PLACEHOLDER-fb" };
    doc.layers[0]!.texture.frames = { cols: 2, rows: 2, fps: 10, mode: "loop" };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiSparkRenderer(fx, { loadTexture: async () => fakeTexture(128) });

    // While the placeholder shows, frames is null and sync must not throw.
    expect(viewOf(r).frames).toBeNull();
    for (let i = 0; i < 10; i++) fx.step(1 / 60);
    expect(() => r.sync()).not.toThrow();

    await r.ready;
    const v = viewOf(r);
    expect(v.frames!.length).toBe(4);
    expect(v.frames![0]!.frame.width).toBe(64); // 128px sheet / 2 cols
    expect(v.invFrameWidth).toBeCloseTo(2 / 128, 10);
    r.destroy();
  });
});

describe("PixiSparkRenderer — built-in texture cache self-heal (P0.2)", () => {
  it("regenerates a built-in texture destroyed by host teardown", () => {
    const doc = loadDoc("rain"); // uses the built-in "spark" texture
    const a = new PixiSparkRenderer(new Effect(doc, { seed: doc.seed }));
    const texA = pcOf(a).texture;
    expect(texA.width).toBeGreaterThan(0);

    // Simulate a host doing app.destroy(..., { texture: true }) while the shared
    // built-in is still referenced: the cached Texture becomes destroyed.
    texA.destroy(true);
    expect(texA.destroyed).toBe(true);
    a.destroy();

    // A fresh renderer must NOT get the poisoned texture.
    const b = new PixiSparkRenderer(new Effect(doc, { seed: doc.seed }));
    const texB = pcOf(b).texture;
    expect(texB.destroyed).toBe(false);
    expect(texB.width).toBeGreaterThan(0);
    b.destroy();
  });
});
