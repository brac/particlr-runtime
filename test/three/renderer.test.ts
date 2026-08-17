import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Mesh, InstancedBufferGeometry, DataTexture, RGBAFormat, UnsignedByteType } from "three";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { ThreeParticleRenderer } from "../../src/three/renderer.js";
import { presetsDir, hasPresets } from "../_presets.js";

const DEG2RAD = Math.PI / 180;

function loadDoc(name: string) {
  const parsed = parseParticle(readFileSync(resolve(presetsDir, `${name}.prt`), "utf8"));
  if (!parsed.ok) throw new Error(`fixture ${name} invalid`);
  return structuredClone(parsed.doc!);
}
const fakeTexture = (w: number) => new DataTexture(new Uint8Array(w * w * 4), w, w, RGBAFormat, UnsignedByteType);
const meshOf = (r: ThreeParticleRenderer, i = 0) => r.root.children[i] as Mesh;

describe.skipIf(!hasPresets)("ThreeParticleRenderer — sprite parity", () => {
  it("instance attributes equal the core render buffers under the y/angle mapping (plain branch)", () => {
    const doc = loadDoc("fireball");
    const fx = new Effect(doc, { seed: 1337 });
    const r = new ThreeParticleRenderer(fx);
    for (let f = 0; f < 30; f++) fx.step(1 / 60);
    r.sync();

    // Independent reference computation on a twin Effect.
    const fx2 = new Effect(structuredClone(doc), { seed: 1337 });
    for (let f = 0; f < 30; f++) fx2.step(1 / 60);
    const ls = fx2.layers[0]!;
    expect(ls.layer.render).toBeNull(); // guards this test's plain-branch assumption
    expect(ls.layer.randomFlip).toBeNull();
    const buf = makeRenderBuffers(ls.layer.emission.maxParticles);
    computeRenderState(ls, buf);

    const geo = meshOf(r).geometry as InstancedBufferGeometry;
    expect(geo.instanceCount).toBe(ls.count);
    const pos = geo.getAttribute("aInstPos");
    const color = geo.getAttribute("aColor");
    const size = geo.getAttribute("aSize");
    const angle = geo.getAttribute("aAngle");
    const stretch = geo.getAttribute("aStretch");
    const flip = geo.getAttribute("aFlip");
    for (let j = 0; j < ls.count; j++) {
      expect(pos.getX(j)).toBeCloseTo(ls.pool.x[j]!, 5);
      expect(pos.getY(j)).toBeCloseTo(-ls.pool.y[j]!, 5); // y negated
      expect(size.getX(j)).toBeCloseTo(buf.size[j]!, 5);
      expect(color.getX(j)).toBeCloseTo(buf.r[j]!, 5);
      expect(color.getW(j)).toBeCloseTo(buf.a[j]!, 5);
      // Plain branch: angle comes straight from pool.rotation (negated,
      // radians), not the render buffer's velAngle; stretch/flip are identity.
      expect(angle.getX(j)).toBeCloseTo(-ls.pool.rotation[j]! * DEG2RAD, 5);
      expect(stretch.getX(j)).toBeCloseTo(1, 5);
      expect(flip.getX(j)).toBe(0);
    }
    r.destroy();
  });

  it("extended branch: a render/randomFlip layer writes aAngle/aStretch/aFlip from the render buffers", () => {
    const doc = loadDoc("fireball");
    // Force the extended loop body (renderer.ts): render non-null drives
    // velocity-aligned rotation + speed stretch, randomFlip(x:1,y:1) forces
    // both flip bits on virtually every particle (ux/uy < 1 almost always).
    doc.layers[0]!.render = { align: "velocity", speedScale: 1, minStretch: 1, maxStretch: 3 };
    doc.layers[0]!.randomFlip = { x: 1, y: 1 };
    const fx = new Effect(doc, { seed: 1337 });
    const r = new ThreeParticleRenderer(fx);
    for (let f = 0; f < 30; f++) fx.step(1 / 60);
    r.sync();

    const fx2 = new Effect(structuredClone(doc), { seed: 1337 });
    for (let f = 0; f < 30; f++) fx2.step(1 / 60);
    const ls = fx2.layers[0]!;
    expect(ls.layer.render).not.toBeNull(); // guards this test's extended-branch assumption
    expect(ls.layer.randomFlip).not.toBeNull();
    const buf = makeRenderBuffers(ls.layer.emission.maxParticles);
    computeRenderState(ls, buf);
    expect(ls.count).toBeGreaterThan(0);

    const geo = meshOf(r).geometry as InstancedBufferGeometry;
    const angle = geo.getAttribute("aAngle");
    const stretch = geo.getAttribute("aStretch");
    const flip = geo.getAttribute("aFlip");
    for (let j = 0; j < ls.count; j++) {
      expect(angle.getX(j)).toBeCloseTo(-buf.velAngle[j]! * DEG2RAD, 5);
      expect(stretch.getX(j)).toBeCloseTo(buf.stretch[j]!, 5);
      expect(flip.getX(j)).toBe(buf.flip[j]!);
    }
    r.destroy();
  });

  it("a world layer's mesh stays at origin while a local layer rides the emitter", () => {
    const doc = loadDoc("fireball");
    const fx = new Effect(doc, { seed: 1 });
    const r = new ThreeParticleRenderer(fx);
    fx.setEmitterPosition(40, 30);
    fx.step(1 / 60);
    r.sync();
    fx.layers.forEach((ls, i) => {
      const m = r.root.children[i]! as Mesh;
      if (ls.layer.space === "world") expect([m.position.x, m.position.y]).toEqual([0, 0]);
      else {
        expect(m.position.x).toBeCloseTo(fx.emitterX, 5);
        expect(m.position.y).toBeCloseTo(-fx.emitterY, 5);
      }
    });
    r.destroy();
  });

  it("billboard toggles every material's uBillboard uniform", () => {
    const fx = new Effect(loadDoc("fireball"), { seed: 1 });
    const r = new ThreeParticleRenderer(fx, { billboard: true });
    const mat = meshOf(r).material as any;
    expect(mat.uniforms.uBillboard.value).toBe(1);
    r.billboard = false;
    expect(mat.uniforms.uBillboard.value).toBe(0);
    r.destroy();
  });

  it("user texture: synchronous placeholder, then async swap on decode success", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:test";
    doc.textures = { test: "data:image/png;base64,PLACEHOLDER-swap" };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new ThreeParticleRenderer(fx, { loadTexture: async () => fakeTexture(128) });
    expect((meshOf(r).material as any).uniforms.uTexture.value.image.width).toBe(64); // circle-soft placeholder
    await r.ready;
    expect((meshOf(r).material as any).uniforms.uTexture.value.image.width).toBe(128);
    r.destroy();
  });

  it("user texture: decode failure leaves the placeholder and warns", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:broken";
    // Unique data URL: must not collide with any other test's cache entry, or
    // this loader would never even be called.
    doc.textures = { broken: "data:image/png;base64,PLACEHOLDER-broken" };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new ThreeParticleRenderer(fx, { loadTexture: async () => { throw new Error("boom"); } });
    await r.ready;
    expect(r.warnings.some((w) => w.includes("could not be decoded"))).toBe(true);
    expect((meshOf(r).material as any).uniforms.uTexture.value.image.width).toBe(64); // still the placeholder
    r.destroy();
  });

  it("user texture cache: a second renderer over the same data URL resolves synchronously, even through an injected loader", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:cached";
    doc.textures = { cached: "data:image/png;base64,PLACEHOLDER-cachehit" };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new ThreeParticleRenderer(fx, { loadTexture: async () => fakeTexture(128) });
    await r.ready;
    r.destroy();

    // A fresh Effect/doc referencing the SAME data URL. The loader would
    // throw if it were ever invoked — proving resolution came from cache, not
    // a second decode.
    const fx2 = new Effect(structuredClone(doc), { seed: doc.seed });
    const r2 = new ThreeParticleRenderer(fx2, {
      loadTexture: async () => { throw new Error("must not be called: should resolve from cache"); },
    });
    // Synchronous — no `await r2.ready` before this assertion.
    expect((meshOf(r2).material as any).uniforms.uTexture.value.image.width).toBe(128);
    await r2.ready;
    expect(r2.warnings.length).toBe(0);
    r2.destroy();
  });

  it("user texture cache: a disposed cached texture (from an injected loader) is never handed out again", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:disposable";
    doc.textures = { disposable: "data:image/png;base64,PLACEHOLDER-disposecache" };
    const fx = new Effect(doc, { seed: doc.seed });
    const firstTex = fakeTexture(128);
    const r = new ThreeParticleRenderer(fx, { loadTexture: async () => firstTex });
    await r.ready; // firstTex is now cached under the data URL
    r.destroy();
    firstTex.dispose(); // must flip userData.particlrDisposed via the cache's dispose hook
    expect(firstTex.userData.particlrDisposed).toBe(true);

    // A fresh renderer over the same data URL, with a loader returning a
    // DIFFERENT texture. Since the cached entry is now disposed, resolution
    // must NOT be synchronous from cache — it must show the placeholder
    // first, then swap in the new decode once ready.
    const fx2 = new Effect(structuredClone(doc), { seed: doc.seed });
    const secondTex = fakeTexture(256);
    const r2 = new ThreeParticleRenderer(fx2, { loadTexture: async () => secondTex });
    expect((meshOf(r2).material as any).uniforms.uTexture.value.image.width).toBe(64); // placeholder, not the disposed 128px texture
    await r2.ready;
    expect((meshOf(r2).material as any).uniforms.uTexture.value.image.width).toBe(256);
    r2.destroy();
  });

  it("destroy() disposes geometries and materials but never the texture object itself", () => {
    const fx = new Effect(loadDoc("fireball"), { seed: 1 });
    const r = new ThreeParticleRenderer(fx);
    const geo = meshOf(r).geometry;
    // Capture the SAME texture object the first renderer bound, before
    // destroy() runs — builtinTexture's self-healing cache would otherwise
    // make this assertion vacuous (a freshly-resolved texture is trivially
    // live regardless of what destroy() did).
    const tex = (meshOf(r).material as any).uniforms.uTexture.value;
    let disposed = 0;
    geo.addEventListener("dispose", () => disposed++);
    r.destroy();
    expect(disposed).toBe(1);
    expect(tex.userData.particlrDisposed).not.toBe(true);
  });
});
