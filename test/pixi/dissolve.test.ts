import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { GpuProgram, ParticleContainer, UniformGroup } from "pixi.js";
import { dissolveVertexGl, dissolveFragmentGl, dissolveWgsl } from "../../src/pixi/dissolveShader.js";
import { generateDissolveNoise, dissolveNoiseValue } from "../../src/pixi/textures.js";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { PixiParticleRenderer } from "../../src/pixi/renderer.js";
import type { DissolveConfig } from "../../src/format/types.js";

function loadDoc(name: string) {
  const raw = readFileSync(resolve(__dirname, `../../../../presets/${name}.prt`), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${JSON.stringify(parsed.errors)}`);
  return structuredClone(parsed.doc!);
}

const DISSOLVE: DissolveConfig = { frequency: 4, scroll: { x: 0.05, y: 0.1 }, edgeWidth: 0.2, edgeColor: { r: 1, g: 0.45, b: 0.15, a: 0.6 } };
const pcOf = (r: PixiParticleRenderer, i = 0) => r.container.children[i] as ParticleContainer;
interface ViewProbe {
  dissolveUniforms: UniformGroup | null;
}
const viewOf = (r: PixiParticleRenderer, i = 0): ViewProbe => (r as unknown as { views: ViewProbe[] }).views[i]!;

// FNV-1a over the RGBA bytes (matches textures.test.ts).
function hash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// --- Shader canary (§0.5, the load-bearing test) ---------------------------
// Asserts the forked sources still carry the exact attribute + uniform names the
// v8 particle pipe binds, and that the WGSL reflects into the expected bind
// groups. If a pixi upgrade renames any of these the canary fails BEFORE the
// golden suite, which is the whole point of pinning + the canary.
//
// NOTE on GlProgram: the plan assumed `new GlProgram(...)` is pure headless. It
// is NOT in pixi 8.19 — the constructor's `ensurePrecision` preprocessor calls
// `getMaxFragmentPrecision()`, which probes a GL test context (throws
// "document is not defined" under node vitest). So the GL fork is validated here
// by the source-name assertions below (which catch a pixi rename) and, live, by
// the dissolve golden preset on SwiftShader. `GpuProgram` construction IS pure
// (WGSL struct/group reflection, no device) and is exercised directly.
describe("dissolve shader canary (§0.5)", () => {
  it("constructs a GpuProgram from the forked WGSL headlessly", () => {
    // GpuProgram construction is pure WGSL struct/group reflection (no device).
    const p = new GpuProgram({
      vertex: { source: dissolveWgsl, entryPoint: "mainVertex" },
      fragment: { source: dissolveWgsl, entryPoint: "mainFragment" },
      name: "canary",
    });
    expect(p).toBeTruthy();
    // The reflection found our three bind groups (0 = uniforms, 1 = texture,
    // 2 = dissolve). structsAndGroups is the parsed layout.
    expect(p.structsAndGroups).toBeTruthy();
  });

  it("the GL vertex source carries the pipe's attribute + uniform names", () => {
    for (const attr of ["aVertex", "aPosition", "aUV", "aColor", "aRotation"]) {
      expect(dissolveVertexGl.includes(attr), `vertex must declare ${attr}`).toBe(true);
    }
    for (const u of ["uTranslationMatrix", "uColor", "uRound", "uResolution"]) {
      expect(dissolveVertexGl.includes(u), `vertex must declare ${u}`).toBe(true);
    }
  });

  it("the GL fragment binds the layer texture as uTexture (pipe-authoritative)", () => {
    // The pipe overwrites shader.resources.uTexture from container.texture each
    // frame, so the fork MUST keep that exact uniform name for texture swaps to
    // follow (renderer.ts applyTexture).
    expect(dissolveFragmentGl.includes("uTexture")).toBe(true);
    expect(dissolveFragmentGl.includes("uDissolveNoise")).toBe(true);
  });

  it("the WGSL keeps @group(0)/@group(1) for the pipe and adds @group(2) for dissolve", () => {
    expect(dissolveWgsl.includes("@group(0) @binding(0) var<uniform> uniforms")).toBe(true);
    expect(dissolveWgsl.includes("@group(1) @binding(0) var uTexture")).toBe(true);
    expect(dissolveWgsl.includes("@group(2) @binding(0) var<uniform> dissolveUniforms")).toBe(true);
  });

  it("the installed pixi.js satisfies the runtime's pinned peer range", () => {
    const require = createRequire(import.meta.url);
    const runtimePkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
    const range: string = runtimePkg.peerDependencies["pixi.js"];
    expect(range).toBe(">=8.6.0 <9");
    // pixi.js does not expose ./package.json in its exports map, so resolve the
    // entry and read the package.json at the package-folder boundary.
    const entry = require.resolve("pixi.js").replace(/\\/g, "/");
    const pkgDir = entry.slice(0, entry.indexOf("pixi.js/") + "pixi.js/".length);
    const installed: string = JSON.parse(readFileSync(pkgDir + "package.json", "utf8")).version;
    const [maj, min, pat] = installed.split(".").map((s) => parseInt(s, 10));
    // range ">=8.6.0 <9": major 8, (minor > 6 || (minor === 6 && patch >= 0)).
    const satisfies = maj === 8 && (min! > 6 || (min === 6 && pat! >= 0));
    expect(satisfies, `installed pixi.js ${installed} must satisfy ${range}`).toBe(true);
  });
});

// --- Noise tile ------------------------------------------------------------
describe("dissolve noise tile (0.3c)", () => {
  it("is 128x128 RGBA, grayscale, opaque", () => {
    const t = generateDissolveNoise();
    expect(t.width).toBe(128);
    expect(t.height).toBe(128);
    expect(t.pixels.length).toBe(128 * 128 * 4);
    // Grayscale (r==g==b) and alpha 255 at a few sample pixels (< 128*128).
    for (const i of [0, 400, 8000, 16383].map((k) => k * 4)) {
      expect(t.pixels[i]).toBe(t.pixels[i + 1]);
      expect(t.pixels[i]).toBe(t.pixels[i + 2]);
      expect(t.pixels[i + 3]).toBe(255);
    }
  });

  it("is deterministic (identical bytes across calls)", () => {
    expect(hash(generateDissolveNoise().pixels)).toBe(hash(generateDissolveNoise().pixels));
  });

  it("pixel digest is stable (regression guard)", () => {
    expect(hash(generateDissolveNoise().pixels)).toMatchSnapshot();
  });

  it("tiles seamlessly: the value function is periodic with period 1 in both axes", () => {
    // The exact tileability check: generating at u and u+1 (one full period)
    // yields the identical value, so GL repeat sampling has no seam at the wrap.
    for (const v of [0, 0.13, 0.37, 0.5, 0.86]) {
      for (const u of [0, 0.2, 0.49, 0.71, 0.95]) {
        expect(dissolveNoiseValue(u, v)).toBeCloseTo(dissolveNoiseValue(u + 1, v), 12);
        expect(dissolveNoiseValue(u, v)).toBeCloseTo(dissolveNoiseValue(u, v + 1), 12);
      }
    }
  });

  it("value stays in [0,1)", () => {
    for (let k = 0; k < 500; k++) {
      const u = (k * 0.00713) % 1;
      const val = dissolveNoiseValue(u, (k * 0.0131) % 1);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

// --- Renderer wiring (headless mock pattern) -------------------------------
// In node vitest there is no GL context, so makeDissolveShader returns null and
// a dissolve layer falls back to the default-shader path. These assert the
// wiring is sound EITHER way (the golden preset proves the real GL shading).
describe("PixiParticleRenderer — dissolve wiring (M3)", () => {
  it("constructs a dissolve layer without throwing and the PC exists", () => {
    const doc = loadDoc("smoke");
    doc.layers[0]!.dissolve = DISSOLVE;
    const r = new PixiParticleRenderer(new Effect(doc, { seed: doc.seed }));
    expect(pcOf(r)).toBeInstanceOf(ParticleContainer);
    r.destroy();
  });

  it("leaves non-dissolve layers on the default shader path (no custom shader)", () => {
    // A rain doc has no dissolve on any layer: every PC's `shader` stays
    // undefined, so the shared-path options object is byte-identical to before.
    const r = new PixiParticleRenderer(new Effect(loadDoc("rain"), { seed: 1 }));
    for (const child of r.container.children) {
      expect((child as ParticleContainer).shader).toBeUndefined();
    }
    r.destroy();
  });

  it("sync() writes effect.time into the dissolve uniform group when the shader exists", () => {
    // Headless, makeDissolveShader returns null, so inject a real UniformGroup
    // (no GL needed) to exercise the sync() branch that drives the erosion clock.
    const doc = loadDoc("smoke");
    doc.layers[0]!.dissolve = DISSOLVE;
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    const group = new UniformGroup({ uTime: { value: 0, type: "f32" } });
    viewOf(r).dissolveUniforms = group;
    for (let i = 0; i < 12; i++) fx.step(1 / 60);
    r.sync();
    expect(group.uniforms.uTime).toBeCloseTo(fx.time, 10);
    expect(fx.time).toBeGreaterThan(0);
    r.destroy();
  });
});
