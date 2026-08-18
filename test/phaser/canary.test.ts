// @vitest-environment jsdom
// Canary for the pinned Phaser minor: constructs/imports the exact surface the
// adapter uses so a version bump that moves any of it fails HERE with a named
// cause instead of as an opaque adapter breakage. Same discipline as the three
// and pixi canaries.
//
// JSDOM ESCAPE HATCH (plan conventions §"Phaser-importing tests run under
// jsdom"): `import Phaser from "phaser"` itself throws under jsdom — Phaser's
// ESM bundle runs canvas 2D feature-detection (`checkInverseAlpha`, dist/
// phaser.esm.js) as a MODULE-SCOPE side effect during its own internal
// require graph, before any test code runs. jsdom implements
// HTMLCanvasElement but not a 2D rendering context (`getContext('2d')`
// returns null without the optional `canvas` npm package), so Phaser's
// unguarded `context.fillStyle = ...` throws `TypeError: Cannot set
// properties of null`. Per the plan, installing a canvas shim (the `canvas`
// npm package) is explicitly disallowed. The real surface checks below stay
// written and ready; they are skipped here and will run for real once the
// Phaser golden-lane render page (a later task, real browser via Playwright)
// exists to host them, per the escape hatch's prescribed substitution.
import { describe, it, expect } from "vitest";

describe("phaser canary (pinned 4.2.x)", () => {
  it.skip("exposes the exact surface the adapter uses (jsdom escape hatch — see file header; moves to golden-lane render page)", async () => {
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
