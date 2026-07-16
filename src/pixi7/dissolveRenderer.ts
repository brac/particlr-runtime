// Pixi v7 dissolve / alpha-erosion fork. The v7 port of src/pixi/dissolveShader.ts
// (schemaVersion 4). Pixi v7's ParticleContainer has NO custom-shader hook (unlike
// v8, where a per-container `shader` option is a first-class construction arg), so
// per-particle dissolve requires FORKING the particle render pipeline:
//   - a fork of v7.4.3's `ParticleRenderer` (an ObjectRenderer plugin), verbatim
//     EXCEPT (a) the shader it builds and (b) a `render()` that binds the dissolve
//     noise sampler + uniforms in addition to the layer texture, and
//   - a fork of `ParticleBuffer` (NOT exported by the `pixi.js` monolith — only
//     `ParticleContainer`/`ParticleRenderer` are — so it cannot be reused and is
//     copied here), verbatim.
// The fork is registered under a distinct plugin name (`particlrDissolve`) and a
// `DissolveParticleContainer` subclass routes dissolve layers to it. See
// PIXI7_PLAN M3 + ruling R1 (full dissolve parity via a fork).
//
// Attribute/uniform layout is tracked EXACTLY against v7.4.3's own
// `@pixi/particle-container/lib/particles.{vert,frag}` (pinned by the canary test
// in test/pixi7/dissolve.test.ts): the vertex is a VERBATIM copy of stock so a
// pixi patch that changes the attribute layout trips the canary instead of drifting
// silently; the fragment is stock's varying/uniform declarations with the single
// color line replaced by the dissolve erosion (the v8 math, ported exactly). The
// dissolve golden preset on SwiftShader (M4) is the live-GL parity proof.
//
// Per-container state on a SINGLETON plugin: one ParticleRenderer plugin instance
// is shared across every DissolveParticleContainer in a renderer, so per-container
// dissolve config + the erosion clock (`time`) live ON the container subclass, and
// render() reads them off the `container` argument (exactly how stock render() reads
// per-container `children`/`blendMode`/`_batchSize`/`tintRgb`). renderer.ts sync()
// writes `container.time = effect.time` each frame (deterministic clock; v8 parity).
import {
  ALPHA_MODES,
  Buffer,
  Color,
  ExtensionType,
  Geometry,
  Matrix,
  ObjectRenderer,
  ParticleContainer,
  SCALE_MODES,
  Shader,
  State,
  Texture,
  TYPES,
  WRAP_MODES,
  extensions,
  utils,
} from "pixi.js";
import type { BaseTexture, IParticleProperties, Renderer, Sprite } from "pixi.js";
import type { DissolveConfig } from "../format/types.js";
import { generateDissolveNoise } from "../pixi/textures.js";

// --- Forked shader sources (exported for the canary test) ------------------

// Vertex: VERBATIM copy of v7.4.3's particles.vert. v7's stock particle vertex
// (unlike v8's) has NO round-pixels branch and uses the uniform name
// `translationMatrix` (v8: `uTranslationMatrix`) and varying `vTextureCoord`
// (v8: `vUV`) — this fork tracks v7 exactly. Kept as our own string so a pixi
// upgrade that changes the attribute layout trips the canary (dissolve.test.ts).
export const dissolveVertexGl = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
attribute vec4 aColor;

attribute vec2 aPositionCoord;
attribute float aRotation;

uniform mat3 translationMatrix;
uniform vec4 uColor;

varying vec2 vTextureCoord;
varying vec4 vColor;

void main(void){
    float x = (aVertexPosition.x) * cos(aRotation) - (aVertexPosition.y) * sin(aRotation);
    float y = (aVertexPosition.x) * sin(aRotation) + (aVertexPosition.y) * cos(aRotation);

    vec2 v = vec2(x, y);
    v = v + aPositionCoord;

    gl_Position = vec4((translationMatrix * vec3(v, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = aTextureCoord;
    vColor = aColor * uColor;
}
`;

// Fragment: v7.4.3's particles.frag with the single line
//   `vec4 color = texture2D(uSampler, vTextureCoord) * vColor; gl_FragColor = color;`
// replaced by the dissolve erosion (FORMAT_SPEC "Dissolve / alpha erosion" 0.3c).
// The erosion math is IDENTICAL to the v8 GLSL fork (src/pixi/dissolveShader.ts
// dissolveFragmentGl); only the stock varying/uniform NAMES differ (v7 uses
// vTextureCoord + uSampler where v8 uses vUV + uTexture).
//
// Premultiplication is derived to match stock EXACTLY. In v7, `aColor` is written
// by uploadTint as `Color.toPremultiplied(sprite.alpha, ...)` — i.e. premultiplied —
// and `vColor = aColor * uColor` keeps it premultiplied; the R5 texture upload
// (ALPHA_MODES.UNPACK) makes `texel` premultiplied too. So, exactly as in v8, stock
// outputs `texel(premult) * vColor(premult)` = straight (texRGB·tintRGB)
// premultiplied by (texA·a). Dissolve replaces the alpha `a` with the progress `d`:
// we un-premultiply both inputs, compute the straight result, then re-premultiply by
// the new straight alpha (texA·d). A fully-visible particle (d=1) is therefore
// byte-identical to the stock shader.
export const dissolveFragmentGl = `varying vec2 vTextureCoord;
varying vec4 vColor;

uniform sampler2D uSampler;
uniform sampler2D uDissolveNoise;
uniform float uTime;
uniform float uFrequency;
uniform vec2 uScroll;
uniform float uEdgeWidth;
uniform vec4 uEdgeColor;

void main(void){
    // Un-premultiply the stock inputs to straight alpha (0.3c operates on
    // straight alpha conceptually). texel is premultiply-alpha-on-upload; vColor
    // is premultiplied (aColor = premultiplied tint, vColor = aColor * uColor).
    vec4 texel = texture2D(uSampler, vTextureCoord);
    float texA = texel.a;
    vec3 texRGB = texA > 0.0 ? texel.rgb / texA : vec3(0.0);
    float a = vColor.a;
    vec3 tintRGB = a > 0.0 ? vColor.rgb / a : vec3(0.0);

    // n: dissolve noise, repeat-addressed, scrolled over the effect clock.
    float n = texture2D(uDissolveNoise, vTextureCoord * uFrequency + uTime * uScroll).r;

    // Endpoint-exact threshold: a=1 -> t=-uEdgeWidth -> d=1 for all n>=0;
    // a=0 -> t=1 -> d=0 for all n<=1. The smoothstep width is clamped to a tiny
    // epsilon so uEdgeWidth==0 is a near-hard step (smoothstep(t,t,.) is
    // undefined in GLSL); for uEdgeWidth>0 the upper edge is exactly t+uEdgeWidth.
    float ew = max(uEdgeWidth, 1e-4);
    float t = (1.0 - a) * (1.0 + uEdgeWidth) - uEdgeWidth;
    float d = smoothstep(t, t + ew, n);

    // Straight-alpha result: base color unchanged from stock; a parabolic hot
    // edge band peaks at d=0.5 (edgeColor null -> vec4(0) -> branchless no-op).
    vec3 rgb = texRGB * tintRGB + uEdgeColor.rgb * uEdgeColor.a * (d * (1.0 - d) * 4.0);
    float alpha = texA * d;

    // Re-premultiply to the stock output convention (blend state is premultiplied).
    gl_FragColor = vec4(rgb * alpha, alpha);
}
`;

// --- Cached noise texture (never-destroy + destroyed-guard self-heal) -------
// Same policy as renderer.ts builtinTexture and the v8 dissolveShader noise: the
// dissolve noise tile is pure procedural and shared across every renderer
// instance, so it is cached at module scope and NEVER destroyed by any adapter (a
// forked particle shader holds it as a bound sampler; destroying its source would
// break the bind). The `destroyed` guard self-heals if a host teardown destroys
// it — regenerating from pure pixel math is cheap. R5 texture options + REPEAT
// (128×128 is power-of-two, required for REPEAT on WebGL1).
let noiseTexture: Texture | null = null;

function dissolveNoiseTexture(): Texture {
  if (!noiseTexture || noiseTexture.destroyed) {
    const d = generateDissolveNoise();
    noiseTexture = Texture.fromBuffer(d.pixels, d.width, d.height, {
      // alpha is 255 everywhere, so premultiply-on-upload is the identity and RGB
      // (the sampled channel) is preserved exactly, matching the built-ins' upload.
      alphaMode: ALPHA_MODES.UNPACK,
      scaleMode: SCALE_MODES.LINEAR,
      // REPEAT addressing (0.3c) so uFrequency tiles the seamless noise.
      wrapMode: WRAP_MODES.REPEAT,
    });
  }
  return noiseTexture;
}

// --- ParticleBuffer fork ---------------------------------------------------
// A VERBATIM copy of v7.4.3's `@pixi/particle-container/lib/ParticleBuffer` — the
// monolith does NOT export it (`export { ParticleContainer, ParticleRenderer }`
// only), so it cannot be imported and is reproduced here unchanged. Partitions the
// render properties into dynamic/static geometry buffers and uploads them.

interface IParticleRendererProperty {
  attributeName: string;
  size: number;
  type?: TYPES;
  uploadFunction: (
    children: Sprite[],
    startIndex: number,
    amount: number,
    array: Float32Array | Uint32Array,
    stride: number,
    offset: number,
  ) => void;
  offset: number;
}

// v7's Buffer/Geometry type their data as `IArrayBuffer` (an empty ArrayBuffer
// extension) which typed arrays are NOT structurally assignable to under modern TS
// libs, but ArrayBuffer IS — so cast typed arrays through ArrayBuffer (the same
// documented idiom trailMesh.ts uses).
const asBufferData = (a: Float32Array | Uint32Array | Uint16Array): ArrayBuffer =>
  a as unknown as ArrayBuffer;

class DissolveParticleBuffer {
  readonly geometry = new Geometry();
  size: number;
  dynamicProperties: IParticleRendererProperty[] = [];
  staticProperties: IParticleRendererProperty[] = [];
  indexBuffer: Buffer | null = null;
  staticStride = 0;
  staticBuffer: Buffer | null = null;
  staticData: Float32Array | null = null;
  staticDataUint32: Uint32Array | null = null;
  dynamicStride = 0;
  dynamicBuffer: Buffer | null = null;
  dynamicData: Float32Array | null = null;
  dynamicDataUint32: Uint32Array | null = null;
  _updateID = 0;

  constructor(properties: IParticleRendererProperty[], dynamicPropertyFlags: boolean[], size: number) {
    this.size = size;
    for (let i = 0; i < properties.length; ++i) {
      const src = properties[i]!;
      const property: IParticleRendererProperty = {
        attributeName: src.attributeName,
        size: src.size,
        uploadFunction: src.uploadFunction,
        type: src.type || TYPES.FLOAT,
        offset: src.offset,
      };
      if (dynamicPropertyFlags[i]) this.dynamicProperties.push(property);
      else this.staticProperties.push(property);
    }
    this.initBuffers();
  }

  initBuffers(): void {
    const geometry = this.geometry;
    let dynamicOffset = 0;
    this.indexBuffer = new Buffer(asBufferData(utils.createIndicesForQuads(this.size)), true, true);
    geometry.addIndex(this.indexBuffer);
    this.dynamicStride = 0;
    for (let i = 0; i < this.dynamicProperties.length; ++i) {
      const property = this.dynamicProperties[i]!;
      property.offset = dynamicOffset;
      dynamicOffset += property.size;
      this.dynamicStride += property.size;
    }
    const dynBuffer = new ArrayBuffer(this.size * this.dynamicStride * 4 * 4);
    this.dynamicData = new Float32Array(dynBuffer);
    this.dynamicDataUint32 = new Uint32Array(dynBuffer);
    this.dynamicBuffer = new Buffer(asBufferData(this.dynamicData), false, false);
    let staticOffset = 0;
    this.staticStride = 0;
    for (let i = 0; i < this.staticProperties.length; ++i) {
      const property = this.staticProperties[i]!;
      property.offset = staticOffset;
      staticOffset += property.size;
      this.staticStride += property.size;
    }
    const statBuffer = new ArrayBuffer(this.size * this.staticStride * 4 * 4);
    this.staticData = new Float32Array(statBuffer);
    this.staticDataUint32 = new Uint32Array(statBuffer);
    this.staticBuffer = new Buffer(asBufferData(this.staticData), true, false);
    for (let i = 0; i < this.dynamicProperties.length; ++i) {
      const property = this.dynamicProperties[i]!;
      geometry.addAttribute(
        property.attributeName,
        this.dynamicBuffer,
        0,
        property.type === TYPES.UNSIGNED_BYTE,
        property.type,
        this.dynamicStride * 4,
        property.offset * 4,
      );
    }
    for (let i = 0; i < this.staticProperties.length; ++i) {
      const property = this.staticProperties[i]!;
      geometry.addAttribute(
        property.attributeName,
        this.staticBuffer,
        0,
        property.type === TYPES.UNSIGNED_BYTE,
        property.type,
        this.staticStride * 4,
        property.offset * 4,
      );
    }
  }

  uploadDynamic(children: Sprite[], startIndex: number, amount: number): void {
    for (let i = 0; i < this.dynamicProperties.length; i++) {
      const property = this.dynamicProperties[i]!;
      property.uploadFunction(
        children,
        startIndex,
        amount,
        property.type === TYPES.UNSIGNED_BYTE ? this.dynamicDataUint32! : this.dynamicData!,
        this.dynamicStride,
        property.offset,
      );
    }
    (this.dynamicBuffer as unknown as { _updateID: number })._updateID++;
  }

  uploadStatic(children: Sprite[], startIndex: number, amount: number): void {
    for (let i = 0; i < this.staticProperties.length; i++) {
      const property = this.staticProperties[i]!;
      property.uploadFunction(
        children,
        startIndex,
        amount,
        property.type === TYPES.UNSIGNED_BYTE ? this.staticDataUint32! : this.staticData!,
        this.staticStride,
        property.offset,
      );
    }
    (this.staticBuffer as unknown as { _updateID: number })._updateID++;
  }

  destroy(): void {
    this.indexBuffer = null;
    this.dynamicProperties = null as unknown as IParticleRendererProperty[];
    this.dynamicBuffer = null;
    this.dynamicData = null;
    this.dynamicDataUint32 = null;
    this.staticProperties = null as unknown as IParticleRendererProperty[];
    this.staticBuffer = null;
    this.staticData = null;
    this.staticDataUint32 = null;
    this.geometry.destroy();
  }
}

// --- Sprite-attribute upload functions (VERBATIM from v7.4.3 ParticleRenderer) ---
// None of these reference `this` (stock stores them detached on the properties
// array and ParticleBuffer calls them unbound), so they are plain module functions.
// `ParticleSprite` names only the Sprite internals they read (some private in the
// public d.ts).
interface TextureUvsLike {
  x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number;
}
interface ParticleSprite {
  scale: { x: number; y: number };
  anchor: { x: number; y: number };
  position: { x: number; y: number };
  rotation: number;
  alpha: number;
  _tintRGB: number;
  texture: { baseTexture: { alphaMode: number } };
  _texture: {
    trim: { x: number; y: number; width: number; height: number } | null;
    orig: { width: number; height: number };
    _uvs: TextureUvsLike | null;
    baseTexture: BaseTexture;
  };
}
const asParticle = (s: Sprite): ParticleSprite => s as unknown as ParticleSprite;

function uploadVertices(
  children: Sprite[], startIndex: number, amount: number,
  array: Float32Array | Uint32Array, stride: number, offset: number,
): void {
  let w0 = 0, w1 = 0, h0 = 0, h1 = 0;
  for (let i = 0; i < amount; ++i) {
    const sprite = asParticle(children[startIndex + i]!);
    const texture = sprite._texture;
    const sx = sprite.scale.x;
    const sy = sprite.scale.y;
    const trim = texture.trim;
    const orig = texture.orig;
    if (trim) {
      w1 = trim.x - sprite.anchor.x * orig.width;
      w0 = w1 + trim.width;
      h1 = trim.y - sprite.anchor.y * orig.height;
      h0 = h1 + trim.height;
    } else {
      w0 = orig.width * (1 - sprite.anchor.x);
      w1 = orig.width * -sprite.anchor.x;
      h0 = orig.height * (1 - sprite.anchor.y);
      h1 = orig.height * -sprite.anchor.y;
    }
    array[offset] = w1 * sx;
    array[offset + 1] = h1 * sy;
    array[offset + stride] = w0 * sx;
    array[offset + stride + 1] = h1 * sy;
    array[offset + stride * 2] = w0 * sx;
    array[offset + stride * 2 + 1] = h0 * sy;
    array[offset + stride * 3] = w1 * sx;
    array[offset + stride * 3 + 1] = h0 * sy;
    offset += stride * 4;
  }
}

function uploadPosition(
  children: Sprite[], startIndex: number, amount: number,
  array: Float32Array | Uint32Array, stride: number, offset: number,
): void {
  for (let i = 0; i < amount; i++) {
    const spritePosition = asParticle(children[startIndex + i]!).position;
    array[offset] = spritePosition.x;
    array[offset + 1] = spritePosition.y;
    array[offset + stride] = spritePosition.x;
    array[offset + stride + 1] = spritePosition.y;
    array[offset + stride * 2] = spritePosition.x;
    array[offset + stride * 2 + 1] = spritePosition.y;
    array[offset + stride * 3] = spritePosition.x;
    array[offset + stride * 3 + 1] = spritePosition.y;
    offset += stride * 4;
  }
}

function uploadRotation(
  children: Sprite[], startIndex: number, amount: number,
  array: Float32Array | Uint32Array, stride: number, offset: number,
): void {
  for (let i = 0; i < amount; i++) {
    const spriteRotation = asParticle(children[startIndex + i]!).rotation;
    array[offset] = spriteRotation;
    array[offset + stride] = spriteRotation;
    array[offset + stride * 2] = spriteRotation;
    array[offset + stride * 3] = spriteRotation;
    offset += stride * 4;
  }
}

function uploadUvs(
  children: Sprite[], startIndex: number, amount: number,
  array: Float32Array | Uint32Array, stride: number, offset: number,
): void {
  for (let i = 0; i < amount; ++i) {
    const textureUvs = asParticle(children[startIndex + i]!)._texture._uvs;
    if (textureUvs) {
      array[offset] = textureUvs.x0;
      array[offset + 1] = textureUvs.y0;
      array[offset + stride] = textureUvs.x1;
      array[offset + stride + 1] = textureUvs.y1;
      array[offset + stride * 2] = textureUvs.x2;
      array[offset + stride * 2 + 1] = textureUvs.y2;
      array[offset + stride * 3] = textureUvs.x3;
      array[offset + stride * 3 + 1] = textureUvs.y3;
      offset += stride * 4;
    } else {
      array[offset] = 0;
      array[offset + 1] = 0;
      array[offset + stride] = 0;
      array[offset + stride + 1] = 0;
      array[offset + stride * 2] = 0;
      array[offset + stride * 2 + 1] = 0;
      array[offset + stride * 3] = 0;
      array[offset + stride * 3 + 1] = 0;
      offset += stride * 4;
    }
  }
}

function uploadTint(
  children: Sprite[], startIndex: number, amount: number,
  array: Float32Array | Uint32Array, stride: number, offset: number,
): void {
  for (let i = 0; i < amount; ++i) {
    const sprite = asParticle(children[startIndex + i]!);
    const result = Color.shared
      .setValue(sprite._tintRGB)
      .toPremultiplied(sprite.alpha, sprite.texture.baseTexture.alphaMode > 0);
    array[offset] = result;
    array[offset + stride] = result;
    array[offset + stride * 2] = result;
    array[offset + stride * 3] = result;
    offset += stride * 4;
  }
}

// --- ParticleRenderer fork (the dissolve plugin) ---------------------------
// A fork of v7.4.3's ParticleRenderer. The ctor + property table + generateBuffers
// + buffer loop are verbatim; the two forks are: (1) the shader is built from the
// dissolve GLSL above, and (2) render() binds the dissolve noise sampler + the six
// dissolve uniforms (read off the per-container state) in addition to the stock
// translationMatrix/uColor/uSampler. Registered under a distinct plugin name so it
// coexists with stock's "particle" plugin.

export const DISSOLVE_PLUGIN_NAME = "particlrDissolve";

class DissolveParticleRenderer extends ObjectRenderer {
  static extension = {
    name: DISSOLVE_PLUGIN_NAME,
    type: ExtensionType.RendererPlugin,
  };

  readonly state: State;
  shader: Shader | null = null;
  tempMatrix = new Matrix();
  properties: IParticleRendererProperty[];

  constructor(renderer: Renderer) {
    super(renderer);
    this.properties = [
      // verticesData
      { attributeName: "aVertexPosition", size: 2, uploadFunction: uploadVertices, offset: 0 },
      // positionData
      { attributeName: "aPositionCoord", size: 2, uploadFunction: uploadPosition, offset: 0 },
      // rotationData
      { attributeName: "aRotation", size: 1, uploadFunction: uploadRotation, offset: 0 },
      // uvsData
      { attributeName: "aTextureCoord", size: 2, uploadFunction: uploadUvs, offset: 0 },
      // tintData
      { attributeName: "aColor", size: 1, type: TYPES.UNSIGNED_BYTE, uploadFunction: uploadTint, offset: 0 },
    ];
    // Shader.from probes a GL context for the fragment precision and THROWS in a
    // pure-node env — but a plugin is only ever instantiated when a real Renderer
    // constructs its plugins (never in a unit test), so this ctor always runs with
    // a live GL context. (The DissolveParticleContainer subclass constructs fine in
    // pure node precisely because it never touches Shader.from.)
    this.shader = Shader.from(dissolveVertexGl, dissolveFragmentGl, {});
    this.state = State.for2d();
  }

  override render(container: DissolveParticleContainer): void {
    const children = container.children as unknown as Sprite[];
    const maxSize = container._maxSize;
    const batchSize = container._batchSize;
    const renderer = this.renderer;
    let totalChildren = children.length;
    if (totalChildren === 0) return;
    if (totalChildren > maxSize && !container.autoResize) totalChildren = maxSize;
    let buffers = container._dissolveBuffers;
    if (!buffers) buffers = container._dissolveBuffers = this.generateBuffers(container);
    const baseTexture = asParticle(children[0]!)._texture.baseTexture;
    const premultiplied = baseTexture.alphaMode > 0;
    const shader = this.shader!;
    this.state.blendMode = utils.correctBlendMode(container.blendMode, premultiplied);
    renderer.state.set(this.state);
    const gl = renderer.gl;
    const m = container.worldTransform.copyTo(this.tempMatrix);
    m.prepend(renderer.globalUniforms.uniforms.projectionMatrix as Matrix);
    shader.uniforms.translationMatrix = m.toArray(true);
    shader.uniforms.uColor = Color.shared
      .setValue(container.tintRgb)
      .premultiply(container.worldAlpha, premultiplied)
      .toArray(shader.uniforms.uColor);
    shader.uniforms.uSampler = baseTexture;

    // Dissolve fork: bind the shared noise sampler + the six dissolve uniforms from
    // the PER-CONTAINER state (the plugin is a singleton; config/time live on the
    // container). uScroll/uEdgeColor are plain arrays — gl.uniform{2,4}fv accepts
    // number[]; a null edgeColor is the branchless no-op vec4(0).
    const cfg = container.dissolveConfig;
    const edge = cfg.edgeColor;
    shader.uniforms.uDissolveNoise = dissolveNoiseTexture().baseTexture;
    shader.uniforms.uTime = container.time;
    shader.uniforms.uFrequency = cfg.frequency;
    shader.uniforms.uScroll = [cfg.scroll.x, cfg.scroll.y];
    shader.uniforms.uEdgeWidth = cfg.edgeWidth;
    shader.uniforms.uEdgeColor = edge ? [edge.r, edge.g, edge.b, edge.a] : [0, 0, 0, 0];

    renderer.shader.bind(shader);
    let updateStatic = false;
    for (let i = 0, j = 0; i < totalChildren; i += batchSize, j += 1) {
      let amount = totalChildren - i;
      if (amount > batchSize) amount = batchSize;
      if (j >= buffers.length) buffers.push(this._generateOneMoreBuffer(container));
      const buffer = buffers[j]!;
      buffer.uploadDynamic(children, i, amount);
      const bid = container._bufferUpdateIDs[j] || 0;
      updateStatic = updateStatic || buffer._updateID < bid;
      if (updateStatic) {
        buffer._updateID = container._updateID;
        buffer.uploadStatic(children, i, amount);
      }
      renderer.geometry.bind(buffer.geometry);
      gl.drawElements(gl.TRIANGLES, amount * 6, gl.UNSIGNED_SHORT, 0);
    }
  }

  generateBuffers(container: DissolveParticleContainer): DissolveParticleBuffer[] {
    const buffers: DissolveParticleBuffer[] = [];
    const size = container._maxSize;
    const batchSize = container._batchSize;
    const dynamicPropertyFlags = container._properties;
    for (let i = 0; i < size; i += batchSize) {
      buffers.push(new DissolveParticleBuffer(this.properties, dynamicPropertyFlags, batchSize));
    }
    return buffers;
  }

  _generateOneMoreBuffer(container: DissolveParticleContainer): DissolveParticleBuffer {
    const batchSize = container._batchSize;
    const dynamicPropertyFlags = container._properties;
    return new DissolveParticleBuffer(this.properties, dynamicPropertyFlags, batchSize);
  }

  override destroy(): void {
    super.destroy();
    if (this.shader) {
      this.shader.destroy();
      this.shader = null;
    }
    this.tempMatrix = null as unknown as Matrix;
  }
}

// --- DissolveParticleContainer subclass ------------------------------------
// Routes dissolve layers to the fork. v7's ParticleContainer.render() HARDCODES
// `renderer.plugins.particle` (there is NO `pluginName` indirection like v8), so we
// must OVERRIDE render() to route to `renderer.plugins.particlrDissolve` — the rest
// of the method (visibility guard + lazy baseTexture bind) is copied from stock.
// The subclass carries the per-container dissolve state (config + erosion clock) and
// its own buffer array (`_dissolveBuffers` — the fork owns/destroys these; stock's
// `_buffers` slot stays null because the type there names the un-exported
// ParticleBuffer). Constructible in PURE NODE: super() (the ParticleContainer ctor)
// builds no shader, so unit tests exercise config/time plumbing headlessly.

export class DissolveParticleContainer extends ParticleContainer {
  /** Per-container dissolve config (frequency/scroll/edge). Read by the singleton
   *  plugin's render(). */
  dissolveConfig: DissolveConfig;
  /** Erosion clock in seconds. renderer.ts sync() writes `time = effect.time` each
   *  frame — deterministic, exact under scrub/golden replay (v8 parity). */
  time = 0;
  /** This container's forked particle buffers (the fork owns their lifetime). Kept
   *  separate from stock's `_buffers` (typed against the un-exported ParticleBuffer). */
  _dissolveBuffers: DissolveParticleBuffer[] | null = null;

  constructor(maxSize: number, properties: IParticleProperties, config: DissolveConfig) {
    super(maxSize, properties);
    this.dissolveConfig = config;
  }

  // Copied from stock ParticleContainer.render() EXCEPT the plugin route: v7
  // hardcodes `renderer.plugins.particle`, so we route to `particlrDissolve`. The
  // `_maxSize`/`tintRgb`/etc. the plugin reads are PUBLIC on the base .d.ts; only
  // `baseTexture` is readonly there, hence the single narrow cast for its lazy set.
  override render(renderer: Renderer): void {
    if (!this.visible || this.worldAlpha <= 0 || !this.children.length || !this.renderable) return;
    if (!this.baseTexture) {
      const bt = asParticle(this.children[0]!)._texture.baseTexture;
      (this as { baseTexture: BaseTexture }).baseTexture = bt;
      if (!bt.valid) bt.once("update", () => this.onChildrenChange(0));
    }
    const plugins = renderer.plugins as unknown as Record<string, DissolveParticleRenderer>;
    renderer.batch.setObjectRenderer(plugins[DISSOLVE_PLUGIN_NAME] as unknown as ObjectRenderer);
    plugins[DISSOLVE_PLUGIN_NAME]!.render(this);
  }

  override dispose(): void {
    super.dispose();
    if (this._dissolveBuffers) {
      for (let i = 0; i < this._dissolveBuffers.length; ++i) this._dissolveBuffers[i]!.destroy();
      this._dissolveBuffers = null;
    }
  }
}

// --- Plugin registration (idempotent) --------------------------------------
// v7's `extensions.add` does NOT throw on a duplicate name (handleByMap does
// `map[name] = ref`, overwriting; the pre-renderer queue just re-pushes) — verified
// against 7.4.3 @pixi/extensions source. ESM caches this module so the body runs
// once per registry anyway, but the boolean guard makes re-registration a hard no-op
// regardless. Registering under our OWN name (`particlrDissolve`) never collides
// with stock's "particle" plugin. Must run at import time, before any Renderer is
// constructed (mirrors how @pixi/particle-container registers its own plugin) — the
// M4 golden render-page imports the adapter, then constructs `new Application()`.
// This module-scope side effect compiles NO shader (the plugin class is instantiated
// lazily by the Renderer), so importing this file in pure node does not throw.
let registered = false;
export function registerDissolvePlugin(): void {
  if (registered) return;
  registered = true;
  extensions.add(DissolveParticleRenderer);
}
registerDissolvePlugin();
