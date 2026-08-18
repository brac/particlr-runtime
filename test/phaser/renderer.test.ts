// @vitest-environment jsdom
// PhaserParticleRenderer structure test against a fake scene: R4 surface,
// one layer GO per layer, world/local placement, E10 fallback warning,
// auto-step subscription and teardown. Real rendering is golden-lane
// territory.
//
// jsdom note: `src/phaser/renderer.ts` imports `phaser`, whose module-scope
// canvas-2D probe throws before `installPhaserCanvasStub()` runs. Static
// imports hoist, so the adapter module is pulled in with a dynamic
// `await import(...)` inside each test (see `_phaserEnv.ts`).
import { describe, it, expect, beforeAll, vi } from "vitest";
import { makeFakeScene, makeEffectDoc } from "./_fakes.js";
import { installPhaserCanvasStub } from "./_phaserEnv.js";
import { parseParticle, Effect } from "../../src/index.js";
import type { ParticleDoc } from "../../src/index.js";

beforeAll(() => {
  installPhaserCanvasStub();
  // jsdom has no createImageBitmap — stub it so the real `decodeUserTexture`
  // path (used by the synchronous-cache-hit test below) can run.
  if (typeof globalThis.createImageBitmap !== "function") {
    vi.stubGlobal("createImageBitmap", async (_blob: Blob, _options?: ImageBitmapOptions) => ({
      width: 1,
      height: 1,
      close() {},
    }));
  }
});

async function loadRenderer() {
  return (await import("../../src/phaser/renderer.js")).PhaserParticleRenderer;
}

function effectFrom(doc: ParticleDoc): Effect {
  const parsed = parseParticle(JSON.stringify(doc));
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
  return new Effect(parsed.doc!, { seed: 1337 });
}

describe("PhaserParticleRenderer", () => {
  it("exposes the R4 surface with one layer child per layer", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const fx = effectFrom(makeEffectDoc(2));
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });

    expect(view.gameObject.list ?? view.gameObject.getAll()).toHaveLength(2);
    expect(view.warnings).toEqual([]);
    await view.ready;
    view.sync(); // must not throw with zero live particles
    view.destroy();
  });

  it("places world layers at the origin and local layers at the emitter", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const doc = makeEffectDoc(2);
    doc.layers[0]!.space = "world";
    doc.layers[1]!.space = "local";
    const fx = effectFrom(doc);
    fx.teleportEmitter(120, -40);
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });
    view.sync();

    const [world, local] = view.gameObject.list as Array<{ x: number; y: number }>;
    expect([world!.x, world!.y]).toEqual([0, 0]);
    expect([local!.x, local!.y]).toEqual([120, -40]);
    view.destroy();
  });

  it("warns and falls back on unknown texture (E10)", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const doc = makeEffectDoc(1);
    doc.layers[0]!.texture.ref = "user:missing";
    const fx = effectFrom(doc);
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });

    expect(view.warnings.some((w) => w.includes("missing"))).toBe(true);
    view.destroy();
  });

  it("auto-step subscribes to scene UPDATE and unsubscribes on destroy", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const fx = effectFrom(makeEffectDoc(1));
    const view = new PhaserParticleRenderer(fx, { scene: scene as never }); // autoStep default true

    expect(scene.events.listenerCount("update")).toBe(1);
    scene.events.emit("update", 0, 16.6667); // delta in ms
    expect(fx.time).toBeGreaterThan(0);
    view.destroy();
    expect(scene.events.listenerCount("update")).toBe(0);
  });

  it("submits one batch per live particle through the scene's quad handler", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const Phaser = (await import("phaser")).default;
    const scene = await makeFakeScene();
    const fx = effectFrom(makeEffectDoc(1));
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });
    for (let i = 0; i < 10; i++) fx.step(1 / 60);
    view.sync();

    // Drive the REAL invocation path: Phaser calls the registered render step
    // UNBOUND (`fn(renderer, gameObject, ...)`), so `this` is undefined inside
    // renderWebGL and every access must go through the `src` argument.
    const go = (view.gameObject.list as Array<{ renderWebGLStep: (...a: never[]) => void }>)[0]!;
    const added: unknown[] = [];
    const drawingContext = {
      camera: {
        addToRenderList: (o: unknown) => added.push(o),
        matrixExternal: new Phaser.GameObjects.Components.TransformMatrix(),
        matrix: new Phaser.GameObjects.Components.TransformMatrix(),
        matrixCombined: new Phaser.GameObjects.Components.TransformMatrix(),
        scrollX: 0,
        scrollY: 0,
        id: 1,
      },
    };
    go.renderWebGLStep(null as never, go as never, drawingContext as never, null as never);

    expect(added).toHaveLength(1);
    expect(fx.layers[0]!.count).toBeGreaterThan(0);
    expect(scene.quadHandler.calls).toHaveLength(fx.layers[0]!.count);
    view.destroy();
  });

  it("installs the component mixins as real accessors, not descriptor literals", async () => {
    // Phaser components declare `alpha`, `scaleX`, `blendMode` etc. as
    // `{ get, set }` LITERALS that Phaser.Class turns into accessors via
    // defineProperty. A plain Object.assign would copy the descriptor object
    // itself as the property value — `go.alpha` would then be an object, and
    // Container's renderWebGL (`child.setAlpha(child.alpha * container.alpha)`)
    // would produce NaN.
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const fx = effectFrom(makeEffectDoc(1));
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });

    const go = (view.gameObject.list as Array<Record<string, unknown>>)[0]!;
    expect(typeof go.alpha).toBe("number");
    expect(go.alpha).toBe(1);
    expect(typeof go.scaleX).toBe("number");
    expect(typeof go.visible).toBe("boolean");
    expect(typeof go.blendMode).toBe("number");
    (go as unknown as { setAlpha(v: number): void }).setAlpha(0.5);
    expect(go.alpha).toBeCloseTo(0.5);
    view.destroy();
  });

  it("resolves an already-decoded user texture synchronously on a second renderer (no placeholder flash)", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    const doc = makeEffectDoc(1);
    doc.textures = {
      sheet:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    };
    doc.layers[0]!.texture = { ref: "user:sheet", frames: null };
    const fx1 = effectFrom(doc);
    const first = new PhaserParticleRenderer(fx1, { scene: scene as never, autoStep: false });
    await first.ready; // real decodeUserTexture registers the texture on `scene.sys.textures`
    first.destroy();

    const loadTexture = vi.fn(async () => {
      throw new Error("must not be called — the second renderer should hit the sync cache");
    });
    const fx2 = effectFrom(doc);
    const second = new PhaserParticleRenderer(fx2, { scene: scene as never, autoStep: false, loadTexture });

    // Resolved synchronously, before any microtask — no placeholder pending.
    expect(loadTexture).not.toHaveBeenCalled();
    const go = (second.gameObject.list as Array<{ view: { texture: { key: string } } }>)[0]!;
    expect(go.view.texture.key.startsWith("particlr:user:")).toBe(true);
    expect(go.view.texture.key).not.toBe("particlr:builtin:circle-soft");
    second.destroy();
  });

  it("warns and stays inert when the scene is not on the WebGL renderer", async () => {
    const PhaserParticleRenderer = await loadRenderer();
    const scene = await makeFakeScene();
    (scene.sys as { renderer: unknown }).renderer = { type: 1 }; // Canvas renderer double
    const fx = effectFrom(makeEffectDoc(1));
    const view = new PhaserParticleRenderer(fx, { scene: scene as never, autoStep: false });

    expect(view.warnings.some((w) => w.includes("WebGL"))).toBe(true);
    view.sync(); // still must not throw
    view.destroy();
  });
});
