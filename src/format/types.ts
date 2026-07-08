// Normative .prt schema v1 types (plan §2.13). These are the source of truth:
// the JSON Schema (particle.schema.json) is generated from them, and no editor
// control or runtime behavior may exist unless it is expressible here.

export type BlendMode = "normal" | "add" | "multiply" | "screen";
export type EmitFrom = "volume" | "surface";
export type Ease = "linear" | "easeIn" | "easeOut" | "easeInOut" | "step";
/** The frame a layer's particles simulate in (schemaVersion 2). `local`:
 * positions are relative to the effect origin and the renderer places the whole
 * layer at the emitter (v1 behavior). `world`: particles spawn at the emitter's
 * current position and thereafter simulate independently in the parent frame, so
 * a moving emitter leaves them behind — the trail. (EMITTER_MOTION_PLAN) */
export type SimSpace = "local" | "world";

export type ScalarInit =
  | { mode: "constant"; value: number }
  | { mode: "range"; min: number; max: number };

export type ScalarTrack =
  | { mode: "constant"; value: number }
  | { mode: "range"; min: number; max: number }
  | { mode: "curve"; keys: CurveKey[] };

export interface CurveKey {
  t: number;
  v: number;
  ease?: Ease;
}
export interface GradientKey {
  t: number;
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface GradientTrack {
  keys: GradientKey[];
}

/** How the emission angle sweeps across a circle arc / cone spread
 * (schemaVersion 3). `random` = the v2 behavior (uniform within the span).
 * The others make emission march deterministically around the arc. */
export type ArcMode = "random" | "loop" | "pingPong" | "burstSpread";

export type Shape =
  | { kind: "point"; emitFrom: EmitFrom }
  | {
      kind: "circle";
      radius: number;
      /** schemaVersion 3. Inner hole radius for a donut; 0 = full disc (v2). */
      innerRadius: number;
      /** schemaVersion 3. Angular span in degrees from 0° (+x, clockwise); 360 = full (v2). */
      arc: number;
      /** schemaVersion 3. How the emission angle sweeps the arc. */
      arcMode: ArcMode;
      /** schemaVersion 3. Sweeps per second for loop/pingPong modes. */
      arcSpeed: number;
      emitFrom: EmitFrom;
    }
  | {
      kind: "cone";
      direction: number;
      spread: number;
      radius: number;
      /** schemaVersion 3. How the emission angle sweeps the spread. */
      arcMode: ArcMode;
      /** schemaVersion 3. Sweeps per second for loop/pingPong modes. */
      arcSpeed: number;
      emitFrom: EmitFrom;
    }
  | { kind: "rect"; width: number; height: number; emitFrom: EmitFrom }
  | { kind: "edge"; length: number; emitFrom: EmitFrom }
  | {
      kind: "texture";
      /** schemaVersion 4. Rendered size in px of the mask, centered on the layer
       * origin (mask cell (0,0) maps to the top-left corner). Must be > 0. */
      width: number;
      height: number;
      /** schemaVersion 4. Alpha gate in [0,1]; a mask pixel emits only when its
       * alpha (0..1) is >= threshold, and then weights spawn density by alpha. */
      threshold: number;
      /** schemaVersion 4. The base64-packed alpha mask sampled for positions. */
      mask: MaskData;
      emitFrom: EmitFrom;
    };

/** A base64-packed alpha mask for emit-from-texture (schemaVersion 4). `data` is
 * the base64 of `width·height` raw alpha bytes (0–255), row-major, top-left
 * origin. Dims are integers in [1, 128]. The stored string is never re-encoded
 * so round-trip is byte-stable; the 1×1 opaque default (`data: "/w=="`) sampled
 * over `shape.width × shape.height` is exactly a uniform rect. */
export interface MaskData {
  width: number;
  height: number;
  data: string;
}

export interface Burst {
  time: number;
  count: number;
  spread: number;
  /** schemaVersion 3. Number of times the burst repeats; 1 = single (v2). */
  cycles: number;
  /** schemaVersion 3. Seconds between cycles (only meaningful when cycles > 1). */
  interval: number;
  /** schemaVersion 3. Per-cycle firing probability in [0,1]; 1 = always (v2). */
  probability: number;
}

export interface Emission {
  rateOverTime: ScalarTrack;
  /** Particles per pixel the emitter travels (schemaVersion 2). World-space
   * only — keeps trail density uniform regardless of emitter speed. Null =
   * disabled (v1 behavior). Same rate ceiling as rateOverTime. */
  rateOverDistance: ScalarTrack | null;
  bursts: Burst[];
  delay: number;
  prewarm: boolean;
  maxParticles: number;
}

export interface Flipbook {
  cols: number;
  rows: number;
  fps: number;
  mode: "loop" | "once" | "random";
}
export interface TextureRef {
  ref: string;
  frames: Flipbook | null;
}

export interface InitialProps {
  life: ScalarInit;
  speed: ScalarInit;
  size: ScalarInit;
  rotation: ScalarInit;
  angularVelocity: ScalarInit;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Velocity {
  gravity: Vec2;
  drag: ScalarTrack | null;
  speedMultiplier: ScalarTrack | null;
  /** Velocity over lifetime (schemaVersion 3), all additive px/s at ageNorm
   * (added into the position update, not accumulated into stored velX/velY).
   * `x`/`y` are directional; `orbital` is deg/s clockwise about the layer
   * origin; `radial` is px/s outward. Null = the field contributes nothing. */
  x: ScalarTrack | null;
  y: ScalarTrack | null;
  orbital: ScalarTrack | null;
  radial: ScalarTrack | null;
}

export interface OverLifetime {
  size: ScalarTrack | null;
  color: GradientTrack;
  rotation: ScalarTrack | null;
  velocity: Velocity;
}

/** RGBA color, each channel in [0,1] (schemaVersion 3). */
export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Turbulence / curl-noise field applied as a bounded position perturbation
 * (schemaVersion 3). `strength` is px/s over the particle's life; `frequency`
 * scales the spatial lattice; `scrollSpeed` scrolls the field over time;
 * `octaves` (1..3) stacks detail. */
export interface NoiseConfig {
  strength: ScalarTrack;
  frequency: number;
  scrollSpeed: number;
  octaves: number;
}

/** Velocity-aligned rendering + speed stretch (schemaVersion 3).
 * `align: "velocity"` rotates the sprite to face its motion; `speedScale`
 * grows the along-motion stretch with speed, clamped to [minStretch, maxStretch]. */
export interface RenderConfig {
  align: "none" | "velocity";
  speedScale: number;
  minStretch: number;
  maxStretch: number;
}

/** Remap size/color/rotation by a particle's instantaneous speed
 * (schemaVersion 3). Speed is normalized across [range.min, range.max]; each
 * non-null channel is then applied at that t. Curve/constant tracks only —
 * no per-particle range mode (no reserved PRNG draw). */
export interface BySpeedConfig {
  range: { min: number; max: number };
  size: ScalarTrack | null;
  color: GradientTrack | null;
  rotation: ScalarTrack | null;
}

/** Per-particle spawn-color variety (schemaVersion 3), applied as a constant
 * tint multiplier over the over-lifetime gradient (L7 amendment).
 * `gradients`: lerp between two gradients by a per-particle uniform.
 * `palette`: pick one of 1..16 fixed colors per particle. */
export type StartColor =
  | { mode: "gradients"; a: GradientTrack; b: GradientTrack }
  | { mode: "palette"; colors: RGBAColor[] };

/** Per-particle random mirroring (schemaVersion 3). `x`/`y` are the
 * probabilities in [0,1] of flipping that axis (negative sprite scale). */
export interface RandomFlip {
  x: number;
  y: number;
}

/** Simple collision plane(s) in the layer's sim frame (schemaVersion 3).
 * `floor`: a horizontal line at `y`. `rect`: keep particles inside the box.
 * `bounce`/`dampen`/`lifetimeLoss` are all in [0,1]. */
export interface CollisionConfig {
  shape:
    | { kind: "floor"; y: number }
    | { kind: "rect"; x: number; y: number; width: number; height: number };
  bounce: number;
  dampen: number;
  lifetimeLoss: number;
}

/** How a layer's particles spawn children on another layer (schemaVersion 3).
 * `layerId` names a sibling layer (depth 1: that layer must have
 * `subEmitters: null`). `count` children per event, gated by `probability`. */
export interface SubEmitterRef {
  trigger: SubTrigger;
  layerId: string;
  count: number;
  probability: number;
  inheritVelocity: number;
}

/** Per-particle ribbon trail (schemaVersion 3). Polyline of the last
 * `maxPoints` positions; `width` over trail t (0 = head); `color` over trail
 * length (null = the particle's current color). */
export interface TrailConfig {
  maxPoints: number;
  minVertexDistance: number;
  width: ScalarTrack;
  color: GradientTrack | null;
}

/** The event that fires a sub-emitter (schemaVersion 3). */
export type SubTrigger = "birth" | "death" | "collision";

/** How an attractor's force falls off toward its `radius` (schemaVersion 4).
 * `none` = full strength inside the radius (hard cutoff); `linear` = ramps to 0
 * at the edge; `smooth` = smoothstep ease. */
export type AttractorFalloff = "none" | "linear" | "smooth";

/** Point attractor / vortex in the layer's sim frame (schemaVersion 4). Applies
 * a radial (`strength`) and tangential (`tangential`, orbiting) acceleration in
 * px/s² over the particle's ageNorm to particles within `radius`; both tracks
 * are constant/curve only (no per-particle range mode, so zero PRNG draws — the
 * same ruling as `noise.strength`). `killRadius` (0 = off) kills particles that
 * fall inside it via the M7 ageLoss mechanism, so death-trigger sub-emitters
 * fire. See FORMAT_SPEC "Point attractor / vortex" for the force + sign rules. */
export interface AttractorConfig {
  x: number;
  y: number;
  strength: ScalarTrack;
  tangential: ScalarTrack | null;
  radius: number;
  falloff: AttractorFalloff;
  killRadius: number;
}

/** Alpha-erosion "dissolve" (schemaVersion 4); renderer-only, off when null. A
 * per-layer noise pattern erodes the particle's alpha: the final render alpha is
 * the dissolve progress. `frequency` is the pattern repeat across the sprite in
 * (0, 64]; `scroll` is UV/s over the effect clock; `edgeWidth` in [0,1] is the
 * soft erosion band; `edgeColor` (null = off) tints a hot edge along that band. */
export interface DissolveConfig {
  frequency: number;
  scroll: Vec2;
  edgeWidth: number;
  edgeColor: RGBAColor | null;
}

export interface Layer {
  id: string;
  name: string;
  enabled: boolean;
  blend: BlendMode;
  texture: TextureRef;
  emission: Emission;
  shape: Shape;
  /** Simulation space (schemaVersion 2). Default "local" = v1 behavior. */
  space: SimSpace;
  /** Fraction of the emitter's velocity added to each particle's spawn velocity
   * (schemaVersion 2). Range [-2, 2]. Applied in world space only; ignored (but
   * preserved) for local layers. Plain constant, not a ScalarInit, so it costs
   * zero PRNG draws and preserves the normative 13-draw spawn order (§2.7). */
  inheritVelocity: number;
  /** Per-layer scale on the host attractor's force (schemaVersion 4). Range
   * [-2, 2]; 0 = the host `setAttractor` hook has no effect on this layer (the
   * migration default, so every existing document is unaffected). A plain
   * constant, not a ScalarTrack, so it costs zero PRNG draws (same rationale as
   * `inheritVelocity`). */
  attractorInfluence: number;
  initial: InitialProps;
  overLifetime: OverLifetime;
  /** Turbulence field (schemaVersion 3); null = off. */
  noise: NoiseConfig | null;
  /** Speed-driven size/color/rotation remaps (schemaVersion 3); null = off. */
  bySpeed: BySpeedConfig | null;
  /** Per-particle spawn-color variety (schemaVersion 3); null = off. */
  startColor: StartColor | null;
  /** Per-particle random flip (schemaVersion 3); null = off. */
  randomFlip: RandomFlip | null;
  /** Velocity-aligned / stretched rendering (schemaVersion 3); null = off. */
  render: RenderConfig | null;
  /** Alpha-erosion dissolve (schemaVersion 4); null = off. */
  dissolve: DissolveConfig | null;
  /** Simple collision (schemaVersion 3); null = off. */
  collision: CollisionConfig | null;
  /** Point attractor / vortex (schemaVersion 4); null = off. */
  attractor: AttractorConfig | null;
  /** Sub-emitters (schemaVersion 3); null = none (was reserved in v1/v2). */
  subEmitters: SubEmitterRef[] | null;
  /** Per-particle trail (schemaVersion 3); null = off (was reserved in v1/v2). */
  trail: TrailConfig | null;
}

export interface ParticleMeta {
  name: string;
  createdWith: string;
  notes: string;
}

export interface ParticleDoc {
  schemaVersion: 4;
  meta: ParticleMeta;
  duration: number;
  looping: boolean;
  seed: number;
  /** "user:<name>" data URLs, keyed by <name> (plan §2.11). */
  textures?: Record<string, string>;
  layers: Layer[];
}

/** Built-in procedural texture ids (plan §2.11). */
export const BUILTIN_TEXTURE_IDS = [
  "circle-soft",
  "circle-hard",
  "square",
  "spark",
  "smoke",
] as const;

export type BuiltinTextureId = (typeof BUILTIN_TEXTURE_IDS)[number];

export const BLEND_MODES: readonly BlendMode[] = ["normal", "add", "multiply", "screen"];
export const EMIT_FROM: readonly EmitFrom[] = ["volume", "surface"];
export const EASES: readonly Ease[] = ["linear", "easeIn", "easeOut", "easeInOut", "step"];
export const FLIPBOOK_MODES: readonly Flipbook["mode"][] = ["loop", "once", "random"];
export const SHAPE_KINDS: readonly Shape["kind"][] = ["point", "circle", "cone", "rect", "edge", "texture"];
export const SIM_SPACES: readonly SimSpace[] = ["local", "world"];
export const ARC_MODES: readonly ArcMode[] = ["random", "loop", "pingPong", "burstSpread"];
export const SUB_TRIGGERS: readonly SubTrigger[] = ["birth", "death", "collision"];
export const ATTRACTOR_FALLOFFS: readonly AttractorFalloff[] = ["none", "linear", "smooth"];

/** Current schema version this build understands. */
export const CURRENT_SCHEMA_VERSION = 4;
