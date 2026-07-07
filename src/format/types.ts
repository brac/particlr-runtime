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
  | { kind: "edge"; length: number; emitFrom: EmitFrom };

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
  /** Simple collision (schemaVersion 3); null = off. */
  collision: CollisionConfig | null;
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
  schemaVersion: 3;
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
export const SHAPE_KINDS: readonly Shape["kind"][] = ["point", "circle", "cone", "rect", "edge"];
export const SIM_SPACES: readonly SimSpace[] = ["local", "world"];
export const ARC_MODES: readonly ArcMode[] = ["random", "loop", "pingPong", "burstSpread"];
export const SUB_TRIGGERS: readonly SubTrigger[] = ["birth", "death", "collision"];

/** Current schema version this build understands. */
export const CURRENT_SCHEMA_VERSION = 3;
