// Normative .spark schema v1 types (plan §2.13). These are the source of truth:
// the JSON Schema (spark.schema.json) is generated from them, and no editor
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

export type Shape =
  | { kind: "point"; emitFrom: EmitFrom }
  | { kind: "circle"; radius: number; emitFrom: EmitFrom }
  | { kind: "cone"; direction: number; spread: number; radius: number; emitFrom: EmitFrom }
  | { kind: "rect"; width: number; height: number; emitFrom: EmitFrom }
  | { kind: "edge"; length: number; emitFrom: EmitFrom };

export interface Burst {
  time: number;
  count: number;
  spread: number;
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
}

export interface OverLifetime {
  size: ScalarTrack | null;
  color: GradientTrack;
  rotation: ScalarTrack | null;
  velocity: Velocity;
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
  initial: InitialProps;
  overLifetime: OverLifetime;
  subEmitters: null;
  trail: null;
}

export interface SparkMeta {
  name: string;
  createdWith: string;
  notes: string;
}

export interface SparkDoc {
  schemaVersion: 2;
  meta: SparkMeta;
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

/** Current schema version this build understands. */
export const CURRENT_SCHEMA_VERSION = 2;
