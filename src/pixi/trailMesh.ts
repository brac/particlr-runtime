// Pixi v8 trail ribbon adapter (schemaVersion 3, M9) — the project's first
// non-sprite render path. One Mesh per trail layer, backed by a MeshGeometry
// whose aPosition/aUV/aColor buffers ARE the core TrailGeometry typed arrays
// (write-through: core fills them, we mark the buffers dirty). The dual-source
// (GL + WGSL) shader is Pixi's OWN mesh shader — built from its published
// high-shader bits — plus `colorBit` (per-vertex aColor). Reusing Pixi's bits
// guarantees the global/local uniform bind groups match what the mesh pipe
// binds (a hand-written Shader.from left the global UBO unbound, so the
// projection matrix was garbage). Not counted against the core size budget
// (pixi-only). See core/trailGeometry.ts for the geometry math.
import {
  colorBit,
  colorBitGl,
  compileHighShaderGlProgram,
  compileHighShaderGpuProgram,
  localUniformBit,
  localUniformBitGl,
  Mesh,
  MeshGeometry,
  roundPixelsBit,
  roundPixelsBitGl,
  Shader,
  textureBit,
  textureBitGl,
  type BLEND_MODES,
  type Texture,
} from "pixi.js";
import type { TrailGeometry } from "../core/trailGeometry.js";

/** Build the trail shader bound to `texture`. It is Pixi's mesh shader (local
 * uniforms + texture + round-pixels) with colorBit appended, so the texture is
 * multiplied by the per-vertex color. `colorBit` premultiplies aColor (Pixi v8's
 * pipeline is premultiplied), so the straight-alpha vertex colors core writes
 * composite correctly under the layer's blend mode. May throw in a headless
 * (no-DOM) unit-test environment where Pixi eagerly probes a GL context —
 * callers fall back to a plain textured mesh there. */
function trailShader(texture: Texture): Shader {
  const glProgram = compileHighShaderGlProgram({
    name: "particlr-trail",
    bits: [localUniformBitGl, textureBitGl, roundPixelsBitGl, colorBitGl],
  });
  const gpuProgram = compileHighShaderGpuProgram({
    name: "particlr-trail",
    bits: [localUniformBit, textureBit, roundPixelsBit, colorBit],
  });
  return new Shader({
    glProgram,
    gpuProgram,
    resources: {
      // The mesh pipe binds only groups 100/101 (global/local) for a custom
      // shader; the texture group (2) must be bound here at creation.
      uTexture: texture.source,
      uSampler: texture.source.style,
      textureUniforms: {
        uTextureMatrix: { type: "mat3x3<f32>", value: texture.textureMatrix.mapCoord },
      },
    },
  });
}

export interface TrailView {
  mesh: Mesh<MeshGeometry, Shader>;
  geometry: MeshGeometry;
  /** The core geometry (typed arrays + live counts) this mesh renders. */
  geom: TrailGeometry;
}

/** One trail Mesh sharing `geom`'s typed arrays. The index buffer is re-pointed
 * to a `[0, indexCount)` subarray on every sync, so the draw range follows the
 * live geometry without reallocating. */
export function makeTrailView(geom: TrailGeometry, texture: Texture, blend: BLEND_MODES): TrailView {
  const geometry = new MeshGeometry({ positions: geom.positions, uvs: geom.uvs, indices: geom.indices });
  geometry.addAttribute("aColor", { buffer: geom.colors, format: "float32x4" });
  let mesh: Mesh<MeshGeometry, Shader>;
  try {
    mesh = new Mesh({ geometry, shader: trailShader(texture) });
  } catch {
    // Headless (unit test) fallback: a plain textured mesh still exercises the
    // geometry/draw-range wiring; GL/GPU shading is verified by the golden suite.
    // (A TextureShader is a Shader, so the covariant mesh type still holds.)
    mesh = new Mesh({ geometry, texture }) as Mesh<MeshGeometry, Shader>;
  }
  mesh.blendMode = blend;
  return { mesh, geometry, geom };
}

/** Upload the current frame's vertex attributes and set the draw range to the
 * live index count. Called after computeTrailGeometry fills `geom`. */
export function syncTrailView(view: TrailView): void {
  const geo = view.geometry;
  geo.getBuffer("aPosition").update();
  geo.getBuffer("aUV").update();
  geo.getBuffer("aColor").update();
  // Draw range = live index count: re-point the index buffer at a prefix view
  // (shares the ArrayBuffer, no copy) so the mesh draws exactly indexCount
  // indices — an empty frame (0) draws nothing.
  const ib = geo.indexBuffer;
  ib.data = view.geom.indices.subarray(0, view.geom.indexCount);
  ib.update();
}
