// @vitest-environment jsdom
// Plugin registration: idempotent, registers the file type and factory on
// Phaser's static registries. Full load->add round-trip is the sample +
// golden lane's job (see plugin.ts's header comment).
import { describe, it, expect, beforeAll } from "vitest";
import { installPhaserCanvasStub } from "./_phaserEnv.js";
import { makeFakeScene, makeEffectDoc } from "./_fakes.js";
import { parseParticle } from "../../src/index.js";

beforeAll(() => installPhaserCanvasStub());

describe("registerParticlr", () => {
  it("registers loader file type and add factory, idempotently", async () => {
    const Phaser = (await import("phaser")).default;
    const { registerParticlr } = await import("../../src/phaser/plugin.js");

    registerParticlr();
    registerParticlr(); // second call must not throw or double-register

    // GameObjectFactory.register installs onto the shared prototype.
    const factoryProto = Phaser.GameObjects.GameObjectFactory.prototype as Record<string, unknown>;
    expect(typeof factoryProto.particlr).toBe("function");

    // FileTypesManager keeps a static `types` registry that `install(loader)`
    // copies onto every LoaderPlugin instance at construction time — assert
    // through that real install path rather than reaching into the private
    // registry.
    const installed: Record<string, unknown> = {};
    Phaser.Loader.FileTypesManager.install(installed as unknown as Phaser.Loader.LoaderPlugin);
    expect(typeof installed.particlr).toBe("function");
    // Explicit generous timeout: this is the first test to `await import("phaser")`,
    // which pays the whole library's module-init cost (it touches the jsdom canvas
    // stub, builds the render-node registries, etc.). Measured ~4.0s standalone,
    // against vitest's 5s default, close enough to flake on a loaded CI box, and
    // the flake would look like a particlr bug rather than a cold import.
  }, 20_000);

  it("the add factory throws a helpful error for an unloaded/misspelled key, not a bare TypeError", async () => {
    const Phaser = (await import("phaser")).default;
    const { registerParticlr } = await import("../../src/phaser/plugin.js");

    registerParticlr();

    const particlr = (Phaser.GameObjects.GameObjectFactory.prototype as Record<string, unknown>)
      .particlr as (this: unknown, key: string, x: number, y: number) => unknown;

    // A minimal `this` — the guard fires before anything else in the factory
    // touches `this`, so nothing beyond `scene.cache.json.get` is needed.
    const fakeThis = { scene: { cache: { json: { get: () => undefined } } } };

    expect(() => particlr.call(fakeThis, "typo-key", 0, 0)).toThrowError(
      /no loaded document for key "typo-key".*this\.load\.particlr\("typo-key", url\)/s,
    );
  });

  it("tears the renderer down when the GameObject it returned is destroyed", async () => {
    // The sugar route never hands the host a renderer, so the GameObject's
    // lifetime has to be the teardown trigger: `container.destroy()` — or a
    // scene shutdown destroying the display list — must release the per-frame
    // UPDATE listener. Same probe as renderer.test.ts's auto-step test.
    const Phaser = (await import("phaser")).default;
    const { registerParticlr } = await import("../../src/phaser/plugin.js");
    registerParticlr();

    const scene = await makeFakeScene();
    const parsed = parseParticle(JSON.stringify(makeEffectDoc(1)));
    expect(parsed.ok).toBe(true);
    const factoryThis = {
      scene: { ...scene, cache: { json: { get: () => parsed.doc } } },
      displayList: { add: <T,>(go: T): T => go },
    };

    const particlr = (Phaser.GameObjects.GameObjectFactory.prototype as Record<string, unknown>)
      .particlr as (this: unknown, key: string, x: number, y: number) => Phaser.GameObjects.Container;

    const go = particlr.call(factoryThis, "fx", 10, 20);
    // autoStep defaults on, so the renderer is holding a scene UPDATE listener.
    expect(scene.events.listenerCount("update")).toBe(1);

    go.destroy();
    expect(scene.events.listenerCount("update")).toBe(0);
    // The reentrancy the hook creates (destroy -> DESTROY -> view.destroy() ->
    // gameObject.destroy()) must not run Phaser's teardown twice, and a host
    // that also calls `view.destroy()` afterwards must still be a no-op.
    const view = (go as unknown as { particlr: { view: { destroy(): void } } }).particlr.view;
    expect(() => view.destroy()).not.toThrow();
    expect(scene.events.listenerCount("update")).toBe(0);
  });
});
