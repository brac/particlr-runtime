// Phaser texture layer. Built-ins upload raw RGBA via addUint8Array (texgen
// output is deliberately canvas-free and bit-identical across GPUs). User
// textures decode via decodeBase64 + createImageBitmap + canvas + addCanvas —
// never fetch (zero network capability), and Phaser has no official
// ImageBitmap ingestion path so the canvas hop is the sanctioned route. The
// decode itself is a local copy of the pixi/pixi7 adapters' dataUrlToBlob
// pattern (not an import from either — those modules pull in their
// respective rendering libraries, which the phaser adapter must not depend
// on) built from the shared format/base64.js primitives.
// Keys are namespaced "particlr:*"; caches are per-TextureManager (one Phaser
// Game = one manager), page-lifetime, never evicted (refcounting is v1.5, same
// stance as every adapter).
import type { BuiltinTextureId } from "../format/types.js";
import { decodeBase64, IMAGE_DATA_URL_RE } from "../format/base64.js";
import { generateBuiltinTexture, generateDissolveNoise } from "../texgen/index.js";

export interface PhaserTextureLike {
  key: string;
}

export interface PhaserTextureManagerLike {
  exists(key: string): boolean;
  get(key: string): PhaserTextureLike;
  addUint8Array(key: string, data: Uint8Array, width: number, height: number): PhaserTextureLike | null;
  addCanvas(key: string, source: HTMLCanvasElement): PhaserTextureLike | null;
}

export function builtinKey(id: BuiltinTextureId): string {
  return `particlr:builtin:${id}`;
}

export function ensureBuiltinTexture(tm: PhaserTextureManagerLike, id: BuiltinTextureId): PhaserTextureLike {
  const key = builtinKey(id);
  if (tm.exists(key)) return tm.get(key);
  const data = generateBuiltinTexture(id);
  return tm.addUint8Array(key, data.pixels, data.width, data.height) ?? tm.get(key);
}

const NOISE_KEY = "particlr:dissolve-noise";

export function ensureDissolveNoiseTexture(tm: PhaserTextureManagerLike): PhaserTextureLike {
  if (tm.exists(NOISE_KEY)) return tm.get(NOISE_KEY);
  const data = generateDissolveNoise();
  return tm.addUint8Array(NOISE_KEY, data.pixels, data.width, data.height) ?? tm.get(NOISE_KEY);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Parse an embedded texture (`data:image/...;base64,` — the E44 shape) into a
 * typed Blob. Deliberately NOT `fetch(dataUrl)`: the runtime must carry zero
 * network capability. Throws on anything that is not a well-formed base64
 * image data URL. Local twin of the pixi/pixi7 adapters' `dataUrlToBlob`.
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const m = IMAGE_DATA_URL_RE.exec(dataUrl);
  const bytes = m ? decodeBase64(dataUrl.slice(m[0].length)) : null;
  if (!m || !bytes) throw new Error("texture is not a base64 image data URL");
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: m[1]!.toLowerCase() });
}

/**
 * The deterministic TextureManager key a decoded user data URL lands under.
 * Exported so callers can probe for an already-decoded texture without going
 * through the async decode path (`cachedUserTexture`).
 */
export function userTextureKey(dataUrl: string): string {
  return `particlr:user:${fnv1a(dataUrl)}`;
}

/**
 * Synchronous cache lookup for an already-decoded user texture. Unlike the
 * three/pixi adapters (which hold a module-scope `Map<dataUrl, Texture>`),
 * Phaser's TextureManager itself is the durable per-manager store — the
 * decoded texture lives under `userTextureKey(dataUrl)` for the manager's
 * lifetime, so a lookup is just `tm.exists`/`tm.get`. Lets a renderer's
 * `resolveTexture` resolve a `user:` ref immediately when another instance
 * already decoded the same data URL, instead of always showing the
 * placeholder for one microtask (pixi/three parity,
 * `src/pixi/renderer.ts:476-478`).
 *
 * Generic over the manager's `get` return type so a caller with a richer
 * `TextureManagerLike` (e.g. `src/phaser/renderer.ts`'s `get(key):
 * LayerTextureLike`) gets that richer type back, not the minimal
 * `PhaserTextureLike` — no cast needed at the call site.
 */
export function cachedUserTexture<T extends PhaserTextureLike>(
  tm: { exists(key: string): boolean; get(key: string): T },
  dataUrl: string,
): T | null {
  const key = userTextureKey(dataUrl);
  return tm.exists(key) ? tm.get(key) : null;
}

const userCaches = new WeakMap<PhaserTextureManagerLike, Map<string, Promise<PhaserTextureLike>>>();

export function decodeUserTexture(tm: PhaserTextureManagerLike, dataUrl: string): Promise<PhaserTextureLike> {
  let cache = userCaches.get(tm);
  if (cache === undefined) {
    cache = new Map();
    userCaches.set(tm, cache);
  }
  const hit = cache.get(dataUrl);
  if (hit !== undefined) return hit;

  const p = (async () => {
    // imageOrientation "none": bitmap keeps file row order (no EXIF
    // auto-rotate). premultiplyAlpha "none": avoids a double-premultiply
    // round-trip that fringes semi-transparent edges. Same options as
    // src/three/textures.ts's decodeDataUrlTexture.
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl), {
      imageOrientation: "none",
      premultiplyAlpha: "none",
    });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
    const key = userTextureKey(dataUrl);
    if (tm.exists(key)) return tm.get(key);
    return tm.addCanvas(key, canvas) ?? tm.get(key);
  })();
  cache.set(dataUrl, p);
  return p;
}
