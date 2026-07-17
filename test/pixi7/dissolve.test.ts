// Pixi v7 dissolve fork tests — the v7 analog of test/pixi/dissolve.test.ts. Runs
// in the vitest `pixi7` project (node env, `pixi.js` aliased to node_modules/pixi7
// = 7.4.3). Everything here is headless: the shader canary reads SOURCE STRINGS (no
// GL), and the config/time plumbing exercises the DissolveParticleContainer subclass
// which — unlike the plugin — constructs in pure node (it builds no Shader). The
// live-GL proof of the erosion is the M4 dissolve golden preset on SwiftShader.
//
// Canary philosophy (§0.5): the fork tracks v7.4.3's own particles.{vert,frag}. We
// pin our forked vertex byte-for-byte against the INSTALLED stock source and assert
// the fragment is stock's varyings/uniforms with the documented color-line
// replacement, so a pixi patch that changes the attribute layout trips loudly here
// BEFORE the golden lane.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionType, ParticleContainer, extensions } from "pixi.js";
import {
  DISSOLVE_PLUGIN_NAME,
  DissolveParticleContainer,
  dissolveVertexGl,
  dissolveFragmentGl,
  registerDissolvePlugin,
} from "../../src/pixi7/dissolveRenderer.js";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { PixiParticleRenderer } from "../../src/pixi7/renderer.js";
import type { DissolveConfig } from "../../src/format/types.js";
import { presetsDir, hasPresets } from "../_presets.js";

const here = dirname(fileURLToPath(import.meta.url));

// Walk up from here to the first ancestor containing node_modules/pixi7, so the
// stock-source and package.json reads below work at BOTH the monorepo depth
// (alias hoisted to the workspace root) and the subtree-split mirror depth (this
// package is the repo root with its own node_modules). Replaces a hard-coded
// monorepo-only "../../../.." that broke the mirror's CI.
function packageInstallRoot(from: string): string {
  let dir = from;
  while (!existsSync(resolve(dir, "node_modules/pixi7"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("node_modules/pixi7 not found above " + from);
    dir = up;
  }
  return dir;
}

const root = packageInstallRoot(here);
const pcPkgDir = resolve(root, "node_modules/@pixi/particle-container");

function loadDoc(name: string) {
  const raw = readFileSync(resolve(presetsDir, `${name}.prt`), "utf8");
  const parsed = parseParticle(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} invalid: ${JSON.stringify(parsed.errors)}`);
  return structuredClone(parsed.doc!);
}

// Extract the single template-literal shader string out of a compiled
// `@pixi/particle-container/lib/particles.{vert,frag}.mjs` (`var x = \`...\`;`).
function stockShaderSource(file: "particles.vert" | "particles.frag"): string {
  const txt = readFileSync(resolve(pcPkgDir, `lib/${file}.mjs`), "utf8");
  const m = txt.match(/`([\s\S]*)`/);
  if (!m) throw new Error(`could not extract shader source from ${file}.mjs`);
  return m[1]!;
}

const DISSOLVE: DissolveConfig = {
  frequency: 4,
  scroll: { x: 0.05, y: 0.1 },
  edgeWidth: 0.2,
  edgeColor: { r: 1, g: 0.45, b: 0.15, a: 0.6 },
};
const pcOf = (r: PixiParticleRenderer, i = 0) => r.container.children[i] as ParticleContainer;
interface ViewProbe {
  dissolve: DissolveParticleContainer | null;
}
const viewOf = (r: PixiParticleRenderer, i = 0): ViewProbe =>
  (r as unknown as { views: ViewProbe[] }).views[i]!;

// --- Shader canary (§0.5, the load-bearing test) ---------------------------
describe("dissolve shader canary (§0.5)", () => {
  it("forks v7.4.3's particles.vert VERBATIM (byte-identical to the installed stock)", () => {
    // A pixi patch that renames an attribute (aVertexPosition/aTextureCoord/aColor/
    // aPositionCoord/aRotation) or a uniform (translationMatrix/uColor) fails HERE.
    expect(dissolveVertexGl).toBe(stockShaderSource("particles.vert"));
  });

  it("keeps the stock fragment's varying/uniform declarations", () => {
    // These are the names the v7 particle pipe binds each frame (uSampler ← the
    // layer texture) and the vertex passes through (vTextureCoord/vColor). The fork
    // MUST keep them for texture swaps + tint to follow.
    for (const decl of ["varying vec2 vTextureCoord;", "varying vec4 vColor;", "uniform sampler2D uSampler;"]) {
      expect(dissolveFragmentGl.includes(decl), `fragment must keep "${decl}"`).toBe(true);
    }
  });

  it("replaces the stock color line with the dissolve erosion (documented fork point)", () => {
    // Stock frag body is `vec4 color = texture2D(uSampler, vTextureCoord) * vColor;`
    // — the fork must NOT contain that stock multiply-and-emit line.
    expect(dissolveFragmentGl.includes("texture2D(uSampler, vTextureCoord) * vColor")).toBe(false);
    // The erosion math (identical to the v8 GLSL fork) is present.
    expect(dissolveFragmentGl.includes("smoothstep(t, t + ew, n)")).toBe(true);
    expect(dissolveFragmentGl.includes("(1.0 - a) * (1.0 + uEdgeWidth) - uEdgeWidth")).toBe(true);
  });

  it("adds the six dissolve uniforms", () => {
    for (const u of ["uDissolveNoise", "uTime", "uFrequency", "uScroll", "uEdgeWidth", "uEdgeColor"]) {
      expect(dissolveFragmentGl.includes(u), `fragment must declare ${u}`).toBe(true);
    }
  });

  it("pins the forked-from packages at 7.4.3 (alias + @pixi/particle-container)", () => {
    const alias = JSON.parse(readFileSync(resolve(root, "node_modules/pixi7/package.json"), "utf8"));
    expect(alias.version).toBe("7.4.3");
    // The fork tracks THIS package's shader source; a version bump must re-verify
    // the canary above (the vert byte-match would break on any shader change).
    const pc = JSON.parse(readFileSync(resolve(pcPkgDir, "package.json"), "utf8"));
    expect(pc.version).toBe("7.4.3");
  });
});

// --- Plugin registration (idempotent) --------------------------------------
describe("dissolve plugin registration", () => {
  it("imports in pure node without constructing a Shader (module-scope is safe)", () => {
    // If importing dissolveRenderer.ts compiled a shader at module scope it would
    // throw `document is not defined` in node — the fact this file loaded proves it
    // does not. The plugin name is the routing contract.
    expect(DISSOLVE_PLUGIN_NAME).toBe("particlrDissolve");
  });

  it("re-registration is a hard no-op (module-scope guard)", () => {
    // ESM caches the module so the body runs once, but the boolean guard makes an
    // explicit re-call idempotent regardless.
    expect(() => {
      registerDissolvePlugin();
      registerDissolvePlugin();
    }).not.toThrow();
  });

  it("v7 extensions.add does not throw on a duplicate plugin name (verified finding)", () => {
    // handleByMap does `map[name] = ref` (overwrite) and the pre-renderer queue just
    // re-pushes — neither throws. No Renderer exists in node, so this only queues a
    // throwaway ref (never instantiated). Documents WHY the guard is belt-and-braces,
    // not a throw-avoidance necessity.
    expect(() =>
      extensions.add({ name: DISSOLVE_PLUGIN_NAME, type: ExtensionType.RendererPlugin, ref: class {} }),
    ).not.toThrow();
  });
});

// --- Renderer wiring (headless: subclass constructs with no Shader) ---------
describe.skipIf(!hasPresets)("PixiParticleRenderer (v7) — dissolve wiring (M3)", () => {
  it("constructs a dissolve layer as a DissolveParticleContainer carrying the config", () => {
    const doc = loadDoc("smoke");
    doc.layers[0]!.dissolve = DISSOLVE;
    const r = new PixiParticleRenderer(new Effect(doc, { seed: doc.seed }));
    const pc = pcOf(r);
    expect(pc).toBeInstanceOf(DissolveParticleContainer);
    expect((pc as DissolveParticleContainer).dissolveConfig).toEqual(DISSOLVE);
    expect(viewOf(r).dissolve).toBe(pc); // the view tracks the same object as the subtype
    r.destroy();
  });

  it("leaves non-dissolve layers as a plain ParticleContainer (byte-identical path)", () => {
    // A rain doc has no dissolve: every container is the stock ParticleContainer,
    // NOT the subclass, so a dissolve-free document is constructed exactly as before.
    const r = new PixiParticleRenderer(new Effect(loadDoc("rain"), { seed: 1 }));
    for (const child of r.container.children) {
      expect(child).toBeInstanceOf(ParticleContainer);
      expect(child).not.toBeInstanceOf(DissolveParticleContainer);
    }
    for (const v of (r as unknown as { views: ViewProbe[] }).views) expect(v.dissolve).toBeNull();
    r.destroy();
  });

  it("sync() advances the container's erosion clock to effect.time each frame", () => {
    const doc = loadDoc("smoke");
    doc.layers[0]!.dissolve = DISSOLVE;
    const fx = new Effect(doc, { seed: doc.seed });
    const r = new PixiParticleRenderer(fx);
    const pc = pcOf(r) as DissolveParticleContainer;
    expect(pc.time).toBe(0);
    for (let i = 0; i < 12; i++) fx.step(1 / 60);
    r.sync();
    expect(pc.time).toBeCloseTo(fx.time, 10);
    expect(fx.time).toBeGreaterThan(0);
    r.destroy();
  });
});
