// @vitest-environment jsdom
// After a pending user flipbook sheet decodes, the layer's FrameInfo must be
// recomputed from the real sheet dimensions (aspect = frameH/frameW).
import { describe, it, expect, beforeAll } from "vitest";
import { installPhaserCanvasStub } from "./_phaserEnv";
import { makeFakeScene, makeEffectDoc } from "./_fakes.js";
import { parseParticle, Effect } from "../../src/index.js";

beforeAll(() => installPhaserCanvasStub());

describe("flipbook", () => {
  it("recomputes FrameInfo after the async sheet swap", async () => {
    const { PhaserParticleRenderer, ParticlrLayer } = await import("../../src/phaser/renderer.js");
    const scene = await makeFakeScene();
    const doc = makeEffectDoc(1);
    doc.textures = { sheet: "data:image/png;base64,AAAA" };
    doc.layers[0].texture = {
      ref: "user:sheet",
      frames: { cols: 4, rows: 2, fps: 12, mode: "loop", randomStartFrame: false, frameOverLife: null },
    };
    const parsed = parseParticle(JSON.stringify(doc));
    if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
    const fx = new Effect(parsed.doc!, { seed: 1337 });
    // Inject a loader resolving to a fake 128x32 texture already in the TM.
    const view = new PhaserParticleRenderer(fx, {
      scene: scene as never,
      autoStep: false,
      loadTexture: async () => scene.addFakeTexture("particlr:user:test", 128, 32),
    });
    await view.ready;
    const layerGo = (view.gameObject.list ?? view.gameObject.getAll()) as InstanceType<typeof ParticlrLayer>[];
    const go = layerGo[0]!;
    // frameW = 128/4 = 32, frameH = 32/2 = 16 => aspect 0.5
    expect(go.view.frame).toMatchObject({ cols: 4, rows: 2 });
    expect(go.view.frame.aspect).toBeCloseTo(0.5);
  });
});
