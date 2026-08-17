import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Mesh } from "three";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { ThreeParticleRenderer } from "../../src/three/renderer.js";
import { makeDissolveMaterial, dissolveFragmentGl } from "../../src/three/dissolveMaterial.js";
import { builtinTexture } from "../../src/three/textures.js";
import type { DissolveConfig } from "../../src/format/types.js";
import { presetsDir, hasPresets } from "../_presets.js";

describe("dissolve material", () => {
  it("carries the erosion uniforms from the config", () => {
    const cfg: DissolveConfig = { frequency: 3, scroll: { x: 0.1, y: -0.2 }, edgeWidth: 0.25, edgeColor: { r: 1, g: 0.5, b: 0, a: 1 } };
    const m = makeDissolveMaterial(builtinTexture("smoke"), "add", cfg);
    expect(m.uniforms.uFrequency!.value).toBe(3);
    expect(Array.from(m.uniforms.uScroll!.value)).toEqual([0.1, -0.2]);
    expect(m.uniforms.uEdgeWidth!.value).toBe(0.25);
    expect(m.uniforms.uTime!.value).toBe(0);
  });
  it("null edgeColor is the branchless zero vec4 no-op (Pixi convention)", () => {
    const cfg: DissolveConfig = { frequency: 1, scroll: { x: 0, y: 0 }, edgeWidth: 0, edgeColor: null };
    const m = makeDissolveMaterial(builtinTexture("smoke"), "add", cfg);
    expect(Array.from(m.uniforms.uEdgeColor!.value)).toEqual([0, 0, 0, 0]);
  });
  it("fragment implements the 0.3c erosion: endpoint-exact threshold + alpha = texA * d", () => {
    for (const s of ["smoothstep(t, t + ew, n)", "(1.0 - a) * (1.0 + uEdgeWidth) - uEdgeWidth", "texel.a * d"]) {
      expect(dissolveFragmentGl.replace(/\s+/g, " ")).toContain(s.replace(/\s+/g, " "));
    }
  });
});

describe.skipIf(!hasPresets)("dissolve in the renderer", () => {
  it("writes effect.time into uTime on every sync", () => {
    // Real dissolve preset: presets/dissolving-smoke.prt, layer "dissolving".
    const name = "dissolving-smoke";
    const parsed = parseParticle(readFileSync(resolve(presetsDir, `${name}.prt`), "utf8"));
    if (!parsed.ok) throw new Error("fixture invalid");
    const fx = new Effect(parsed.doc!, { seed: 1 });
    const r = new ThreeParticleRenderer(fx);
    const layer = fx.layers.findIndex((ls) => ls.layer.dissolve !== null);
    const mesh = r.root.children.find((c) => c.userData.particlrLayer === layer && !c.userData.particlrTrail) as Mesh;
    for (let f = 0; f < 10; f++) fx.step(1 / 60);
    r.sync();
    expect((mesh.material as any).uniforms.uTime.value).toBeCloseTo(fx.time, 6);
    r.destroy();
  });
});
