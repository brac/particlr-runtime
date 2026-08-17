import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Mesh, InstancedBufferGeometry, DataTexture, RGBAFormat, UnsignedByteType } from "three";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { computeRenderState, makeRenderBuffers } from "../../src/core/render.js";
import { ThreeParticleRenderer } from "../../src/three/renderer.js";
import { presetsDir, hasPresets } from "../_presets.js";

function loadDoc(name: string) {
  const parsed = parseParticle(readFileSync(resolve(presetsDir, `${name}.prt`), "utf8"));
  if (!parsed.ok) throw new Error(`fixture ${name} invalid`);
  return structuredClone(parsed.doc!);
}
const fakeTexture = (w: number) => new DataTexture(new Uint8Array(w * w * 4), w, w, RGBAFormat, UnsignedByteType);
const meshOf = (r: ThreeParticleRenderer, i = 0) => r.root.children[i] as Mesh;

describe.skipIf(!hasPresets)("ThreeParticleRenderer — sprite parity", () => {
  it("instance attributes equal the core render buffers under the y/angle mapping", () => {
    const doc = loadDoc("fireball");
    const fx = new Effect(doc, { seed: 1337 });
    const r = new ThreeParticleRenderer(fx);
    for (let f = 0; f < 30; f++) fx.step(1 / 60);
    r.sync();

    // Independent reference computation on a twin Effect.
    const fx2 = new Effect(structuredClone(doc), { seed: 1337 });
    for (let f = 0; f < 30; f++) fx2.step(1 / 60);
    const ls = fx2.layers[0]!;
    const buf = makeRenderBuffers(ls.layer.emission.maxParticles);
    computeRenderState(ls, buf);

    const geo = meshOf(r).geometry as InstancedBufferGeometry;
    expect(geo.instanceCount).toBe(ls.count);
    const pos = geo.getAttribute("aInstPos");
    const color = geo.getAttribute("aColor");
    const size = geo.getAttribute("aSize");
    for (let j = 0; j < ls.count; j++) {
      expect(pos.getX(j)).toBeCloseTo(ls.pool.x[j]!, 5);
      expect(pos.getY(j)).toBeCloseTo(-ls.pool.y[j]!, 5); // y negated
      expect(size.getX(j)).toBeCloseTo(buf.size[j]!, 5);
      expect(color.getX(j)).toBeCloseTo(buf.r[j]!, 5);
      expect(color.getW(j)).toBeCloseTo(buf.a[j]!, 5);
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

  it("user texture: synchronous placeholder, async swap, decode-failure warning", async () => {
    const doc = loadDoc("rain");
    doc.layers[0]!.texture.ref = "user:test";
    doc.textures = { test: "data:image/png;base64,PLACEHOLDER" };
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new ThreeParticleRenderer(fx, { loadTexture: async () => fakeTexture(128) });
    expect((meshOf(r).material as any).uniforms.uTexture.value.image.width).toBe(64); // circle-soft placeholder
    await r.ready;
    expect((meshOf(r).material as any).uniforms.uTexture.value.image.width).toBe(128);
    r.destroy();

    const fx2 = new Effect(structuredClone(doc), { seed: doc.seed });
    const r2 = new ThreeParticleRenderer(fx2, { loadTexture: async () => { throw new Error("boom"); } });
    await r2.ready;
    expect(r2.warnings.some((w) => w.includes("could not be decoded"))).toBe(true);
    r2.destroy();
  });

  it("destroy() disposes geometries and materials but no cached textures", () => {
    const fx = new Effect(loadDoc("fireball"), { seed: 1 });
    const r = new ThreeParticleRenderer(fx);
    const geo = meshOf(r).geometry;
    let disposed = 0;
    geo.addEventListener("dispose", () => disposed++);
    r.destroy();
    expect(disposed).toBe(1);
    // Built-in cache must still hand out a live texture afterwards.
    const r2 = new ThreeParticleRenderer(new Effect(loadDoc("fireball"), { seed: 1 }));
    expect((meshOf(r2).material as any).uniforms.uTexture.value.userData.particlrDisposed).not.toBe(true);
    r2.destroy();
  });
});
