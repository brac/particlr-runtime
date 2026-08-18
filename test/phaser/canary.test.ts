// @vitest-environment jsdom
// Canary for the pinned Phaser minor: constructs/imports the exact surface the
// adapter uses so a version bump that moves any of it fails HERE with a named
// cause instead of as an opaque adapter breakage. Same discipline as the three
// and pixi canaries.
//
// jsdom note: `import Phaser from "phaser"` runs canvas-2D feature detection
// as a module-scope side effect, which jsdom cannot satisfy on its own. See
// `./_phaserEnv.ts` for why and for the install-then-dynamic-import pattern
// used below (copy it for every phaser-importing test file).
import { describe, it, expect, beforeAll } from "vitest";
import { installPhaserCanvasStub } from "./_phaserEnv";

beforeAll(() => installPhaserCanvasStub());

describe("phaser canary (pinned 4.2.x)", () => {
  it("exposes the exact surface the adapter uses", async () => {
    const Phaser = (await import("phaser")).default;

    // Blend modes the normative table maps to (Task 2).
    expect(Phaser.BlendModes.NORMAL).toBe(0);
    expect(Phaser.BlendModes.MULTIPLY).toBe(2);
    expect(Phaser.BlendModes.SCREEN).toBe(3);
    expect(Phaser.BlendModes.ERASE).toBe(17);

    // Render-node machinery (Tasks 5, 7, 8).
    expect(typeof Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad).toBe("function");
    expect(typeof Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad.prototype.batch).toBe("function");
    expect(typeof Phaser.Renderer.WebGL.RenderNodes.BatchHandlerStrip.prototype.batchStrip).toBe("function");

    // Tint packing (Task 5).
    const tint = Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha(0xffffff, 1);
    expect(tint >>> 0).toBe(tint); // packed uint

    // GameObject + components the layer GO builds on (Task 5).
    expect(typeof Phaser.GameObjects.GameObject).toBe("function");
    expect(typeof Phaser.GameObjects.Container).toBe("function");
    expect(typeof Phaser.GameObjects.Components.BlendMode).toBe("object");
    expect(typeof Phaser.GameObjects.GetCalcMatrix).toBe("function");

    // Loader + factory registration (Task 9).
    expect(typeof Phaser.Loader.FileTypesManager.register).toBe("function");
    expect(typeof Phaser.Loader.FileTypes.JSONFile).toBe("function");
    expect(typeof Phaser.GameObjects.GameObjectFactory.register).toBe("function");

    // Lifecycle events (Task 5).
    expect(Phaser.Scenes.Events.UPDATE).toBe("update");
    expect(Phaser.GameObjects.Events.DESTROY).toBe("destroy");

    // Texture APIs (Task 4).
    expect(typeof Phaser.Textures.TextureManager.prototype.addUint8Array).toBe("function");
    expect(typeof Phaser.Textures.TextureManager.prototype.addCanvas).toBe("function");
  });
});
