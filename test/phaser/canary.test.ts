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

    // Dissolve internals (Task 8) — the deepest reach into Phaser in this
    // adapter, so every hook it depends on is pinned here by name.
    const quadDefaults = Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad.prototype.defaultConfig;
    // The stock addition list our own addition is spliced into...
    expect(Array.isArray(quadDefaults.shaderAdditions)).toBe(true);
    // ...immediately before this entry, which is found BY TAG (its name moves
    // with the alpha strategy, which is exactly what tags are for).
    expect(
      quadDefaults.shaderAdditions!.some((a) => a.tags !== undefined && a.tags.includes("ALPHA_DISCARD")),
    ).toBe(true);
    // ...and after this one, whose tinted colour the erosion consumes.
    expect(quadDefaults.shaderAdditions!.some((a) => a.tags !== undefined && a.tags.includes("TINT"))).toBe(
      true,
    );
    // The two methods `ParticlrDissolveBatch` overrides: the per-flush uniform
    // hook, and the texture-count clamp that reserves the noise sampler's unit.
    expect(typeof Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad.prototype.setupUniforms).toBe("function");
    expect(typeof Phaser.Renderer.WebGL.RenderNodes.BatchHandlerQuad.prototype.updateTextureCount).toBe(
      "function",
    );
    // Registration surface. `RenderNodeManager` is NOT on the public namespace
    // (`renderNodes/index.js` exports the nodes, not the manager) — it is only
    // reachable as `game.renderer.renderNodes`, so its `addNodeConstructor`/
    // `hasNode`/`getNode` cannot be pinned from a class here; the adapter's
    // structural `RenderNodeManagerLike` plus `dissolve.test.ts` cover them.
    // Pin the half that IS reachable: the Game Object side of the contract,
    // which resolves a registered node name into `customRenderNodes[role]`.
    // Note there is deliberately no `removeNode` anywhere to pin — its absence
    // is why released node names are recycled instead of dropped.
    expect(
      typeof (Phaser.GameObjects.Components.RenderNodes as unknown as { setRenderNodeRole?: unknown })
        .setRenderNodeRole,
    ).toBe("function");
    // The sanctioned texture-unit binder, and its `(texture, unit, force,
    // forceActive)` arity — the adapter passes all four.
    const unitsProto = Phaser.Renderer.WebGL.Wrappers.WebGLTextureUnitsWrapper.prototype;
    expect(typeof unitsProto.bind).toBe("function");
    expect(unitsProto.bind.length).toBe(4);
    // LINEAR is 0 (`setTextureFilter` branches on `filter === 0`); the noise
    // tile is forced to it to match the pixi and three adapters.
    expect(Phaser.Textures.FilterMode.LINEAR).toBe(0);

    // Tint packing (Task 5).
    const tint = Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha(0xffffff, 1);
    expect(tint >>> 0).toBe(tint); // packed uint

    // GameObject + components the layer GO builds on (Task 5).
    expect(typeof Phaser.GameObjects.GameObject).toBe("function");
    expect(typeof Phaser.GameObjects.Container).toBe("function");
    expect(typeof Phaser.GameObjects.Components.BlendMode).toBe("object");
    expect(typeof Phaser.GameObjects.GetCalcMatrix).toBe("function");

    // `Phaser.Class.mixin` (Task 5): undocumented in phaser's bundled d.ts
    // (reached via a cast in renderer.ts) but the load-bearing mechanism that
    // installs the component accessors — `Alpha`/`BlendMode`/`Transform`/etc
    // — onto `ParticlrLayer`'s prototype as real `{ get, set }` properties
    // rather than descriptor-literal values. A future Phaser bump that renames
    // or drops it must fail HERE, not as a NaN deep inside a render frame.
    expect(typeof (Phaser as unknown as { Class?: { mixin?: unknown } }).Class?.mixin).toBe("function");

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
