// @vitest-environment jsdom
// Texture layer unit test against a fake TextureManager: idempotent builtin
// registration, namespaced keys, per-manager user-decode cache. The real GL
// upload is golden-lane territory; here we verify the bookkeeping.
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  builtinKey,
  ensureBuiltinTexture,
  decodeUserTexture,
  type PhaserTextureManagerLike,
} from "../../src/phaser/textures.js";
import { installPhaserCanvasStub } from "./_phaserEnv.js";

function fakeTM(): PhaserTextureManagerLike & { added: string[] } {
  const keys = new Map<string, object>();
  const added: string[] = [];
  return {
    added,
    exists: (k: string) => keys.has(k),
    get: (k: string) => keys.get(k) as never,
    addUint8Array(k: string, _d: Uint8Array, _w: number, _h: number) {
      added.push(k);
      const t = { key: k };
      keys.set(k, t);
      return t as never;
    },
    addCanvas(k: string, _c: HTMLCanvasElement) {
      added.push(k);
      const t = { key: k };
      keys.set(k, t);
      return t as never;
    },
  };
}

beforeAll(() => {
  // jsdom implements HTMLCanvasElement but not a real 2D context — install
  // the shared hand-rolled test double (same one Task 2+ use for Phaser's
  // own module-scope canvas probing) so canvas.getContext("2d") works here.
  installPhaserCanvasStub();
  // jsdom has no createImageBitmap — stub it with a fake bitmap the
  // implementation only needs to draw to a canvas.
  if (typeof globalThis.createImageBitmap !== "function") {
    vi.stubGlobal("createImageBitmap", async () => ({
      width: 1,
      height: 1,
      close() {},
    }));
  }
});

describe("phaser texture layer", () => {
  it("namespaces builtin keys", () => {
    expect(builtinKey("circle-soft")).toBe("particlr:builtin:circle-soft");
  });

  it("adds a builtin once and reuses it", () => {
    const tm = fakeTM();
    const a = ensureBuiltinTexture(tm, "circle-soft");
    const b = ensureBuiltinTexture(tm, "circle-soft");
    expect(a).toBe(b);
    expect(tm.added).toEqual(["particlr:builtin:circle-soft"]);
  });

  it("caches user decodes per manager + dataUrl", async () => {
    const tm = fakeTM();
    // 1x1 transparent PNG.
    const url =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const a = await decodeUserTexture(tm, url);
    const b = await decodeUserTexture(tm, url);
    expect(a).toBe(b);
    expect(tm.added).toHaveLength(1);
    expect(tm.added[0]!.startsWith("particlr:user:")).toBe(true);
  });
});
