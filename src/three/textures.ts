// Texture layer for the Three adapter. Same lifetime policy as the Pixi
// adapter (renderer.ts P0.1/P0.2): built-ins and the dissolve noise tile are
// pure-procedural, cached at module scope, and never destroyed by the adapter;
// user textures are cached by data URL with no eviction (page-lifetime; per-
// texture refcounting is v1.5). Three has no `destroyed` flag, so the caches
// self-heal via a dispose listener that marks our own userData flag.
//
// Upload convention (normative, tested): straight alpha, flipY = false — the
// fragment shader premultiplies, and UV row 0 = texture row 0 = the TOP of the
// authored image, matching Pixi and matching the vertex shader's top-left UV.
import {
  DataTexture,
  Texture,
  RGBAFormat,
  UnsignedByteType,
  LinearFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
} from "three";
import type { BuiltinTextureId } from "../format/types.js";
import { decodeBase64, IMAGE_DATA_URL_RE } from "../format/base64.js";
import {
  generateBuiltinTexture,
  generateDissolveNoise,
  type TextureData,
} from "../texgen/index.js";

function markDisposable(t: Texture): void {
  t.addEventListener("dispose", () => {
    t.userData.particlrDisposed = true;
  });
}
const live = (t: Texture | undefined): t is Texture =>
  !!t && t.userData.particlrDisposed !== true;

export function textureFromData(d: TextureData): DataTexture {
  const t = new DataTexture(
    d.pixels,
    d.width,
    d.height,
    RGBAFormat,
    UnsignedByteType
  );
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.needsUpdate = true;
  markDisposable(t);
  return t;
}

const BUILTIN_TEXTURES = new Map<BuiltinTextureId, DataTexture>();
export function builtinTexture(id: BuiltinTextureId): DataTexture {
  let t = BUILTIN_TEXTURES.get(id);
  if (!live(t)) {
    t = textureFromData(generateBuiltinTexture(id));
    BUILTIN_TEXTURES.set(id, t);
  }
  return t!;
}

let noise: DataTexture | null = null;
export function dissolveNoiseTexture(): DataTexture {
  if (!live(noise ?? undefined)) {
    noise = textureFromData(generateDissolveNoise());
    noise.wrapS = RepeatWrapping;
    noise.wrapT = RepeatWrapping;
    noise.needsUpdate = true;
  }
  return noise!;
}

/** Same contract and rationale as the Pixi adapter's dataUrlToBlob
 * (renderer.ts:75): no fetch, throws on anything that is not a base64 image
 * data URL. Duplicated (6 lines) rather than imported cross-adapter. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const m = IMAGE_DATA_URL_RE.exec(dataUrl);
  const bytes = m ? decodeBase64(dataUrl.slice(m[0].length)) : null;
  if (!m || !bytes) throw new Error("texture is not a base64 image data URL");
  return new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: m[1]!.toLowerCase(),
  });
}

const USER_TEXTURES = new Map<string, Texture>();

/**
 * Synchronous cache lookup for an already-decoded user texture, honoring the
 * live/disposed guard (same policy as `builtinTexture`/`decodeDataUrlTexture`).
 * Lets a renderer's `resolveTexture` resolve a `user:` ref immediately when
 * another instance already decoded the same data URL, instead of always
 * showing the placeholder for one microtask (Pixi adapter parity,
 * renderer.ts:476-478). Exported for adapter use and tests.
 */
export function cachedUserTexture(dataUrl: string): Texture | undefined {
  const t = USER_TEXTURES.get(dataUrl);
  return live(t) ? t : undefined;
}

/**
 * Populate the shared user-texture cache. Callers using the default
 * `decodeDataUrlTexture` loader get this for free (it caches internally);
 * this is for adapters that accept an injected/overridden loader (test
 * doubles, alternate decode strategies) so THEIR decoded textures are cached
 * too, matching Pixi's renderer-level cache (renderer.ts:497) rather than a
 * cache that only ever sees the default loader's output.
 */
export function cacheUserTexture(dataUrl: string, tex: Texture): void {
  // `markDisposable` must run for EVERY texture this cache hands out later via
  // `cachedUserTexture`'s `live()` guard — otherwise a texture from an
  // injected loader (the exact case this function exists for) never flips
  // `userData.particlrDisposed` on `.dispose()`, and `live()` hands it out
  // forever even after the caller disposed it. Calling `markDisposable` twice
  // on a texture that already has it (the default `decodeDataUrlTexture`
  // path) just registers a second listener that sets the same flag — harmless.
  markDisposable(tex);
  USER_TEXTURES.set(dataUrl, tex);
}

export async function decodeDataUrlTexture(dataUrl: string): Promise<Texture> {
  const cached = USER_TEXTURES.get(dataUrl);
  if (live(cached)) return cached;
  // imageOrientation "none": the bitmap keeps file row order, matching
  // flipY = false (top-left UV origin).
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl), {
    imageOrientation: "none",
    premultiplyAlpha: "none",
  });
  const tex = new Texture(bitmap);
  tex.flipY = false;
  tex.premultiplyAlpha = false;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  markDisposable(tex);
  USER_TEXTURES.set(dataUrl, tex);
  return tex;
}
