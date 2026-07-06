// Normative .spark schema v1 types (plan §2.13). These are the source of truth:
// the JSON Schema (spark.schema.json) is generated from them, and no editor
// control or runtime behavior may exist unless it is expressible here.

export type BlendMode = "normal" | "add" | "multiply" | "screen";
export type EmitFrom = "volume" | "surface";
export type Ease = "linear" | "easeIn" | "easeOut" | "easeInOut" | "step";

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
  schemaVersion: 1;
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

/** Current schema version this build understands. */
export const CURRENT_SCHEMA_VERSION = 1;
