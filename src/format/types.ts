// Normative .prt schema v1 types (plan §2.13). These are the source of truth:
// the JSON Schema (particle.schema.json) is generated from them, and no editor
// control or runtime behavior may exist unless it is expressible here.

/** Per-layer compositing mode. `erase` (schemaVersion 7, B8) is Pixi v8's native
 * `'erase'`: the layer subtracts destination alpha (weighted by its own source
 * alpha) in the target it draws into, cutting negative-space holes in the layers
 * drawn before it (layer order = draw order). Render-pipeline state only — zero
 * sim impact, zero PRNG draws (blend never reaches the core). */
export type BlendMode = "normal" | "add" | "multiply" | "screen" | "erase";
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
  | { mode: "curve"; keys: CurveKey[] }
  /** Per-particle blend between two curves (schemaVersion 5). At time `t` the
   * value is `lerp(evalCurve(a, t), evalCurve(b, t), particleRand)`, where
   * `particleRand` is the track's OWN already-reserved per-particle uniform
   * (§0.2) — the same slot `range` consumes — so a `randomBetweenCurves` track
   * adds ZERO new PRNG draws. Valid ONLY on the eight per-particle over-lifetime
   * tracks that own such a uniform (`overLifetime.size`, `.rotation`,
   * `.velocity.{drag, speedMultiplier, x, y, orbital, radial}`); the validator
   * rejects it on `emission.rateOverTime` and every constant/curve-only track
   * (E28). `a`/`b` are validated exactly like `curve` keys. */
  | { mode: "randomBetweenCurves"; a: CurveKey[]; b: CurveKey[] };

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
  /** Host-parameter binding for `rateOverTime` (schemaVersion 6, A9). Names a
   * `ParticleDoc.params` entry whose current value scales the evaluated rate
   * (A9_PLAN §0.3 sites table; A9_PARAMS_RESEARCH Q6 Shape A). `null`/absent =
   * unbound = the untouched v5 code path. */
  rateOverTimeParam: string | null;
  /** Particles per pixel the emitter travels (schemaVersion 2). World-space
   * only — keeps trail density uniform regardless of emitter speed. Null =
   * disabled (v1 behavior). Same rate ceiling as rateOverTime. */
  rateOverDistance: ScalarTrack | null;
  /** Host-parameter binding for `rateOverDistance` (schemaVersion 6, A9). Scales
   * the evaluated distance-rate; `null`/absent = unbound (A9_PLAN §0.3, D4). */
  rateOverDistanceParam: string | null;
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
  /** Per-particle random frame offset for `loop`/`once` modes (schemaVersion 5).
   * Reuses draw 13 (`frameRand`, already drawn unconditionally) — ZERO new draws.
   * Ignored by `mode: "random"` (already per-particle random). Render-only; does
   * not touch the statehash (E30). */
  randomStartFrame: boolean;
  /** Deterministic frame index over the particle's ageNorm (schemaVersion 5);
   * null = off. When non-null it OVERRIDES `mode` entirely: the frame is
   * `clamp(⌊evalScalarTrack(frameOverLife, ageNorm, 0)·total⌋, 0, total−1)`.
   * A range-forbidding track (constant/curve only), so ZERO draws. Render-only
   * (E30). */
  frameOverLife: ScalarTrack | null;
}
export interface TextureRef {
  ref: string;
  frames: Flipbook | null;
}

export interface InitialProps {
  life: ScalarInit;
  /** Host-parameter binding for initial `life` (schemaVersion 6, A9). Scales the
   * per-spawn drawn life; future spawns only (A9_PLAN §0.3 sites table, D4).
   * `null`/absent = unbound = the untouched v5 code path. */
  lifeParam: string | null;
  speed: ScalarInit;
  /** Host-parameter binding for initial `speed` (schemaVersion 6, A9). Scales the
   * per-spawn drawn speed before it becomes vx/vy; future spawns only
   * (A9_PLAN §0.3 sites table, D4). `null`/absent = unbound. */
  speedParam: string | null;
  size: ScalarInit;
  /** Host-parameter binding for `size` (schemaVersion 6, A9). A live render-path
   * multiply on each particle's size (docs/UI say "Size"; A9_PLAN §0.3 sites
   * table marks it live). `null`/absent = unbound. */
  sizeParam: string | null;
  rotation: ScalarInit;
  angularVelocity: ScalarInit;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Velocity {
  gravity: Vec2;
  /** Host-parameter binding for `gravity` (schemaVersion 6, A9). Scales the
   * hoisted gravity vector once per step; live for all particles
   * (A9_PLAN §0.3 sites table, D4). `null`/absent = unbound. */
  gravityParam: string | null;
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
  | { mode: "palette"; colors: RGBAColor[] }
  /** Per-particle hue jitter (schemaVersion 5), mutually exclusive with
   * `gradients`/`palette`. At spawn it draws the existing startColor uniform
   * `u` (draw 19) and stores a per-particle hue offset `(u − 0.5)·2·degrees` ∈
   * [−degrees, +degrees] into the already-allocated tint columns — ZERO new
   * draws, ZERO new pool columns. At render it hue-rotates the over-lifetime
   * gradient color by that offset (E29). `degrees ∈ [0, 180]`. */
  | { mode: "hueJitter"; degrees: number };

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
  /** Speed clamp over the particle's ageNorm (schemaVersion 5); null = off. A
   * range-forbidding track (constant/curve only — evaluated like `noise.strength`,
   * ZERO PRNG draws). When non-null the sim caps stored velocity to
   * `max(0, evalScalarTrack(limitVelocity, ageNorm, 0))` after drag, before the
   * position write (a physical, persistent cap); `cap = 0` freezes particles in
   * place (valid, E27). */
  limitVelocity: ScalarTrack | null;
  /** Turbulence field (schemaVersion 3); null = off. */
  noise: NoiseConfig | null;
  /** Speed-driven size/color/rotation remaps (schemaVersion 3); null = off. */
  bySpeed: BySpeedConfig | null;
  /** Per-particle spawn-color variety (schemaVersion 3); null = off. */
  startColor: StartColor | null;
  /** Per-particle random flip (schemaVersion 3); null = off. */
  randomFlip: RandomFlip | null;
  /** Host COLOR-parameter binding for a layer-level tint (schemaVersion 8,
   * COLOR_PARAM_PLAN C2). Like `opacityParam`, this is a NEW layer-level knob with
   * no existing document field behind it and an implicit base of white
   * `{1,1,1,1}`: when bound it multiplies each particle's finished RGBA
   * (gradient × startColor × bySpeed × **tint** × opacityParam) — the LAST color
   * multiply BEFORE `opacityParam` (normative order; both multiplies commute).
   * LIVE and frame-live for all particles, exactly like opacity. Names a
   * `kind: "color"` entry in `ParticleDoc.params`. `null`/absent = unbound = the
   * untouched pre-v8 render path (never a multiply-by-white). */
  tintParam: string | null;
  /** Host-parameter binding for particle opacity (schemaVersion 6, A9). Alpha has
   * no existing document knob (the over-lifetime gradient owns it), so this is a
   * NEW layer-level field with an implicit base of `1`: when bound it scales
   * `buf.a` as the LAST color multiply (A9_PLAN §0.3 sites table & opacity caveat;
   * A9_PARAMS_RESEARCH Q6 opacity caveat). Live for all particles; `null`/absent
   * = unbound = the untouched v5 render path. */
  opacityParam: string | null;
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

/** A host-exposed SCALAR parameter (schemaVersion 6, A9; gained the explicit
 * `kind` discriminant in schemaVersion 8, COLOR_PARAM_PLAN C1). A game names the
 * param and drives it live via `Effect.setParam(name, value)`; each scalar binding
 * field (`…Param`) references one by `name`. The runtime multiplies a knob's
 * evaluated value by the param's current value (multiply-only; default `1` = "as
 * authored" by convention, A9_PLAN §0.1 D1/D3). `default`/`min`/`max` are the
 * authored range; `setParam` clamps into `[min, max]` (A9_PLAN §0.3). */
export interface ScalarParamDef {
  kind: "scalar";
  name: string;
  /** Authored value in force until the host first calls `setParam` (A9_PLAN §0.3).
   * Named `default` deliberately — the authoring identity is the value `1`. */
  default: number;
  min: number;
  max: number;
}

/** A host-exposed COLOR parameter (schemaVersion 8, COLOR_PARAM_PLAN C1). A game
 * names the param and drives it live via `Effect.setColorParam(name, r, g, b, a)`;
 * the `tintParam` layer binding references one by `name`. Channels are inherently
 * [0,1]-clamped, so a color param carries NO `min`/`max` (unlike a scalar). The
 * authored `default` is the RGBA in force until the host first calls
 * `setColorParam`; the authoring identity is white `{1,1,1,1}` by convention
 * (an identity tint ⇒ byte-identical render, COLOR_PARAM_PLAN C4). */
export interface ColorParamDef {
  kind: "color";
  name: string;
  default: RGBAColor;
}

/** A host-exposed parameter: a `kind`-discriminated union of scalar and color
 * (schemaVersion 8, COLOR_PARAM_PLAN C1). */
export type ParamDef = ScalarParamDef | ColorParamDef;

export interface ParticleDoc {
  schemaVersion: 8;
  meta: ParticleMeta;
  duration: number;
  looping: boolean;
  seed: number;
  /** Host-exposed scalar parameters (schemaVersion 6, A9). Empty = none (the
   * inert migration default; a v5 doc migrates to `params: []`). */
  params: ParamDef[];
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

export const BLEND_MODES: readonly BlendMode[] = ["normal", "add", "multiply", "screen", "erase"];
export const EMIT_FROM: readonly EmitFrom[] = ["volume", "surface"];
export const EASES: readonly Ease[] = ["linear", "easeIn", "easeOut", "easeInOut", "step"];
export const FLIPBOOK_MODES: readonly Flipbook["mode"][] = ["loop", "once", "random"];
export const SHAPE_KINDS: readonly Shape["kind"][] = ["point", "circle", "cone", "rect", "edge", "texture"];
export const SIM_SPACES: readonly SimSpace[] = ["local", "world"];
export const ARC_MODES: readonly ArcMode[] = ["random", "loop", "pingPong", "burstSpread"];
export const SUB_TRIGGERS: readonly SubTrigger[] = ["birth", "death", "collision"];
export const ATTRACTOR_FALLOFFS: readonly AttractorFalloff[] = ["none", "linear", "smooth"];

/** Current schema version this build understands. */
export const CURRENT_SCHEMA_VERSION = 8;
