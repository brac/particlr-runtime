import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BufferImageSource, ParticleContainer, Texture } from "pixi.js";
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

describe("PixiSparkRenderer — dead particles stay hidden after count shrinks (P4.2)", () => {
  it("re-hides particles that died since the last sync", () => {
    // A short-burst, non-looping effect: particle count rises then falls to 0.
    const doc = loadDoc("sparks"); // single burst at t=0, no continuous rate
    doc.looping = false; // let the burst die out instead of re-firing each cycle
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiSparkRenderer(fx);
    const parts = pcOf(r).particleChildren;

    // Advance to a live frame and sync — some particles are visible.
    for (let i = 0; i < 20; i++) fx.step(1 / 60);
    r.sync();
    const live = fx.layers[0]!.count;
    expect(live).toBeGreaterThan(0);
    let visible = parts.filter((p) => p.alpha > 0).length;
    expect(visible).toBe(live);

    // Run long past the burst's lifetime so every particle dies, then sync.
    for (let i = 0; i < 120; i++) fx.step(1 / 60);
    r.sync();
    expect(fx.layers[0]!.count).toBe(0);
    visible = parts.filter((p) => p.alpha > 0).length;
    expect(visible).toBe(0); // the optimized zeroing still hides all dead slots
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
