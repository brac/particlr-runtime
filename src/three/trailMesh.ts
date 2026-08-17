// Trail ribbon for the Three adapter (port template: src/pixi/trailMesh.ts).
// One Mesh per trail layer whose BufferGeometry attributes ARE the core
// TrailGeometry typed arrays (write-through). Attributes use adapter-owned
// names (aTrailPos vec2, aTrailUV, aTrailColor) — three's injected built-ins
// are bypassed entirely by RawShaderMaterial. Draw range follows indexCount;
// frustumCulled = false (geometry changes every frame).
import { Mesh, BufferGeometry, BufferAttribute, RawShaderMaterial, DynamicDrawUsage, DoubleSide, type Texture } from "three";
import type { BlendMode } from "../format/types.js";
import type { TrailGeometry } from "../core/trailGeometry.js";
import { applyBlend } from "./materials.js";

export const trailVertexGl = `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
attribute vec2 aTrailPos;   // sim x, sim y (negated to local y in the shader)
attribute vec2 aTrailUV;
attribute vec4 aTrailColor; // straight alpha
varying vec2 vUV;
varying vec4 vColor;
void main() {
  vUV = aTrailUV;
  vColor = aTrailColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aTrailPos.x, -aTrailPos.y, 0.0, 1.0);
}
`;

export const trailFragmentGl = `precision highp float;
uniform sampler2D uTexture;
varying vec2 vUV;
varying vec4 vColor;
void main() {
  vec4 texel = texture2D(uTexture, vUV);
  vec3 rgb = texel.rgb * vColor.rgb;
  float a = texel.a * vColor.a;
  gl_FragColor = vec4(rgb * a, a);
}
`;

export interface ThreeTrailView {
  mesh: Mesh<BufferGeometry, RawShaderMaterial>;
  geom: TrailGeometry;
}

export function makeTrailView(geom: TrailGeometry, texture: Texture, blend: BlendMode): ThreeTrailView {
  const geometry = new BufferGeometry();
  geometry.setAttribute("aTrailPos", new BufferAttribute(geom.positions, 2).setUsage(DynamicDrawUsage));
  geometry.setAttribute("aTrailUV", new BufferAttribute(geom.uvs, 2).setUsage(DynamicDrawUsage));
  geometry.setAttribute("aTrailColor", new BufferAttribute(geom.colors, 4).setUsage(DynamicDrawUsage));
  geometry.setIndex(new BufferAttribute(geom.indices, 1).setUsage(DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const material = new RawShaderMaterial({
    vertexShader: trailVertexGl,
    fragmentShader: trailFragmentGl,
    uniforms: { uTexture: { value: texture } },
    side: DoubleSide, // never FrontSide — see materials.ts, above makeSpriteMaterial
  });
  applyBlend(material, blend);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.userData.particlrTrail = true;
  return { mesh, geom };
}

export function setTrailTexture(view: ThreeTrailView, texture: Texture): void {
  view.mesh.material.uniforms.uTexture!.value = texture;
}

export function syncTrailView(view: ThreeTrailView): void {
  const geo = view.mesh.geometry;
  for (const name of ["aTrailPos", "aTrailUV", "aTrailColor"] as const) {
    (geo.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }
  (geo.getIndex() as BufferAttribute).needsUpdate = true;
  geo.setDrawRange(0, view.geom.indexCount);
}
