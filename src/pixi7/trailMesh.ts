// Pixi v7 trail ribbon adapter — the v7 port of src/pixi/trailMesh.ts. One Mesh
// per trail layer, backed by a Geometry whose aVertexPosition/aTextureCoord/aColor
// buffers ARE the core TrailGeometry typed arrays (write-through: core fills them
// each frame, we bump each buffer's _updateID). See core/trailGeometry.ts for the
// geometry math. Not counted against the core size budget (pixi-only).
//
// v7 divergences from v8 (all researched in PIXI7_PLAN — do NOT re-derive):
//   - v8 reuses Pixi's OWN mesh shader bits (compileHighShaderGlProgram + colorBit)
//     so the global/local uniform bind groups match the v8 mesh pipe. v7 has no
//     such bit system: we hand-write the GLSL (Shader.from), replicating the stock
//     v7 mesh vertex idiom (projectionMatrix·translationMatrix mat3s, both
//     auto-plumbed by Mesh._renderDefault + the renderer) plus a per-vertex
//     `aColor` premultiplied exactly like v8's colorBit.
//   - Draw range: v8's mesh draws the index buffer's live length, so it re-points
//     the index buffer to a `[0, indexCount)` subarray. v7's Mesh._renderDefault
//     draws `mesh.size` indices from `mesh.start` explicitly, so v7 sets
//     `mesh.size = indexCount` / `mesh.start = 0`. We ALSO re-point the index
//     buffer subarray (mirroring v8): it uploads only the live indices (no
//     reallocation — a subarray shares the ArrayBuffer) and lets a headless unit
//     test assert the draw range via `indexBuffer.data.length`.
//   - worldAlpha: v8's mesh pipe binds a localUniform `uColor = worldAlpha·tint`,
//     so the ribbon fades with the effect's container alpha. v7's
//     Mesh._renderDefault sets `shader.alpha = worldAlpha` then calls
//     `shader.update?.()`; a raw Shader has neither an `alpha` handler nor an
//     `update`, so we attach an `update()` that funnels `shader.alpha` into a
//     `uAlpha` scalar uniform. The fragment multiplies the premultiplied result
//     by uAlpha — for a white-tint trail (we never set a mesh tint, and neither
//     does v8) that scalar equals v8's uColor=(w,w,w,w), so parity holds.
//   - Round-pixels: v8 appends roundPixelsBit, but it is a no-op at the default
//     settings.ROUND_PIXELS=false (the golden-lane setting), so v7 omits it.
//   - Texture matrix: v8 binds texture.textureMatrix.mapCoord. v7 plain Textures
//     have no mat3 textureMatrix, and a trail always samples the FULL layer
//     texture (mapCoord would be identity), so v7 samples with the raw UV.
import { Buffer, Geometry, Mesh, Shader, TYPES, type BLEND_MODES, type Texture } from "pixi.js";
import type { TrailGeometry } from "../core/trailGeometry.js";

// Standard v7 mesh vertex idiom: projectionMatrix (injected by the renderer) ×
// translationMatrix (worldTransform, set by Mesh._renderDefault) × the 2D vertex.
// Passes the UV and the straight-alpha per-vertex color through unchanged.
// Precision qualifiers are auto-prepended by v7's Program.setPrecision.
const TRAIL_VERT = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
attribute vec4 aColor;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;

varying vec2 vUV;
varying vec4 vColor;

void main(void)
{
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aTextureCoord;
    vColor = aColor;
}
`;

// Fragment: sample the (premultiplied, R5 UNPACK) texture, modulate by the
// premultiplied vertex color (rgb*a, a — exactly v8's colorBit), then scale by
// uAlpha (worldAlpha — v8 applies the same through its localUniform uColor).
const TRAIL_FRAG = `varying vec2 vUV;
varying vec4 vColor;

uniform sampler2D uSampler;
uniform float uAlpha;

void main(void)
{
    vec4 texColor = texture2D(uSampler, vUV);
    vec4 pmColor = vec4(vColor.rgb * vColor.a, vColor.a);
    gl_FragColor = texColor * pmColor * uAlpha;
}
`;

// The raw Shader augmented with the fields Mesh._renderDefault touches:
// `alpha` (set to worldAlpha before each render) and `update` (called right
// after). Neither exists on a stock core.Shader.
interface TrailShader extends Shader {
  alpha?: number;
  update?: () => void;
}

/** Build the trail shader bound to `texture`. It is a hand-written v7 mesh shader
 * (projection/translation mat3s + a premultiplied per-vertex color) whose `uAlpha`
 * uniform carries the mesh's worldAlpha each frame. May throw in a headless
 * (no-DOM) unit-test environment where v7 eagerly probes a GL context for the
 * fragment precision — callers fall back to a shaderless mesh there. */
function trailShader(texture: Texture): TrailShader {
  const shader = Shader.from(TRAIL_VERT, TRAIL_FRAG, { uSampler: texture, uAlpha: 1 }) as TrailShader;
  // Mesh._renderDefault does `shader.alpha = worldAlpha; shader.update && shader.update()`.
  // Funnel that worldAlpha into the uAlpha uniform (the group is dynamic, so the
  // change re-uploads). `alpha` is undefined until the first render, hence `?? 1`.
  shader.update = function () {
    shader.uniforms.uAlpha = shader.alpha ?? 1;
  };
  return shader;
}

// v7's Buffer types its data as `IArrayBuffer extends ArrayBuffer`, which — under
// modern TS libs — a typed array is NOT structurally assignable to (their
// `[Symbol.toStringTag]` differs: "Float32Array" vs "ArrayBuffer"). ArrayBuffer,
// however, IS structurally assignable to the empty IArrayBuffer extension, so we
// cast typed arrays through ArrayBuffer — the documented "pass a typed array
// here" idiom for v7's Buffer/Geometry API.
const asBufferData = (a: Float32Array | Uint32Array): ArrayBuffer => a as unknown as ArrayBuffer;

export interface TrailView {
  mesh: Mesh<Shader>;
  geometry: Geometry;
  /** The four buffers wrapping the core geometry's typed arrays. Kept as direct
   * references so sync() can bump their _updateID without a getBuffer() lookup. */
  positionBuffer: Buffer;
  uvBuffer: Buffer;
  colorBuffer: Buffer;
  indexBuffer: Buffer;
  /** The core geometry (typed arrays + live counts) this mesh renders. */
  geom: TrailGeometry;
}

/** One trail Mesh sharing `geom`'s typed arrays. The index buffer is re-pointed
 * to a `[0, indexCount)` subarray on every sync and `mesh.size` is set to the
 * live index count, so the draw range follows the live geometry without
 * reallocating. */
export function makeTrailView(geom: TrailGeometry, texture: Texture, blend: BLEND_MODES): TrailView {
  // static=false → these buffers change every frame (DYNAMIC_DRAW hint). The
  // index buffer additionally passes index=true (ELEMENT_ARRAY_BUFFER); its
  // Uint32 data uploads as UNSIGNED_INT (WebGL2/SwiftShader — the golden lane).
  const positionBuffer = new Buffer(asBufferData(geom.positions), false, false);
  const uvBuffer = new Buffer(asBufferData(geom.uvs), false, false);
  const colorBuffer = new Buffer(asBufferData(geom.colors), false, false);
  const indexBuffer = new Buffer(asBufferData(geom.indices), false, true);
  const geometry = new Geometry();
  geometry.addAttribute("aVertexPosition", positionBuffer, 2, false, TYPES.FLOAT);
  geometry.addAttribute("aTextureCoord", uvBuffer, 2, false, TYPES.FLOAT);
  // aColor is NOT normalized: core writes Float32 straight-alpha RGBA in [0,1].
  geometry.addAttribute("aColor", colorBuffer, 4, false, TYPES.FLOAT);
  geometry.addIndex(indexBuffer);

  let mesh: Mesh<Shader>;
  try {
    mesh = new Mesh<Shader>(geometry, trailShader(texture));
  } catch {
    // Headless (pure-node) fallback: v7 throws while probing a GL context for the
    // shader's fragment precision (`document is not defined`). A `new
    // MeshMaterial(texture)` fallback would throw for the SAME reason (it also
    // compiles a Program), so — unlike v8, which falls back to a plain textured
    // mesh — the only non-throwing v7 fallback is a shaderless mesh. It still
    // exercises the geometry/draw-range wiring; real GL shading is proven by the
    // golden lane (M4). The M2 trail unit tests run under jsdom, where the real
    // shader path above succeeds, so this branch is robustness-only (no node-env
    // renderer test constructs a trail layer).
    mesh = new Mesh<Shader>(geometry, undefined as unknown as Shader);
  }
  mesh.blendMode = blend;
  return { mesh, geometry, positionBuffer, uvBuffer, colorBuffer, indexBuffer, geom };
}

/** Upload the current frame's vertex attributes and set the draw range to the
 * live index count. Called after computeTrailGeometry/computeConnectGeometry
 * fills `geom`. */
export function syncTrailView(view: TrailView): void {
  // Re-upload the full vertex arrays (mirrors v8, which also updates the whole
  // position/uv/color buffers — the extra verts past vertexCount are never
  // referenced by the drawn index range).
  view.positionBuffer.update();
  view.uvBuffer.update();
  view.colorBuffer.update();
  // Draw range = live index count. Re-point the index buffer at a prefix view
  // (shares the ArrayBuffer, no copy) so only indexCount indices upload, and set
  // mesh.size to the same — v7's Mesh._renderDefault draws mesh.size indices from
  // mesh.start. An empty frame (0) draws nothing.
  const ic = view.geom.indexCount;
  view.indexBuffer.update(asBufferData(view.geom.indices.subarray(0, ic)));
  view.mesh.size = ic;
  view.mesh.start = 0;
}
