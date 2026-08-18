// @vitest-environment jsdom
// Dissolve handler registration: unique node names, role override on the layer
// GO, and the shader addition named/shaped so Phaser's shader cache keys it
// correctly. Visual correctness is golden-lane + blend-smoke territory — a real
// `ParticlrDissolveBatch` cannot be constructed here (its base class wants a
// live WebGL context), so this file covers the wiring and the pure pieces:
// the addition config, the GLSL port, and the one-time uniform record.
//
// jsdom note: `src/phaser/dissolveBatch.ts` imports `phaser`, so every import
// of it is dynamic (see `_phaserEnv.ts`).
import { describe, it, expect, beforeAll } from "vitest";
import { installPhaserCanvasStub } from "./_phaserEnv.js";
import { makeFakeScene, makeEffectDoc } from "./_fakes.js";
import { parseParticle, Effect } from "../../src/index.js";
import type { ParticleDoc } from "../../src/index.js";
import type { DissolveConfig } from "../../src/format/types.js";
import { dissolveFragmentGl } from "../../src/three/dissolveMaterial.js";

beforeAll(() => {
  installPhaserCanvasStub();
});

const DISSOLVE: DissolveConfig = {
  frequency: 4,
  scroll: { x: 0.1, y: -0.05 },
  edgeWidth: 0.15,
  edgeColor: { r: 1, g: 0.5, b: 0.1, a: 1 },
};

async function loadRenderer() {
  return (await import("../../src/phaser/renderer.js")).PhaserParticleRenderer;
}

async function loadDissolve() {
  return await import("../../src/phaser/dissolveBatch.js");
}

function effectFrom(doc: ParticleDoc): Effect {
  const parsed = parseParticle(JSON.stringify(doc));
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
  return new Effect(parsed.doc!, { seed: 1337 });
}

describe("dissolve", () => {
  it("registers one uniquely named handler per dissolve layer and assigns the role", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const doc = makeEffectDoc(2);
    doc.layers[0]!.dissolve = DISSOLVE;
    const fx = effectFrom(doc);
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });

    const gos = view.gameObject.list;
    // Dissolve layer: role overridden to the per-layer handler.
    expect(gos[0]!.customRenderNodes?.BatchHandler).toBeDefined();
    // Plain layer: untouched, still on Phaser's stock BatchHandlerQuad.
    expect(gos[1]!.customRenderNodes?.BatchHandler).toBeUndefined();

    // Exactly one node registered, named for the layer it serves.
    expect(scene.registeredNodes).toEqual(["particlr-dissolve-0"]);
    expect((gos[0]!.customRenderNodes as { BatchHandler: { name: string } }).BatchHandler.name).toBe(
      "particlr-dissolve-0",
    );
  });

  it("gives every dissolve layer its own node, and skips layers without dissolve", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const doc = makeEffectDoc(3);
    doc.layers[0]!.dissolve = DISSOLVE;
    doc.layers[2]!.dissolve = { ...DISSOLVE, edgeColor: null };
    new PhaserParticleRenderer(effectFrom(doc), { scene: scene as never, autoStep: false });

    expect(scene.registeredNodes).toHaveLength(2);
    expect(new Set(scene.registeredNodes).size).toBe(2);
    for (const name of scene.registeredNodes) expect(name).toMatch(/^particlr-dissolve-\d+$/);
  });

  it("keeps names unique across renderers sharing one scene (addNode* throws on duplicates)", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const doc = makeEffectDoc(1);
    doc.layers[0]!.dissolve = DISSOLVE;
    new PhaserParticleRenderer(effectFrom(doc), { scene: scene as never, autoStep: false });
    new PhaserParticleRenderer(effectFrom(doc), { scene: scene as never, autoStep: false });

    expect(scene.registeredNodes).toHaveLength(2);
    expect(new Set(scene.registeredNodes).size).toBe(2);
  });

  it("registers nothing for a document with no dissolve layer", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    new PhaserParticleRenderer(effectFrom(makeEffectDoc(2)), { scene: scene as never, autoStep: false });
    expect(scene.registeredNodes).toEqual([]);
  });

  it("builds a shader addition Phaser can key: stable name, header uniforms, fragmentProcess", async () => {
    const { makeDissolveAddition, DISSOLVE_ADDITION_NAME } = await loadDissolve();
    const a = makeDissolveAddition();

    expect(a.name).toBe(DISSOLVE_ADDITION_NAME);
    expect(a.tags).toContain("PARTICLR_DISSOLVE");

    const add = a.additions as { fragmentHeader: string; fragmentProcess: string };
    for (const u of [
      "uniform sampler2D uParticlrNoise;",
      "uniform float uParticlrTime;",
      "uniform float uParticlrFrequency;",
      "uniform vec2 uParticlrScroll;",
      "uniform float uParticlrEdgeWidth;",
      "uniform vec4 uParticlrEdgeColor;",
    ]) {
      expect(add.fragmentHeader, `header must declare ${u}`).toContain(u);
    }
    // The process runs inside main(), after MakeApplyTint, and must overwrite
    // `fragColor` rather than redeclare it (the Multi shader writes it out).
    expect(add.fragmentProcess).toContain("fragColor = vec4(");
    expect(add.fragmentProcess).not.toContain("vec4 fragColor");
    // Each addition is a fresh object — Phaser shallow-copies configs per node.
    expect(makeDissolveAddition()).not.toBe(a);
  });

  it("ports the three adapter's erosion math verbatim (same visual algorithm)", async () => {
    const { makeDissolveAddition } = await loadDissolve();
    const process = (makeDissolveAddition().additions as { fragmentProcess: string }).fragmentProcess;

    // The four load-bearing lines of src/three/dissolveMaterial.ts, with this
    // adapter's uniform names substituted. If either side drifts, this fails.
    const ported = [
      "max(uParticlrEdgeWidth, 1e-4)",
      "(1.0 - prtA) * (1.0 + uParticlrEdgeWidth) - uParticlrEdgeWidth",
      "smoothstep(prtT, prtT + prtEw, prtN)",
      "uParticlrEdgeColor.rgb * uParticlrEdgeColor.a * (prtD * (1.0 - prtD) * 4.0)",
    ];
    for (const line of ported) expect(process, `missing ported expression: ${line}`).toContain(line);

    // Sanity-check the source those lines were ported from still says the same.
    expect(dissolveFragmentGl).toContain("max(uEdgeWidth, 1e-4)");
    expect(dissolveFragmentGl).toContain("(1.0 - a) * (1.0 + uEdgeWidth) - uEdgeWidth");
    expect(dissolveFragmentGl).toContain("smoothstep(t, t + ew, n)");
    expect(dissolveFragmentGl).toContain("uEdgeColor.rgb * uEdgeColor.a * (d * (1.0 - d) * 4.0)");
  });

  it("maps the dissolve config onto the one-time uniform record", async () => {
    const { dissolveUniformValues } = await loadDissolve();

    expect(dissolveUniformValues(DISSOLVE, 7)).toEqual({
      uParticlrNoise: 7,
      uParticlrFrequency: 4,
      uParticlrScroll: [0.1, -0.05],
      uParticlrEdgeWidth: 0.15,
      uParticlrEdgeColor: [1, 0.5, 0.1, 1],
    });

    // edgeColor null is the branchless no-op (pixi/three convention).
    expect(dissolveUniformValues({ ...DISSOLVE, edgeColor: null }, 3).uParticlrEdgeColor).toEqual([0, 0, 0, 0]);
  });
});
