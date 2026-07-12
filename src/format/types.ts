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

/** Initial-velocity basis for a polyline spawn shape (schemaVersion 10, B1). */
export type PolylineDirection = "normal" | "outward" | "random";

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
      kind: "polyline";
      /** schemaVersion 10. Ordered vertex list, `2 ≤ length ≤ 64` (the 64 cap
       * mirrors the mask-dimension bound and keeps the length-CDF cheap). Each
       * x/y finite. Particles are born uniformly along the TOTAL arc length (a
       * long segment gets proportionally more particles), reusing the already-
       * drawn `uPos1` — zero new PRNG draws (B1). `edge` is a one-segment
       * horizontal special case. */
      points: Vec2[];
      /** schemaVersion 10. When true a final wrap segment `points[n−1] →
       * points[0]` joins the length-CDF, so an N-point outline emits around all
       * N edges. */
      closed: boolean;
      /** schemaVersion 10. Initial-velocity basis. `normal` = the CCW normal of
       * the spawned segment (a left→right segment emits up, `dirDeg −90` — the
       * `edge` convention); `outward` = away from the polygon centroid (mean of
       * `points`, natural for a `closed` outline, mirroring `circle`); `random` =
       * `uDir·360` (point/texture behavior). */
      direction: PolylineDirection;
      /** Kept for Shape-union uniformity (no effect — a polyline spawns along its
       * points, not a volume/surface split; E37 note). */
      emitFrom: EmitFrom;
    }
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

/** Coherent, spatially-uniform wind with time-varying gusts (schemaVersion 10,
 * B6). Unlike `noise` (a per-position `curl2` field, deliberately de-coherent),
 * every live particle feels the SAME wind vector at any instant — leaves surge as
 * one. The vector is a pure function of the effect clock (zero PRNG draws): at sim
 * time `clock`, `gust = 1 + gustAmount·sin(2π·gustFrequency·clock)`,
 * `w = strength(ageNorm)·gust`, added as acceleration into stored velocity
 * `vx += w·cos(direction)·dt`, `vy += w·sin(direction)·dt` — physical like
 * gravity, applied AFTER gravity and BEFORE the attractor block so drag and
 * limitVelocity damp it (see FORMAT_SPEC E40 / the normative motion order). null =
 * off (the migration default). Host-param bindable as of schemaVersion 11 (WINDP)
 * via the two `wind…Param` fields below (application lands with the runtime). */
export interface WindConfig {
  /** Wind direction in degrees clockwise from +x (Pixi convention). Finite. */
  direction: number;
  /** Base magnitude px/s² over the particle's ageNorm; constant/curve only
   * (`checkScalarTrackNoRange` — no per-particle range mode, zero draws, same
   * ruling as `noise.strength`). */
  strength: ScalarTrack;
  /** Gusts per second (Hz); `≥ 0`. `0` = steady wind (the sine term is constant). */
  gustFrequency: number;
  /** Depth of the gust modulation in `[0, 1]`; `0` = no gust. */
  gustAmount: number;
  /** Host-parameter binding for wind `strength` (schemaVersion 11, WINDP). Names a
   * scalar `ParticleDoc.params` entry whose current value **multiplies** the
   * evaluated strength track each step — the MULTIPLIER convention, exactly like
   * `sizeParam`/`speedParam`, so the **authoring identity is `1`** (a param at its
   * default `1` is an IEEE-exact ×1 no-op ⇒ byte-identical render). `null`/absent =
   * unbound = the untouched pre-v11 code path (P1/P2). */
  windStrengthParam: string | null;
  /** Host-parameter binding for wind `direction` (schemaVersion 11, WINDP). Names a
   * scalar `ParticleDoc.params` entry whose current value is **added** to
   * `direction` as a DEGREE OFFSET each step — effective direction =
   * `direction + param`. This is the FIRST **offset-semantics** knob (a multiplier
   * is meaningless for an angle): the OFFSET convention, so the **authoring identity
   * is `0`** (a param at default `0` is an IEEE-exact +0 no-op ⇒ byte-identical; the
   * authored base composes with the game's live swing and wraps naturally through
   * cos/sin). `null`/absent = unbound = the untouched pre-v11 path (P1/P2). */
  windDirectionParam: string | null;
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

/** Scale a particle's INITIAL values by how fast the EMITTER is moving, evaluated
 * AT SPAWN (schemaVersion 10, B5) — "a car kicks up bigger, longer-lived dust the
 * faster it drives." Modeled on `bySpeed` but keyed on emitter speed (the
 * already-pushed `emVX/emVY`, zero PRNG draws) and applied at spawn to the drawn
 * `size`/`speed`/`life` scalars. `t = clamp01((emitterSpeed − min)/(max − min))`
 * (a hard step when `min === max`, the `bySpeed` ruling); each non-null track
 * multiplies its drawn init value. Constant/curve only (`checkScalarTrackNoRange`)
 * — the value is per-spawn-step, shared by every particle spawned that step, so a
 * per-particle range mode has no meaning. Applied BEFORE the A9 param multiply
 * (order pinned for legibility; multiplies commute). null = off (the migration
 * default). Inert unless the host drives the emitter via `setEmitterPosition`
 * (emitter speed is 0 otherwise — see FORMAT_SPEC E39). NOT host-param bindable
 * (A9 size/speed/lifeParam already cover per-instance control). */
export interface ByEmitterSpeedConfig {
  /** Emitter-speed window (px/s) normalized to `t ∈ [0,1]`. */
  range: { min: number; max: number };
  /** Multiplier on the drawn init size; null = no size response. */
  size: ScalarTrack | null;
  /** Multiplier on the drawn init speed; null = no speed response. */
  speed: ScalarTrack | null;
  /** Multiplier on the drawn init lifetime; null = no life response. */
  life: ScalarTrack | null;
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
  /** On any collision hit, kill the particle immediately — the sim folds a full
   * `lifetime` into `ageLoss` so it dies at this step's age/kill stage
   * (schemaVersion 10, B3). This is `lifetimeLoss: 1` made explicit and
   * orthogonal to bounce (it can fire with bounce/dampen at 0). Migration injects
   * `false` (the untouched pre-v10 path). A shattered particle still records the
   * collision event AND reaches its death event the same step, so it can fire
   * both a collision-trigger and a death-trigger sub-emitter (the attractor
   * `killRadius` precedent — see FORMAT_SPEC E38). */
  killOnCollide: boolean;
  /** Impact-speed threshold (px/s) at or above which `killOnCollide` fires
   * (schemaVersion 10, B3): the pre-impact speed `√(vx²+vy²)` read before the
   * reflect. Below it the particle bounces/dampens normally — "hard hits shatter,
   * soft hits settle." `0` = always kill. Finite, `≥ 0`. Migration injects `0`.
   * Ignored when `killOnCollide` is false. */
  minKillSpeed: number;
}

/** An axis-aligned rectangle in the layer's sim frame (schemaVersion 10, B3),
 * used for `killZones`. `width`/`height` are extents (> 0), not far corners;
 * the rect covers `[x, x+width] × [y, y+height]`. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** Inherit the parent particle's COLOR into each child (schemaVersion 9,
   * RIBBON_INHERIT_PLAN I1/I2). At trigger time the parent's sim-side RGBA is
   * captured — its over-life gradient at ageNorm × startColor tint (including any
   * `hueJitter` hue rotation), EXCLUDING bySpeed and host params (those are
   * render-only surfaces, documented). At child spawn that captured RGBA
   * multiplies a dedicated inherit-color channel (I3). `false` = the untouched
   * pre-v9 path. */
  inheritColor: boolean;
  /** Inherit the parent particle's SIZE into each child (schemaVersion 9,
   * RIBBON_INHERIT_PLAN I1/I2). What is captured is the parent's DIMENSIONLESS
   * over-life size FACTOR (`evalScalarTrack(overLifetime.size, ageNorm, rand0)`,
   * 1 when the track is null) — NOT the px size (px × px is nonsense; the factor
   * gives "a shrinking parent spawns smaller children"). At child spawn the drawn
   * size is multiplied by that factor (I3). `false` = the untouched pre-v9 path. */
  inheritSize: boolean;
  /** Inherit the parent particle's ROTATION into each child (schemaVersion 9,
   * RIBBON_INHERIT_PLAN I1/I2). The parent's current rotation in degrees is
   * captured and ADDED to the child's drawn rotation at spawn (additive, I3).
   * `false` = the untouched pre-v9 path. */
  inheritRotation: boolean;
}

/** Per-particle vs single-ribbon rendering of a layer's trail (schemaVersion 9,
 * RIBBON_INHERIT_PLAN R1). `perParticle` = the pre-v9 behavior: each particle
 * carries its own polyline of recent positions. `connect` = ONE ribbon threaded
 * through ALL of the layer's currently-live particles, ordered oldest→newest by a
 * stable per-particle spawn ordinal (a Shuriken-style connected ribbon / Effekseer
 * track — energy beams, lightning, chains). In `connect` mode `maxPoints` and
 * `minVertexDistance` are documented-IGNORED (no position history is kept; they
 * remain in the shape for round-trip simplicity — see FORMAT_SPEC). */
export type TrailMode = "perParticle" | "connect";

/** Per-particle ribbon trail (schemaVersion 3). Polyline of the last
 * `maxPoints` positions; `width` over trail t (0 = head); `color` over trail
 * length (null = the particle's current color). */
export interface TrailConfig {
  /** Trail topology (schemaVersion 9, RIBBON_INHERIT_PLAN R1); migration injects
   * `"perParticle"`. In `"connect"` mode this layer emits ONE ribbon through all
   * live particles (oldest→newest by stable spawn ordinal) and `maxPoints` /
   * `minVertexDistance` below are documented-ignored. */
  mode: TrailMode;
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
  /** Coherent gusting wind (schemaVersion 10, B6); null = off. */
  wind: WindConfig | null;
  /** Speed-driven size/color/rotation remaps (schemaVersion 3); null = off. */
  bySpeed: BySpeedConfig | null;
  /** Scale initial size/speed/life by emitter speed at spawn (schemaVersion 10,
   * B5); null = off. */
  byEmitterSpeed: ByEmitterSpeedConfig | null;
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
  /** Death regions in the layer's sim frame (schemaVersion 10, B3); null = none.
   * A particle whose integrated position lands inside ANY rect gets
   * `ageLoss += lifetime` (dies this step) — distinct from a keep-inside collision
   * rect (which bounces at the boundary). Max 8 rects, each `width/height > 0`.
   * Local-space zones ride the emitter (E20 lineage). */
  killZones: Rect[] | null;
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
  schemaVersion: 11;
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
export const SHAPE_KINDS: readonly Shape["kind"][] = ["point", "circle", "cone", "rect", "edge", "polyline", "texture"];
export const POLYLINE_DIRECTIONS: readonly PolylineDirection[] = ["normal", "outward", "random"];
export const SIM_SPACES: readonly SimSpace[] = ["local", "world"];
export const ARC_MODES: readonly ArcMode[] = ["random", "loop", "pingPong", "burstSpread"];
export const SUB_TRIGGERS: readonly SubTrigger[] = ["birth", "death", "collision"];
export const ATTRACTOR_FALLOFFS: readonly AttractorFalloff[] = ["none", "linear", "smooth"];
export const TRAIL_MODES: readonly TrailMode[] = ["perParticle", "connect"];

/** Current schema version this build understands. */
export const CURRENT_SCHEMA_VERSION = 11;
