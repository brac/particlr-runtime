import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BufferImageSource, ParticleContainer, Particle, Texture } from "pixi.js";
import type { Flipbook } from "../../src/format/types.js";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { PixiParticleRenderer, dataUrlToBlob } from "../../src/pixi/renderer.js";
import { presetsDir, hasPresets } from "../_presets.js";

function loadDoc(name: string) {
  const raw = readFileSync(resolve(presetsDir, `${name}.prt`), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${JSON.stringify(parsed.errors)}`);
  return structuredClone(parsed.doc!);
}

function fakeTexture(width: number): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(width * width * 4), width, height: width }),
  });
}

const pcOf = (r: PixiParticleRenderer, i = 0) => r.container.children[i] as ParticleContainer;

describe.skipIf(!hasPresets)("PixiParticleRenderer — user textures (P0.1)", () => {
  it("does not throw for a user: ref and renders a synchronous placeholder", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:test";
    doc.textures = { test: "data:image/png;base64,PLACEHOLDER-sync" };
    const fx = new Effect(doc, { seed: doc.seed });

    // Constructing must not throw even though the data URL is never in Pixi's cache.
    const r = new PixiParticleRenderer(fx, { loadTexture: async () => fakeTexture(128) });

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
    const r = new PixiParticleRenderer(fx, { loadTexture: async () => fakeTexture(128) });

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
    const r = new PixiParticleRenderer(fx, {
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

describe("dataUrlToBlob — embedded texture decode carries no network capability", () => {
  // 1×1 red PNG.
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("decodes a base64 image data URL into a typed Blob", async () => {
    const blob = dataUrlToBlob(`data:image/png;base64,${PNG_B64}`);
    expect(blob.type).toBe("image/png");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature
  });

  it("throws on anything that is not a base64 image data URL (E44 shape)", () => {
    const bads = [
      "https://evil.example/x.png", // remote URL — the whole point of not using fetch()
      "data:text/html;base64,AAAA", // non-image MIME
      `data:image/png,${PNG_B64}`, // not base64-marked
      "data:image/png;base64,%%%%", // malformed base64 payload
    ];
    for (const bad of bads) expect(() => dataUrlToBlob(bad), bad).toThrow();
  });
});

describe.skipIf(!hasPresets)("PixiParticleRenderer — default loader never fetches", () => {
  it("falls back to the placeholder on a remote-URL texture without calling fetch", async () => {
    const spy = vi.fn();
    const orig = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const doc = loadDoc("rain");
      doc.layers[0]!.texture.ref = "user:evil";
      doc.textures = { evil: "https://evil.example/x.png" };
      const fx = new Effect(doc, { seed: doc.seed });
      const r = new PixiParticleRenderer(fx); // default decode path, no injected loader
      await r.ready;
      expect(spy).not.toHaveBeenCalled();
      expect(pcOf(r).texture.width).toBe(64); // soft-circle placeholder kept
      expect(r.warnings.some((w) => w.includes("evil"))).toBe(true);
      r.destroy();
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe.skipIf(!hasPresets)("PixiParticleRenderer — render list tracks live count, not capacity (P4.2)", () => {
  it("keeps particleChildren equal to the live count as it rises and falls", () => {
    // A short-burst, non-looping effect: particle count rises then falls to 0.
    const doc = loadDoc("sparks"); // single burst at t=0, no continuous rate
    doc.looping = false; // let the burst die out instead of re-firing each cycle
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
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
    const r = new PixiParticleRenderer(fx);
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
    const r = new PixiParticleRenderer(fx);
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

describe.skipIf(!hasPresets)("PixiParticleRenderer — every per-frame attribute is GPU-dynamic", () => {
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
    const r = new PixiParticleRenderer(new Effect(doc, { seed: doc.seed }));
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
const viewOf = (r: PixiParticleRenderer, i = 0): ViewProbe =>
  (r as unknown as { views: ViewProbe[] }).views[i]!;

const uvsDynamic = (pc: ParticleContainer): boolean =>
  (pc as ParticleContainer & { _properties: Record<string, { dynamic: boolean }> })._properties.uvs!.dynamic;

// Flipbook a built-in texture: single-frame in practice, but the slicing +
// frame-advance mechanism is texture-agnostic, so a built-in gives us the whole
// pipeline synchronously (no async decode). Pin circle-soft (64×64) so cells are
// a clean 32×32 — rain's own `spark` texture is 64×16.
function flipbookDoc(fb: Partial<Flipbook> & Pick<Flipbook, "cols" | "rows" | "fps" | "mode">) {
  const doc = loadDoc("rain");
  doc.layers[0]!.texture.ref = "circle-soft";
  // Inject the A7 v5 defaults (inert null-pin path) unless a caller overrides them,
  // so these pre-A7 slicing / frame-advance fixtures keep exercising ⌊age·fps⌋.
  doc.layers[0]!.texture.frames = { randomStartFrame: false, frameOverLife: null, ...fb };
  return doc;
}

describe.skipIf(!hasPresets)("PixiParticleRenderer — flipbook rendering (P4.1)", () => {
  it("slices a cols×rows sheet row-major with a top-left origin", () => {
    const r = new PixiParticleRenderer(new Effect(flipbookDoc({ cols: 2, rows: 2, fps: 10, mode: "loop" }), { seed: 1 }));
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
    const r = new PixiParticleRenderer(fx);
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
    const r = new PixiParticleRenderer(fx);
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
    const r = new PixiParticleRenderer(fx);
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
    const r = new PixiParticleRenderer(fx);
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
    const r = new PixiParticleRenderer(new Effect(loadDoc("rain"), { seed: 1 }));
    const v = viewOf(r);
    expect(v.frames).toBeNull();
    expect(uvsDynamic(pcOf(r))).toBe(false);
    r.destroy();
  });

  it("marks uvs dynamic only when a flipbook is present", () => {
    const r = new PixiParticleRenderer(new Effect(flipbookDoc({ cols: 2, rows: 2, fps: 10, mode: "loop" }), { seed: 1 }));
    expect(uvsDynamic(pcOf(r))).toBe(true);
    r.destroy();
  });

  it("treats a single-cell flipbook as a no-op", () => {
    const r = new PixiParticleRenderer(new Effect(flipbookDoc({ cols: 1, rows: 1, fps: 10, mode: "loop" }), { seed: 1 }));
    expect(viewOf(r).frames).toBeNull();
    // uvs is still marked dynamic (frames !== null in the doc) but harmless.
    r.destroy();
  });

  it("slices the flipbook only after an async user texture decodes", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:fb";
    doc.textures = { fb: "data:image/png;base64,PLACEHOLDER-fb" };
    doc.layers[0]!.texture.frames = { cols: 2, rows: 2, fps: 10, mode: "loop", randomStartFrame: false, frameOverLife: null };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx, { loadTexture: async () => fakeTexture(128) });

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

describe.skipIf(!hasPresets)("PixiParticleRenderer — velocity alignment + speed stretch (M1)", () => {
  it("sets rotation from velocity and stretches scaleX (≠ scaleY) when render is set", () => {
    const doc = loadDoc("rain");
    const l = doc.layers[0]!;
    l.render = { align: "velocity", speedScale: 0.02, minStretch: 1, maxStretch: 6 };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const p = fx.layers[0]!.pool;
    const count = fx.layers[0]!.count;
    expect(count).toBeGreaterThan(0);
    const pc = pcOf(r);
    let sawStretch = false;
    for (let j = 0; j < count; j++) {
      const vx = p.velX[j]!;
      const vy = p.velY[j]!;
      const speed = Math.hypot(vx, vy);
      const part = pc.particleChildren[j]!;
      // rotation follows the velocity vector. The buffer holds the angle in
      // degrees and the renderer converts to radians, so part.rotation === atan2
      // (radians) directly.
      if (speed >= 1e-3) expect(part.rotation).toBeCloseTo(Math.atan2(vy, vx), 5);
      // scaleX carries the stretch; scaleY does not → they differ for any moving particle.
      const stretch = Math.min(6, Math.max(1, 1 + 0.02 * speed));
      expect(part.scaleX).toBeCloseTo(part.scaleY * stretch, 6);
      if (stretch > 1.0001) {
        expect(part.scaleX).not.toBeCloseTo(part.scaleY, 4);
        sawStretch = true;
      }
    }
    expect(sawStretch).toBe(true); // rain falls fast — at least one stretched streak
    r.destroy();
  });

  it("randomFlip X (prob 1) mirrors scaleX only: scaleX = −scaleY, rotation === pool.rotation (M5)", () => {
    // randomFlip's presence routes sync() through the extended body. With M5 the
    // flip is REAL: x=1 flips every particle's X (negative scaleX, magnitude
    // preserved) while rotation still comes from pool.rotation (render is null).
    const doc = loadDoc("rain");
    const l = doc.layers[0]!;
    l.randomFlip = { x: 1, y: 0 };
    l.render = null;
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const p = fx.layers[0]!.pool;
    const count = fx.layers[0]!.count;
    expect(count).toBeGreaterThan(0);
    const pc = pcOf(r);
    const DEG2RAD = Math.PI / 180;
    for (let j = 0; j < count; j++) {
      const part = pc.particleChildren[j]!;
      expect(part.rotation).toBeCloseTo(p.rotation[j]! * DEG2RAD, 6); // rotation still pool.rotation
      expect(part.scaleX).toBeLessThan(0); // X mirrored
      expect(part.scaleY).toBeGreaterThan(0); // Y untouched
      expect(part.scaleX).toBeCloseTo(-part.scaleY, 6); // magnitude preserved
    }
    r.destroy();
  });

  it("randomFlip Y (prob 1) mirrors scaleY only (negative scale, not UV flip) (M5)", () => {
    const doc = loadDoc("rain");
    const l = doc.layers[0]!;
    l.randomFlip = { x: 0, y: 1 };
    l.render = null;
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const count = fx.layers[0]!.count;
    expect(count).toBeGreaterThan(0);
    const pc = pcOf(r);
    for (let j = 0; j < count; j++) {
      const part = pc.particleChildren[j]!;
      expect(part.scaleY).toBeLessThan(0); // Y mirrored
      expect(part.scaleX).toBeGreaterThan(0); // X untouched
      expect(part.scaleX).toBeCloseTo(-part.scaleY, 6);
    }
    r.destroy();
  });

  it("randomFlip X+Y with render stretch: flip applied AFTER stretch (|scaleX| keeps the stretch)", () => {
    const doc = loadDoc("rain");
    const l = doc.layers[0]!;
    l.randomFlip = { x: 1, y: 1 };
    l.render = { align: "none", speedScale: 0.02, minStretch: 1, maxStretch: 6 };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const p = fx.layers[0]!.pool;
    const count = fx.layers[0]!.count;
    const pc = pcOf(r);
    let sawStretch = false;
    for (let j = 0; j < count; j++) {
      const part = pc.particleChildren[j]!;
      expect(part.scaleX).toBeLessThan(0);
      expect(part.scaleY).toBeLessThan(0);
      const speed = Math.hypot(p.velX[j]!, p.velY[j]!);
      const stretch = Math.min(6, Math.max(1, 1 + 0.02 * speed));
      // |scaleX| = |scaleY|·stretch — the flip negates but does not erase the stretch.
      expect(Math.abs(part.scaleX)).toBeCloseTo(Math.abs(part.scaleY) * stretch, 5);
      if (stretch > 1.0001) sawStretch = true;
    }
    expect(sawStretch).toBe(true);
    r.destroy();
  });

  it("render:null keeps scaleX === scaleY and rotation from pool.rotation (existing body)", () => {
    const doc = loadDoc("rain"); // render is null
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const p = fx.layers[0]!.pool;
    const count = fx.layers[0]!.count;
    const pc = pcOf(r);
    const DEG2RAD = Math.PI / 180;
    for (let j = 0; j < count; j++) {
      const part = pc.particleChildren[j]!;
      expect(part.scaleX).toBe(part.scaleY);
      expect(part.rotation).toBeCloseTo(p.rotation[j]! * DEG2RAD, 6);
    }
    r.destroy();
  });
});

describe.skipIf(!hasPresets)("PixiParticleRenderer — built-in texture cache self-heal (P0.2)", () => {
  it("regenerates a built-in texture destroyed by host teardown", () => {
    const doc = loadDoc("rain"); // uses the built-in "spark" texture
    const a = new PixiParticleRenderer(new Effect(doc, { seed: doc.seed }));
    const texA = pcOf(a).texture;
    expect(texA.width).toBeGreaterThan(0);

    // Simulate a host doing app.destroy(..., { texture: true }) while the shared
    // built-in is still referenced: the cached Texture becomes destroyed.
    texA.destroy(true);
    expect(texA.destroyed).toBe(true);
    a.destroy();

    // A fresh renderer must NOT get the poisoned texture.
    const b = new PixiParticleRenderer(new Effect(doc, { seed: doc.seed }));
    const texB = pcOf(b).texture;
    expect(texB.destroyed).toBe(false);
    expect(texB.width).toBeGreaterThan(0);
    b.destroy();
  });
});

describe.skipIf(!hasPresets)("PixiParticleRenderer — emitter placement (schemaVersion 2)", () => {
  it("places a local layer's container at the emitter; a world layer stays at origin", () => {
    // Two layers: layer 0 local, layer 1 world.
    const doc = loadDoc("rain");
    const l = doc.layers[0]!;
    const world = structuredClone(l);
    world.id = "w";
    world.space = "world";
    l.space = "local";
    doc.layers = [l, world];

    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);

    fx.setEmitterPosition(120, 45);
    fx.step(1 / 60);
    r.sync();

    const localPc = pcOf(r, 0);
    const worldPc = pcOf(r, 1);
    expect([localPc.position.x, localPc.position.y]).toEqual([120, 45]);
    expect([worldPc.position.x, worldPc.position.y]).toEqual([0, 0]);
    r.destroy();
  });

  it("keeps both containers at the origin when the emitter never moves (v1 parity)", () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.space = "local";
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    for (let i = 0; i < 5; i++) fx.step(1 / 60);
    r.sync();
    const pc = pcOf(r, 0);
    expect([pc.position.x, pc.position.y]).toEqual([0, 0]);
    r.destroy();
  });

  it("a world layer's particles advance in world coords while its container stays put", () => {
    const doc = loadDoc("rain");
    const l = doc.layers[0]!;
    l.space = "world";
    // Point shape + a single burst at f=0 so the spawn lands exactly at the
    // segment start (the teleported point), isolating the world offset.
    l.shape = { kind: "point", emitFrom: "volume" };
    l.emission.bursts = [{ time: 0, count: 1, spread: 0 }];
    l.emission.rateOverTime = { mode: "constant", value: 0 };
    doc.layers = [l];
    doc.looping = false;

    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    fx.teleportEmitter(200, 0); // spawn point (no interpolation across the gap)
    fx.setEmitterPosition(260, 0); // travel 60px this step
    fx.step(1 / 60);
    r.sync();

    const pc = pcOf(r, 0);
    expect([pc.position.x, pc.position.y]).toEqual([0, 0]); // container fixed
    // Particle x carries the world coordinate (segment start = 200), not local 0.
    const part = pc.particleChildren[0]!;
    expect(part.x).toBeCloseTo(200, 3);
    r.destroy();
  });
});
