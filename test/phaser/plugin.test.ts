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
  });
});
