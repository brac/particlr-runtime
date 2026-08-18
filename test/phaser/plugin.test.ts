// @vitest-environment jsdom
// Plugin registration: idempotent, registers the file type and factory on
// Phaser's static registries. Full load->add round-trip is the sample +
// golden lane's job (see plugin.ts's header comment).
import { describe, it, expect, beforeAll } from "vitest";
import { installPhaserCanvasStub } from "./_phaserEnv.js";

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
});
