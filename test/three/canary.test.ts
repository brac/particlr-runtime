// Three surface canary (V2_DESIGN Part 1 §Packaging): asserts the exact three
// API surface the adapter builds on exists with the shapes we use, so a pinned-
// minor bump that moves any of it fails HERE with a named cause instead of as
// an opaque adapter breakage. Same discipline as the pixi shader-fork canary.
import { describe, it, expect } from "vitest";
import {
  InstancedBufferGeometry, InstancedBufferAttribute, BufferGeometry, BufferAttribute,
  RawShaderMaterial, Mesh, Group, DataTexture, Matrix4,
  CustomBlending, AddEquation, OneFactor, ZeroFactor, OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor, DstColorFactor, RGBAFormat, UnsignedByteType,
  LinearFilter, ClampToEdgeWrapping, RepeatWrapping, DynamicDrawUsage,
} from "three";

describe("three API canary", () => {
  it("constructs the exact surface the adapter uses", () => {
    const geo = new InstancedBufferGeometry();
    geo.setAttribute("aInstPos", new InstancedBufferAttribute(new Float32Array(4), 2));
    expect(typeof geo.instanceCount).toBe("number");
    const mat = new RawShaderMaterial({ vertexShader: "void main(){}", fragmentShader: "void main(){}" });
    mat.blending = CustomBlending;
    mat.blendSrc = OneFactor;
    mat.blendDst = OneMinusSrcAlphaFactor;
    mat.blendEquation = AddEquation;
    const tex = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
    tex.needsUpdate = true;
    expect(new Group().isObject3D).toBe(true);
    expect(new Mesh(new BufferGeometry(), mat).isMesh).toBe(true);
    // Constants referenced by the blend table must all be distinct numbers.
    const consts = [OneFactor, ZeroFactor, OneMinusSrcAlphaFactor, OneMinusSrcColorFactor, DstColorFactor];
    expect(new Set(consts).size).toBe(consts.length);
    expect(new InstancedBufferAttribute(new Float32Array(1), 1).setUsage(DynamicDrawUsage)).toBeTruthy();
    expect([LinearFilter, ClampToEdgeWrapping, RepeatWrapping, new Matrix4()].every((v) => v !== undefined)).toBe(true);
  });
});
