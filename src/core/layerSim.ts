// Per-layer simulation: spawning (fixed PRNG draw order, §2.7) and the per-step
// integration of motion (§2.4), rotation (§2.5), ageing, and death. Emission
// *timing* (when to call spawn) lives in Effect (§2.8); this class only knows
// how to make one particle and how to advance the ones it has.
import type { Layer, RGBAColor } from "../format/types.js";
import { mulberry32, type Rng } from "./prng.js";
import { drawScalarInit, evalScalarTrack, evalGradient, hueRotateRGB, type RGBA } from "./tracks.js";
import { ParticlePool } from "./pool.js";
import { sampleShape, type SpawnSample } from "./shapes.js";
import { buildMaskSampler, type MaskSampler } from "./maskSampler.js";
import { buildPolylineSampler, type PolylineSampler } from "./polylineSampler.js";
import { curl2 } from "./noise.js";

const RAD = Math.PI / 180;
// De-synchronizes the noise phase of point/co-located spawns so fireflies from
// one emitter don't wander in lockstep (§0.3). Multiplies the per-particle phase
// into the x sample coordinate only.
const PHASE_OFF = 37.0;
// Offset from the layer seed to the noise seed (§0.3), so the turbulence field
// is decorrelated from the spawn PRNG stream.
const NOISE_SEED_OFFSET = 0x9e3779b9;

// Reusable scratch for the two gradient evaluations of a gradients-mode
// startColor draw (§M5). Spawn is synchronous and non-reentrant, so a pair of
// module-level temporaries avoids a per-spawn allocation.
const SC_A: RGBA = { r: 0, g: 0, b: 0, a: 0 };
const SC_B: RGBA = { r: 0, g: 0, b: 0, a: 0 };
// Reusable scratch for a sub-emitter inheritance capture (v9 I4): the parent's
// sim-side color is evaluated into it once per captured event. Synchronous and
// non-reentrant like the spawn scratches above.
const IC: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export class LayerSim {
  readonly layer: Layer;
  readonly pool: ParticlePool;
  private rng: Rng;
  /** The layer's base seed (schemaVersion 3); the noise field derives its own
   * seed from this. Kept so reset() and noise sampling agree on the field. */
  private layerSeed: number;
  /** Effect clock at the start of the current step, pushed by Effect.advance
   * (schemaVersion 3). Scrolls the noise field over effect time (§0.3). */
  private clock = 0;
  /** Normalized effect time at the current emission interval's start, pushed by
   * Effect.emitInterval / emitDistance (schemaVersion 3, §M5), same precedent as
   * evalRate's normalized time. A gradients-mode startColor draw samples both
   * gradients at this t, so bursts and continuous spawns in one interval share it.
   * Zero-cost for layers without a startColor module. */
  private spawnTNorm = 0;
  /** True if a spawn was dropped since the flag was last reset (E7). */
  capped = false;
  /** A9 host-parameter multipliers (schemaVersion 6), OWNED by the Effect, which
   * resolves them from its param store and pushes them EVENT-DRIVEN — at
   * construction (before prewarm, so authored defaults are in force from the
   * first frame) and on every effective `setParam` (so the render-path knobs are
   * frame-live even while paused). `null` = the knob is unbound OR names an
   * undeclared param ⇒ the untouched v5 code path. `speed`/`life` scale the drawn
   * init value at spawn (FUTURE SPAWNS only — baked into pool state); `gravity`
   * scales the hoisted gx/gy in `update()` (LIVE); `size`/`opacity` are read by
   * `render.ts` (LIVE, per-call). A doc with no params never sets these, so every
   * existing layer keeps them null and its hot loops stay instruction-identical.
   * Plain scalars, not pool columns — they never touch the statehash; params
   * persist, so `reset()` deliberately leaves them in place. */
  speedParamMul: number | null = null;
  lifeParamMul: number | null = null;
  gravityParamMul: number | null = null;
  sizeParamMul: number | null = null;
  opacityParamMul: number | null = null;
  /** schemaVersion 8 color-tint multiplier (COLOR_PARAM_PLAN C2), OWNED by the
   * Effect exactly like the five scalar muls above: resolved from the color-param
   * store and pushed EVENT-DRIVEN (construction + every effective setColorParam).
   * `null` = the layer's `tintParam` is unbound OR names a non-color param ⇒
   * render.ts takes the untouched pre-v8 path (never a multiply-by-white). When
   * non-null it is the STORED RGBA reference (runtime-owned, mutated in place), so
   * render multiplies each finished-chain channel by it. Not a pool column — it
   * never touches the statehash (tint is render-only, C4); params persist, so
   * reset() deliberately leaves it in place. */
  tintParamMul: RGBAColor | null = null;
  /** Continuous-emission fractional accumulator (§2.8), owned by Effect. */
  acc = 0;
  /** Rate-over-distance fractional accumulator (schemaVersion 2), owned by Effect. */
  accDist = 0;
  /** Burst-cycle probability-gate outcomes for the CURRENT loop pass
   * (schemaVersion 3, §0.2): `burstGates[burstIndex][cycle]` ∈ {0 = not yet
   * rolled, 1 = fired, 2 = suppressed}. A gated cycle rolls ONCE (one draw) when
   * it first becomes due and the outcome is recalled for its remaining
   * sub-events — a spread window spanning several steps is all-or-nothing.
   * Lazily allocated on the first gated roll, so a probability-1 document
   * carries zero state. Cleared on reset() and by Effect at every looping wrap
   * (each pass re-rolls every cycle). */
  private burstGates: Uint8Array[] | null = null;

  // Emitter motion segment for the current step (schemaVersion 2). Effect pushes
  // these before emission; a world-space spawn interpolates its position along
  // [emS, emE] by its step fraction and inherits `emV` (emitter velocity). Zero
  // for a stationary emitter and for every local-space layer, keeping the local
  // spawn path byte-identical to v1.
  private emSX = 0;
  private emSY = 0;
  private emEX = 0;
  private emEY = 0;
  private emVX = 0;
  private emVY = 0;

  // Host attractor for the current step (schemaVersion 4, §0.3b). Effect pushes
  // these before update, ALREADY converted into this layer's sim frame (E24:
  // world layers as-is, local layers relative to the step-end emitter). A radius
  // of 0 means "inactive" — the host force is skipped, so a layer with no host
  // attractor (or a cleared one) keeps the motion block instruction-identical.
  // Scaled per particle by `layer.attractorInfluence`; zero PRNG draws.
  private hostAttractorX = 0;
  private hostAttractorY = 0;
  private hostAttractorStrength = 0;
  private hostAttractorRadius = 0;

  /** Sub-emitter event recorders (schemaVersion 3, M8). Each is set by the Effect
   * iff the layer feeds a sub-emitter with the matching trigger, AND forced false
   * during prewarm (event capture belongs to the visible cycle, E19). A false flag
   * makes recording a single boolean check — zero-cost when off. `recordCollision`
   * landed in M7 (its recorder was already wired); birth/death are new here. */
  recordBirthEvents = false;
  recordDeathEvents = false;
  recordCollisionEvents = false;
  /** Sub-emitter inheritance capture gate (schemaVersion 9, RIBBON_INHERIT_PLAN
   * I4). Set ONCE by the Effect (buildSubEmitterPlan) iff this parent layer owns
   * ≥1 ref with any inherit flag; when true every recorded event carries SIX extra
   * floats after the quintuple — the captured size FACTOR, rotation deg, and RGBA
   * (§pushInherit) — so the flat quintuple (stride 5) grows to stride 11. False for
   * every non-inheriting parent, so its scratch stays flat and capture does no work
   * (the null-path pattern). Constant per layer, so unlike the record flags the
   * Effect never toggles it per step. */
  captureInherit = false;
  /** Per-layer event scratches (schemaVersion 3, M8). Flat quintuples
   * `[x, y, vx, vy, ordinal]`: the event particle's position, stored velocity, and
   * its STABLE monotone ordinal (`pool.ordinal` — not the live index, which
   * swap-remove can reassign before the Effect reads the scratch). When
   * `captureInherit` is set (v9 I4) each record grows to an 11-tuple, appending the
   * six captured inherit floats (size factor, rotation, r, g, b, a — §pushInherit);
   * the Effect reads the matching stride. A plain
   * `number[]` (not a typed array) because the per-step event count is unbounded a
   * priori and `length = 0` reuse keeps it allocation-free after warming to the
   * per-step high-water mark. NULL until the first recorded event of that kind, so
   * a non-parent layer allocates nothing. The Effect consumes all three ONCE after
   * update+emit and they are cleared at the top of each `update()` so they never
   * leak across steps (birth fills during emit, after the clear; death/collision
   * fill during update, after the clear). */
  birthEvents: number[] | null = null;
  deathEvents: number[] | null = null;
  collisionEvents: number[] | null = null;
  /** Per-layer monotone spawn counter (schemaVersion 3, M8). Every particle this
   * layer spawns gets `pool.ordinal[i] = spawnCounter++` when the ordinal column
   * exists (i.e. the layer is a sub-emitter parent). Advances during prewarm too —
   * prewarmed particles are real and can fire death triggers later, so their
   * ordinals must be assigned; only event CAPTURE is suppressed during prewarm.
   * Reset to 0 by reset(). */
  private spawnCounter = 0;

  /** Emit-from-texture mask sampler (schemaVersion 4, §0.3a). Config-derived and
   * built ONCE in the constructor: non-null only for a `kind === "texture"` layer
   * with a usable mask, null for every other kind AND for any E23-corrupt mask
   * (the spawn path then falls back to point-shape spawning via shapes.ts). It
   * carries no per-run state, so reset() does not rebuild it. */
  private readonly maskSampler: MaskSampler | null;

  /** Polyline arc-length sampler (schemaVersion 10, B1 / §B1). Config-derived and
   * built ONCE in the constructor, mirroring maskSampler: non-null only for a
   * `kind === "polyline"` layer with positive total arc length, null for every
   * other kind AND for an E37 degenerate polyline (the spawn path then falls back
   * to point-shape spawning via shapes.ts). Reuses the already-drawn `uPos1`/`uDir`
   * — zero new PRNG draws — and carries no per-run state, so reset() leaves it. */
  private readonly polylineSampler: PolylineSampler | null;

  constructor(layer: Layer, layerSeed: number, inheritColorTarget = false) {
    this.layer = layer;
    // Optional pool columns are allocated only for the modules this layer uses
    // (§0.2): a layer with every schemaVersion-3 module null keeps the exact v2
    // pool footprint. The four velocity-over-lifetime range uniforms (draws
    // 15–18) are each allocated iff their track is non-null.
    const vel = layer.overLifetime.velocity;
    this.pool = new ParticlePool(layer.emission.maxParticles, {
      noise: layer.noise !== null,
      velX: vel.x !== null,
      velY: vel.y !== null,
      velOrbital: vel.orbital !== null,
      velRadial: vel.radial !== null,
      // Draw 19 (tint columns) and draws 20–21 (flip bitmask) allocate their
      // pool columns only when the owning module is set (§0.2, §M5).
      tint: layer.startColor !== null,
      flip: layer.randomFlip !== null,
      // A layer with sub-emitters needs a stable per-particle ordinal to key its
      // event child streams (§0.2, M8). A connect-mode trail layer needs the SAME
      // ordinal to thread its ribbon oldest→newest, swap-remove-immune (v9 R3):
      // reuse the M8 mechanism (assigned from spawnCounter, zero PRNG draws). No
      // existing document has connect mode, so this leaves every existing layer's
      // pool footprint — and its statehash — unchanged.
      ordinal: layer.subEmitters !== null || (layer.trail !== null && layer.trail.mode === "connect"),
      // A per-particle trail layer allocates a ring buffer of `maxPoints` points
      // (§M9); a connect-mode trail keeps NO position history (v9 R1/R2) and a
      // trail-null layer allocates nothing (0 = off). Draws nothing. `!== "connect"`
      // (not `=== "perParticle"`) keeps a legacy trail with an absent mode on the
      // per-particle path.
      trailMaxPoints: layer.trail !== null && layer.trail.mode !== "connect" ? layer.trail.maxPoints : 0,
      // Inherit-color RGBA columns (v9 I3): allocated iff a sibling layer's
      // sub-emitter ref names THIS layer with inheritColor (the Effect resolves the
      // cross-layer target set and passes the flag in). Zero-cost otherwise.
      inheritColor: inheritColorTarget,
    });
    this.rng = mulberry32(layerSeed);
    this.layerSeed = layerSeed;
    // Emit-from-texture: decode + CDF-build the mask once (§0.3a). Null for every
    // non-texture layer, so no existing document allocates or pays for this.
    this.maskSampler = layer.shape.kind === "texture" ? buildMaskSampler(layer.shape) : null;
    // Polyline: precompute the per-segment arc-length CDF once (§B1). Null for every
    // non-polyline layer AND for a degenerate (zero-length) polyline, so no existing
    // document allocates or pays for this and the E37 point-fallback stays in play.
    this.polylineSampler = layer.shape.kind === "polyline" ? buildPolylineSampler(layer.shape) : null;
  }

  get count(): number {
    return this.pool.count;
  }

  reset(layerSeed: number): void {
    this.rng = mulberry32(layerSeed);
    this.layerSeed = layerSeed;
    this.pool.clear();
    this.capped = false;
    this.acc = 0;
    this.accDist = 0;
    // Forget every burst-gate outcome: a reset/seek re-simulates from t=0 with a
    // fresh stream, so identical draws rebuild identical gate state (§0.2).
    this.burstGates = null;
    // Restart the ordinal counter so a re-simulation from t=0 assigns identical
    // ordinals (the event child streams depend on them, §0.2, M8).
    this.spawnCounter = 0;
    // Drop any recorded events; the record flags are owned by the Effect (M8) and
    // survive a reset, but the per-step scratches do not.
    if (this.birthEvents !== null) this.birthEvents.length = 0;
    if (this.deathEvents !== null) this.deathEvents.length = 0;
    if (this.collisionEvents !== null) this.collisionEvents.length = 0;
  }

  /** Push the effect clock (step start) into this sim (schemaVersion 3); the
   * noise field scrolls with it. Zero-cost for layers without noise. */
  setClock(t: number): void {
    this.clock = t;
  }

  /** Push the normalized effect time at the current emission interval's start
   * (schemaVersion 3, §M5). Effect calls this before the interval's spawns; a
   * gradients-mode startColor draw samples its two gradients at this t. Zero-cost
   * for layers without a startColor module. */
  setSpawnTNorm(t: number): void {
    this.spawnTNorm = t;
  }

  /** Record the emitter's motion over the current step (schemaVersion 2). */
  setEmitterStep(sx: number, sy: number, ex: number, ey: number, vx: number, vy: number): void {
    this.emSX = sx;
    this.emSY = sy;
    this.emEX = ex;
    this.emEY = ey;
    this.emVX = vx;
    this.emVY = vy;
  }

  /** Push the host attractor for the current step (schemaVersion 4, §0.3b),
   * already converted into this layer's sim frame (E24). A `radius` of `null` or
   * `<= 0` marks it inactive (the per-particle host force is skipped). Mirrors the
   * `setEmitterStep` setter pattern; the value in force at update() time applies
   * for the whole step (last call wins). */
  setHostAttractor(x: number, y: number, strength: number, radius: number | null): void {
    this.hostAttractorX = x;
    this.hostAttractorY = y;
    this.hostAttractorStrength = strength;
    this.hostAttractorRadius = radius !== null && radius > 0 ? radius : 0;
  }

  /**
   * Roll — or recall — the probability gate for one burst cycle (§0.2). The
   * FIRST call for a (burst, cycle) in a loop pass takes exactly ONE draw from
   * this layer's spawn PRNG stream, immediately before that cycle's spawn draws
   * (which is why the rng stays private to LayerSim and Effect goes through this
   * narrow hook); the cycle fires iff `draw < probability`. Subsequent calls —
   * a spread window spanning several steps makes the same cycle "due" in several
   * emit intervals — recall the remembered outcome with ZERO draws, so a gated
   * cycle is all-or-nothing across steps. Effect never calls this when
   * `probability === 1` (zero draws, zero state — the migration default), and
   * never during prewarm (bursts are suppressed there, E5), so prewarm cannot
   * consume gate state.
   */
  burstGateFired(burstIndex: number, cycle: number, probability: number): boolean {
    const gates = (this.burstGates ??= []);
    let row = gates[burstIndex];
    if (row === undefined || row.length <= cycle) {
      const grown = new Uint8Array(cycle + 1);
      if (row !== undefined) grown.set(row);
      gates[burstIndex] = row = grown;
    }
    const s = row[cycle]!;
    if (s !== 0) return s === 1;
    const fired = this.rng() < probability;
    row[cycle] = fired ? 1 : 2;
    return fired;
  }

  /** Forget all burst-gate outcomes. Effect calls this at every looping wrap so
   * each loop pass re-rolls every probability-gated cycle (§0.2, M4). */
  clearBurstGates(): void {
    const gates = this.burstGates;
    if (gates !== null) {
      for (const row of gates) row?.fill(0);
    }
  }

  /**
   * Spawn one particle from this layer's OWN emission stream. Performs exactly the
   * fixed 13 draws in the normative order regardless of shape/mode/space (§2.7). If
   * the pool is full the spawn is dropped with no draws (deterministic) and
   * `capped` is set; returns false.
   *
   * `f` ∈ [0,1] is the spawn's fractional position through the current step
   * (schemaVersion 2). It is used ONLY by world-space layers, to interpolate the
   * spawn position along the emitter's motion segment; local-space layers ignore
   * it, so their spawn path is byte-identical to v1.
   *
   * `arcT` (schemaVersion 3) is a driven arc-angle fraction for circle/cone shapes
   * with a non-random `arcMode`; `-1` (the default) leaves the drawn angle uniform
   * in charge. It never changes the draw count — the angle uniform is always drawn
   * and, when `arcT` overrides it, simply discarded (§0.2, M4).
   */
  spawn(f = 1, arcT = -1): boolean {
    // Own spawns pass the identity inherit tuple (size ×1, rotation +0, RGBA 1) so
    // the pre-v9 spawn body is byte-identical (the multiply/add are gated off).
    return this.spawnImpl(this.rng, f, arcT, false, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1);
  }

  /**
   * Spawn one CHILD particle from a sub-emitter EVENT stream (schemaVersion 3, M8).
   * Runs the identical spawn body as `spawn()` — same fixed 13 + conditional draw
   * order against THIS (child) layer's config — but draws exclusively from the
   * supplied `rng` (the per-event stream, §0.2), so the child layer's OWN emission
   * stream is never touched. The particle is placed at its shape-sampled offset
   * PLUS `(ox, oy)` (the event location already converted into this layer's sim
   * frame, E22) and its velocity gets `(bvx, bvy)` added (the caller pre-scales the
   * event velocity by `entry.inheritVelocity`; velocity is translation-invariant so
   * no frame conversion is needed).
   *
   * Mirrors `spawn()`'s early return: when the pool is full it drops the child with
   * NO draws and sets `capped` (E7). This is deterministic — the child pool's fill
   * state is itself a deterministic function of the seed and dt sequence, so
   * early-return-before-draws consumes a deterministic number of draws per event.
   * Sub-emitter spawns never fire an arc sweep, so `arcT` is always -1.
   *
   * `inhSize`/`inhRot`/`inhR..inhA` carry the inherited-property application (v9
   * I3): the drawn size is multiplied by `inhSize` and the drawn rotation gets
   * `inhRot` added (both baked into pool state, both gated off at the identity
   * values 1 / 0 so a non-inheriting child is byte-identical), and the RGBA is
   * written into the inherit-color columns when they exist (else discarded). The
   * caller resolves each per the child ref's flags, defaulting to identity — so
   * `spawnFrom(rng, ox, oy, bvx, bvy)` is the pre-v9 no-inherit call unchanged.
   * Applied AFTER every draw, so the PRNG stream is untouched (A9 discipline).
   */
  spawnFrom(
    rng: Rng,
    ox: number,
    oy: number,
    bvx: number,
    bvy: number,
    inhSize = 1,
    inhRot = 0,
    inhR = 1,
    inhG = 1,
    inhB = 1,
    inhA = 1,
  ): boolean {
    return this.spawnImpl(rng, 1, -1, true, ox, oy, bvx, bvy, inhSize, inhRot, inhR, inhG, inhB, inhA);
  }

  // Shared spawn body for both the own-emission path (`spawn`) and the sub-emitter
  // event path (`spawnFrom`). Keeping ONE body guarantees the two draw sequences
  // can never drift apart — a load-bearing determinism invariant (the child stream
  // must run the child layer's exact draw order). `fromEvent` selects the
  // position/velocity finalization: an event child is placed absolutely at
  // `shape + (ox, oy)` with `(bvx, bvy)` added, whereas an own spawn interpolates
  // along the emitter segment (world space) or stays local. Byte-identical to the
  // pre-M8 `spawn()` when `fromEvent` is false (the ordinal branch and the birth
  // recorder are both no-ops for a non-parent layer).
  private spawnImpl(rng: Rng, f: number, arcT: number, fromEvent: boolean, ox: number, oy: number, bvx: number, bvy: number, inhSize: number, inhRot: number, inhR: number, inhG: number, inhB: number, inhA: number): boolean {
    const p = this.pool;
    if (p.count >= p.capacity) {
      this.capped = true;
      return false;
    }
    const init = this.layer.initial;

    // 1) position (2 draws), 2) direction (1 draw)
    const uPos1 = rng();
    const uPos2 = rng();
    const uDir = rng();
    // 3) life, speed, size, rotation, angularVelocity (1 draw each, always)
    let life = drawScalarInit(init.life, rng);
    let speed = drawScalarInit(init.speed, rng);
    let size = drawScalarInit(init.size, rng);
    let rot = drawScalarInit(init.rotation, rng);
    const angVel = drawScalarInit(init.angularVelocity, rng);
    // B5 by-emitter-speed (schemaVersion 10, §B5): scale the DRAWN size/speed/life
    // by a track lookup at the emitter-speed-normalized t. Emitter speed is the
    // pure scalar √(emVX²+emVY²) — the velocity setEmitterStep already pushed for
    // EVERY layer (world or local), so ZERO new PRNG draws (TIERB T7). Constant/
    // curve tracks only (validator-enforced checkScalarTrackNoRange), evaluated with
    // rand 0 — the value is per-spawn-STEP, shared by every particle spawned this
    // step. ORDER PINNED (TIERB T4): this multiply runs BEFORE the A9 param multiply
    // below, so the host size/speed/lifeParam stays the final per-instance knob
    // layered on top of the authored emitter-speed response (multiplies commute
    // mathematically; the order is pinned for legibility, like the color chain).
    // The `min === max` degenerate is a HARD STEP at the shared bound (t=1 at/above,
    // else 0), mirroring the bySpeed render ruling (render.ts `tSpeed`). Null-gated:
    // a byEmitterSpeed-null layer is instruction-identical, and since no existing
    // document carries the module no determinism digest moves. INERT for a static
    // emitter — emVX/emVY are 0 unless the host drives setEmitterPosition, so t=0
    // (FORMAT_SPEC E39 authoring note).
    const bes = this.layer.byEmitterSpeed;
    if (bes !== null) {
      const emSpeed = Math.sqrt(this.emVX * this.emVX + this.emVY * this.emVY);
      const besSpan = bes.range.max - bes.range.min;
      const tEm = besSpan > 0 ? Math.min(1, Math.max(0, (emSpeed - bes.range.min) / besSpan)) : emSpeed >= bes.range.max ? 1 : 0;
      if (bes.size !== null) size *= evalScalarTrack(bes.size, tEm, 0);
      if (bes.speed !== null) speed *= evalScalarTrack(bes.speed, tEm, 0);
      if (bes.life !== null) life *= evalScalarTrack(bes.life, tEm, 0);
    }
    // A9 host params (schemaVersion 6): scale the DRAWN life/speed by their bound
    // param AFTER the draw — the PRNG stream is untouched (zero new draws), so a
    // bound-at-1 doc is byte-identical to an unbound one. Future spawns only: the
    // scaled value bakes into `p.lifetime` / the `vx,vy` launch below and never
    // retroactively changes an already-alive particle. Null (unbound) leaves the
    // spawn path v5-instruction-identical.
    if (this.lifeParamMul !== null) life *= this.lifeParamMul;
    if (this.speedParamMul !== null) speed *= this.speedParamMul;
    // 4) over-lifetime range uniforms rand0..3, then 5) flipbook frameRand
    const r0 = rng();
    const r1 = rng();
    const r2 = rng();
    const r3 = rng();
    const frameRand = rng();
    // Draw 14 (§0.2): one noise-phase uniform, appended AFTER frameRand and ONLY
    // when the layer has a noise module. A null-noise layer draws nothing here,
    // keeping its spawn stream byte-identical to v2.
    const noisePhase = this.layer.noise !== null ? rng() : 0;
    // Draws 15–18 (§0.2): one range-mode uniform per non-null velocity-over-
    // lifetime track, in the fixed order x, y, orbital, radial, appended AFTER
    // the noise phase. Each draw happens iff its track is non-null, regardless of
    // the track's mode (constant/curve draw and discard — drawScalarInit rule).
    // A layer with all four tracks null draws nothing here.
    const vel = this.layer.overLifetime.velocity;
    const velRandX = vel.x !== null ? rng() : 0;
    const velRandY = vel.y !== null ? rng() : 0;
    const velRandOrbital = vel.orbital !== null ? rng() : 0;
    const velRandRadial = vel.radial !== null ? rng() : 0;
    // Draw 19 (§0.2): one uniform for the per-particle start-color tint, ONLY when
    // the layer has a startColor module. In gradients mode it lerps the two
    // gradients (each sampled at spawnTNorm) by the uniform; in palette mode it
    // indexes the colors, clamping the u→1 edge to the last entry (never n). The
    // result is a constant tint multiplier over the over-lifetime gradient (L7).
    const startColor = this.layer.startColor;
    let tintR = 1;
    let tintG = 1;
    let tintB = 1;
    let tintA = 1;
    if (startColor !== null) {
      const u = rng();
      if (startColor.mode === "palette") {
        const cols = startColor.colors;
        const col = cols[Math.min(cols.length - 1, Math.floor(u * cols.length))]!;
        tintR = col.r;
        tintG = col.g;
        tintB = col.b;
        tintA = col.a;
      } else if (startColor.mode === "gradients") {
        const a = evalGradient(startColor.a, this.spawnTNorm, SC_A);
        const b = evalGradient(startColor.b, this.spawnTNorm, SC_B);
        tintR = a.r + (b.r - a.r) * u;
        tintG = a.g + (b.g - a.g) * u;
        tintB = a.b + (b.b - a.b) * u;
        tintA = a.a + (b.a - a.a) * u;
      } else if (startColor.mode === "hueJitter") {
        // A6 hue jitter (§0.3c / E29): store a per-particle hue OFFSET in degrees,
        // drawn from the SAME draw-19 uniform `u` (no new draw). `u=0.5 ⇒ 0`, the
        // ends ⇒ ±degrees. The offset rides tintR; tintG/B/A carry neutral
        // placeholders (G=0, B=0, A=1 — the render side reads the offset from R
        // only and never multiplies these). render.ts hue-rotates the
        // over-lifetime gradient color by this offset instead of tinting.
        tintR = (u - 0.5) * 2 * startColor.degrees;
        tintG = 0;
        tintB = 0;
        tintA = 1;
      }
    }
    // Draws 20–21 (§0.2): two uniforms for the random-flip bitmask, ONLY when the
    // layer has a randomFlip module. bit 1 iff ux < flip.x, bit 2 iff uy < flip.y.
    const randomFlip = this.layer.randomFlip;
    let flipBits = 0;
    if (randomFlip !== null) {
      const ux = rng();
      const uy = rng();
      if (ux < randomFlip.x) flipBits |= 1;
      if (uy < randomFlip.y) flipBits |= 2;
    }
    // Draws 22–24 (TIER2_PLAN §0.2 / FORMAT_SPEC draws 22–24): the mask CDF index
    // (uIdx) and intra-pixel jitter (jx, jy), appended AFTER the flip draws and
    // taken ONLY for a texture shape. Drawn from the SAME `rng` as every draw
    // above (own-emission or sub-emitter event stream). The count is constant
    // regardless of mask size/validity — a corrupt/empty mask (E23) still takes
    // and discards these three, so the stream stays mask-content-independent.
    const isTexture = this.layer.shape.kind === "texture";
    const uIdx = isTexture ? rng() : 0;
    const jx = isTexture ? rng() : 0;
    const jy = isTexture ? rng() : 0;

    const i = p.spawn();
    // Position resolution: a usable mask samples the texture CDF (§0.3a); a usable
    // polyline samples its arc-length CDF (§B1, reusing the already-drawn uPos1/uDir
    // — no new draws); otherwise the shapes.ts switch handles every other kind AND
    // the E23 corrupt-mask / E37 degenerate-polyline fallbacks (point-shape
    // spawning). Each `kind ===` guard narrows the shape for its sampler and is
    // always true when that sampler !== null (a layer has exactly one kind).
    const shape = this.layer.shape;
    let s: SpawnSample;
    if (this.maskSampler !== null && shape.kind === "texture") {
      s = this.maskSampler.sample(uIdx, jx, jy, shape, uDir);
    } else if (this.polylineSampler !== null && shape.kind === "polyline") {
      s = this.polylineSampler.sample(uPos1, uDir);
    } else {
      s = sampleShape(shape, uPos1, uPos2, uDir, arcT);
    }
    const dirRad = s.dirDeg * RAD;
    let px = s.px;
    let py = s.py;
    let vx = speed * Math.cos(dirRad);
    let vy = speed * Math.sin(dirRad);
    if (fromEvent) {
      // Sub-emitter child (M8): place the particle at the event location (already
      // converted into this layer's sim frame, E22) plus its shape spread, and add
      // the inherited event velocity. The emitter-segment interpolation below is
      // NOT applied — the event location is absolute in this frame.
      px += ox;
      py += oy;
      vx += bvx;
      vy += bvy;
      // Inherited-property application (v9 I3), AFTER every draw so the PRNG stream
      // is untouched. Each is gated at its identity value (1 / 0) so a
      // non-inheriting event child bakes nothing and stays byte-identical (in
      // particular `rot += 0` never flips a -0 rotation). inheritSize bakes into
      // sizeInit; inheritRotation is additive; inheritColor is handled at the write.
      if (inhSize !== 1) size *= inhSize;
      if (inhRot !== 0) rot += inhRot;
    } else if (this.layer.space === "world") {
      // Spawn at the emitter's interpolated position along this step's segment,
      // and inherit a fraction of its velocity (schemaVersion 2). For a
      // stationary emitter both terms are zero — identical to local.
      px += this.emSX + (this.emEX - this.emSX) * f;
      py += this.emSY + (this.emEY - this.emSY) * f;
      const iv = this.layer.inheritVelocity;
      vx += iv * this.emVX;
      vy += iv * this.emVY;
    }
    p.x[i] = px;
    p.y[i] = py;
    p.velX[i] = vx;
    p.velY[i] = vy;
    p.age[i] = 0;
    p.lifetime[i] = life;
    p.sizeInit[i] = size;
    p.rotation[i] = rot;
    p.angVel[i] = angVel;
    p.rand0[i] = r0;
    p.rand1[i] = r1;
    p.rand2[i] = r2;
    p.rand3[i] = r3;
    p.frameRand[i] = frameRand;
    if (p.noisePhase !== null) p.noisePhase[i] = noisePhase;
    if (p.velRandX !== null) p.velRandX[i] = velRandX;
    if (p.velRandY !== null) p.velRandY[i] = velRandY;
    if (p.velRandOrbital !== null) p.velRandOrbital[i] = velRandOrbital;
    if (p.velRandRadial !== null) p.velRandRadial[i] = velRandRadial;
    if (p.tintR !== null) {
      p.tintR[i] = tintR;
      p.tintG![i] = tintG;
      p.tintB![i] = tintB;
      p.tintA![i] = tintA;
    }
    if (p.flipBits !== null) p.flipBits[i] = flipBits;
    // Inherit-color RGBA (v9 I3): written whenever the columns exist — the captured
    // parent RGBA for a child of an inheritColor ref, else the neutral 1,1,1,1
    // (an own spawn or a non-color event child), so those render unchanged. The
    // render multiply is null-gated on the same columns.
    if (p.inhR !== null) {
      p.inhR[i] = inhR;
      p.inhG![i] = inhG;
      p.inhB![i] = inhB;
      p.inhA![i] = inhA;
    }
    // Record the spawn position as the trail's first (head) point (§M9). Uses the
    // FINAL spawn coordinates (px, py — post world/event offset), so the ribbon
    // starts exactly where the particle renders. Zero draws; no-op without a trail.
    if (p.trail !== null) p.trail.spawn(i, px, py);
    // Assign the stable spawn ordinal (M8) when the column exists — a sub-emitter
    // parent OR a connect-mode trail layer (v9 R3, which orders its ribbon by it).
    // Advances during prewarm too (prewarmed particles can fire death triggers
    // later); only event CAPTURE is suppressed during prewarm. A no-op (zero draws,
    // no column) for every other layer, so the spawn stream is unchanged.
    let ordinal = 0;
    if (p.ordinal !== null) {
      ordinal = this.spawnCounter++;
      p.ordinal[i] = ordinal;
    }
    // Birth event (M8): record the parent's OWN births (not event children, which
    // are `fromEvent`). Gated on the recorder, which the Effect keeps false unless
    // this layer feeds a birth-trigger sub-emitter and it is not prewarming (E19).
    if (!fromEvent && this.recordBirthEvents) {
      const arr = (this.birthEvents ??= []);
      arr.push(px, py, vx, vy, ordinal);
      if (this.captureInherit) this.pushInherit(arr, i);
    }
    return true;
  }

  /**
   * Append the six captured inherit floats (size FACTOR, rotation deg, r, g, b, a)
   * to an event scratch (schemaVersion 9, RIBBON_INHERIT_PLAN I4). Called ONLY when
   * `captureInherit` is set, so a non-inheriting parent's scratch stays the flat
   * M8 quintuple. Reads the parent particle's state AT THE EVENT MOMENT (index `i`,
   * its current stored age/rotation/tint):
   *  - size = the dimensionless over-life size FACTOR `evalScalarTrack(ol.size, t,
   *    rand0)` (1 when the track is null) — NOT the px size (I2 dimensional
   *    soundness);
   *  - rotation = the current stored rotation in degrees;
   *  - RGBA = the sim-side color: the over-life gradient at `t` × the startColor
   *    tint INCLUDING the hueJitter hue rotation (reused exactly as render.ts does),
   *    EXCLUDING bySpeed and host params (render-only surfaces, documented).
   * `t` is the same `min(1, age/lifetime)` render uses, so a birth captures at t=0,
   * a death at t≈1, a collision at its mid-step age. Zero PRNG draws.
   */
  private pushInherit(arr: number[], i: number): void {
    const p = this.pool;
    const ol = this.layer.overLifetime;
    const lifetime = p.lifetime[i]!;
    const t = lifetime > 0 ? Math.min(1, p.age[i]! / lifetime) : 1;
    const sizeFactor = ol.size !== null ? evalScalarTrack(ol.size, t, p.rand0[i]!) : 1;
    const rot = p.rotation[i]!;
    evalGradient(ol.color, t, IC);
    const startColor = this.layer.startColor;
    if (startColor !== null && startColor.mode === "hueJitter") {
      const off = p.tintR![i]!;
      if (off !== 0) hueRotateRGB(IC.r, IC.g, IC.b, off, IC);
    } else if (startColor !== null) {
      IC.r *= p.tintR![i]!;
      IC.g *= p.tintG![i]!;
      IC.b *= p.tintB![i]!;
      IC.a *= p.tintA![i]!;
    }
    arr.push(sizeFactor, rot, IC.r, IC.g, IC.b, IC.a);
  }

  /** Advance all live particles by dt (§2.4 motion, §2.5 rotation, age/kill). */
  update(dt: number): void {
    const p = this.pool;
    const ol = this.layer.overLifetime;
    let gx = ol.velocity.gravity.x;
    let gy = ol.velocity.gravity.y;
    // A9 host params (schemaVersion 6): scale the hoisted gravity vector ONCE per
    // step (LIVE — every particle integrates the scaled gx/gy this step). Null
    // (unbound) leaves gx/gy exactly as authored ⇒ v5-instruction-identical; the
    // per-particle motion block below is untouched.
    if (this.gravityParamMul !== null) {
      gx *= this.gravityParamMul;
      gy *= this.gravityParamMul;
    }
    const drag = ol.velocity.drag;
    const speedMul = ol.velocity.speedMultiplier;
    const rotTrack = ol.rotation;
    // Limit velocity (schemaVersion 5, §0.3a / E27); null = off. A speed cap over
    // ageNorm, applied to the stored velocity after drag. Hoisted like drag; the
    // per-particle clamp below is gated on `limitVel !== null` so the null path is
    // instruction-identical to before this milestone. Zero PRNG draws.
    const limitVel = this.layer.limitVelocity;

    // Noise / turbulence (schemaVersion 3, §0.3). All config is hoisted out of
    // the loop; when the layer has no noise module the per-particle branch below
    // is never entered, so the update loop stays byte-identical to v2.
    const noise = this.layer.noise;
    const nStrength = noise !== null ? noise.strength : null;
    const nFreq = noise !== null ? noise.frequency : 0;
    const nScroll = noise !== null ? noise.scrollSpeed : 0;
    const nOct = noise !== null ? noise.octaves : 1;
    const nSeed = noise !== null ? (this.layerSeed + NOISE_SEED_OFFSET) >>> 0 : 0;
    const nPhase = p.noisePhase;
    const t = this.clock;

    // Wind (schemaVersion 10, B6): a coherent, spatially-uniform force — every
    // live particle feels the SAME wind vector this step, unlike the per-position
    // noise curl above. It is a pure function of the effect clock (zero PRNG
    // draws): the gust scalar `1 + gustAmount·sin(2π·gustFrequency·clock)` and the
    // direction cos/sin are hoisted ONCE per step here (coherence by construction —
    // position-independent). The per-particle block below only evaluates the
    // strength track at the particle's ageNorm and adds `w·(cosDir,sinDir)·dt` into
    // the STORED velocity, physical like gravity, inserted AFTER gravity and BEFORE
    // the attractor block so drag and limitVelocity damp the wind+attractor sum.
    // Gated on `wind !== null`; the migration injects null, so a null-wind layer
    // keeps the motion loop instruction-identical and no existing digest moves.
    const wind = this.layer.wind;
    const windStrength = wind !== null ? wind.strength : null;
    const windGust = wind !== null ? 1 + wind.gustAmount * Math.sin(2 * Math.PI * wind.gustFrequency * t) : 0;
    const windCos = wind !== null ? Math.cos(wind.direction * RAD) : 0;
    const windSin = wind !== null ? Math.sin(wind.direction * RAD) : 0;

    // Velocity over lifetime (schemaVersion 3, M3). Additive px/s (x/y), deg/s
    // clockwise orbital, and px/s outward radial, all evaluated at ageNorm and
    // applied into the position update only — NOT accumulated into velX/velY
    // (mirroring the noise rule). Config hoisted; the whole per-particle block is
    // gated behind `anyVelTrack` so a layer with all four tracks null keeps the
    // update loop instruction-identical to before this milestone.
    const velX = ol.velocity.x;
    const velY = ol.velocity.y;
    const velOrb = ol.velocity.orbital;
    const velRad = ol.velocity.radial;
    const anyVelTrack = velX !== null || velY !== null || velOrb !== null || velRad !== null;
    // Orbital/radial origin: (0,0) in local space, the step-end emitter position
    // for world-space layers (so the swirl center rides the emitter, §M3).
    const originX = this.layer.space === "world" ? this.emEX : 0;
    const originY = this.layer.space === "world" ? this.emEY : 0;
    const vRandX = p.velRandX;
    const vRandY = p.velRandY;
    const vRandOrb = p.velRandOrbital;
    const vRandRad = p.velRandRadial;

    // Rotation by speed (schemaVersion 3, §M6). bySpeed.rotation is deg/s added
    // into the angular term SIM-SIDE (so the spin actually slows as drag slows the
    // particle, unlike a render-only remap). Speed is √(velX²+velY²) from the
    // CURRENT stored velocity (the same definition render.ts uses), read after the
    // velocity integration below. Config hoisted; zero PRNG draws. A layer with no
    // bySpeed.rotation never enters the branch, so the rotation line stays
    // instruction-identical and every existing determinism snapshot is unchanged.
    const bySpeed = this.layer.bySpeed;
    const bsRot = bySpeed !== null ? bySpeed.rotation : null;
    const bsRotMin = bySpeed !== null ? bySpeed.range.min : 0;
    const bsRotMax = bySpeed !== null ? bySpeed.range.max : 0;
    const bsRotSpan = bsRotMax - bsRotMin;

    // Collision (schemaVersion 3, §M7). Pure resolve, ZERO PRNG draws. Config
    // hoisted; the resolve branch below is entered only when `colShape !== null`,
    // so a null-collision layer keeps the update loop instruction-identical (the
    // M3 velocity-over-lifetime and M2 noise blocks — which run AFTER the resolve
    // — do not move for it). Rect anchor: {x, y} is the TOP-LEFT corner (min x,
    // min y in Pixi's y-down frame, matching rect-shape conventions), so the four
    // inner faces are left = x, right = x + width, top = y, bottom = y + height.
    const collision = this.layer.collision;
    const colShape = collision !== null ? collision.shape : null;
    const colBounce = collision !== null ? collision.bounce : 0;
    const colDampen = collision !== null ? collision.dampen : 0;
    const colLifeLoss = collision !== null ? collision.lifetimeLoss : 0;
    const colTangent = 1 - colDampen; // tangential velocity survives, scaled
    // Kill-on-collide (schemaVersion 10, B3). Zero PRNG draws — reuses the ageLoss
    // accumulator like lifetimeLoss/killRadius. `killOnCollide false` skips the new
    // branch below, so a non-kill collision layer is instruction-identical (the
    // pre-impact speed is computed only when the flag is set).
    const colKillOnCollide = collision !== null ? collision.killOnCollide : false;
    const colMinKillSpeed = collision !== null ? collision.minKillSpeed : 0;
    // Kill zones (schemaVersion 10, B3): death regions in the layer's sim frame
    // (E20 lineage — same frame as the collision shape). Hoisted per step; the
    // per-particle containment test below is gated on `killZones !== null`, so a
    // null layer keeps the update loop instruction-identical. Zero PRNG draws.
    const killZones = this.layer.killZones;

    // Point attractor / vortex (schemaVersion 4, §0.3b). Radial (`strength`) +
    // tangential acceleration toward a point in the layer's sim frame, written
    // into the STORED velocity (physical, like gravity), applied AFTER the gravity
    // add and BEFORE drag — so suction composes with drag/collision/bySpeed. Config
    // hoisted; the whole per-particle block below is gated behind `anyAttractor`, so
    // a layer with no document attractor AND no active host attractor keeps the
    // motion block instruction-identical to before this milestone. Zero PRNG draws.
    // The host attractor (fixed `smooth` falloff, radial only, no kill, scaled by
    // `attractorInfluence`) is applied immediately after the document one.
    const att = this.layer.attractor;
    const attX = att !== null ? att.x : 0;
    const attY = att !== null ? att.y : 0;
    const attStrength = att !== null ? att.strength : null;
    const attTangential = att !== null ? att.tangential : null;
    const attRadius = att !== null ? att.radius : 0;
    const attFalloff = att !== null ? att.falloff : "none";
    const attKillRadius = att !== null ? att.killRadius : 0;
    const hostX = this.hostAttractorX;
    const hostY = this.hostAttractorY;
    const hostStrength = this.hostAttractorStrength;
    const hostRadius = this.hostAttractorRadius;
    const hostInfluence = this.layer.attractorInfluence;
    const hostActive = hostRadius > 0 && hostInfluence !== 0;
    const anyAttractor = att !== null || hostActive;

    // Per-particle trail recording (schemaVersion 3, §M9). Zero PRNG draws. The
    // ring buffer and its minVertexDistance² gate are hoisted; the per-particle
    // push below runs at the END of each particle's update (after ALL position
    // writes, including VoL and noise), so the trail records the RENDERED path.
    // Null for every trail-null layer, so the update loop stays instruction-
    // identical there.
    const trailStore = p.trail;
    const trailMinDistSq =
      this.layer.trail !== null ? this.layer.trail.minVertexDistance * this.layer.trail.minVertexDistance : 0;
    // The event scratches hold only THIS step's events; clear (reuse the backing
    // store) whichever exist. Null when a flag has never been set, so a layer that
    // never records events pays only null checks. Cleared here at the TOP of
    // update() — before this step's death/collision fills below and before this
    // step's emit() fills birth — so the Effect (which consumes all three after
    // update+emit) never sees a stale event, and prewarm's recorded-but-unprocessed
    // events are dropped before the first visible step processes anything (E19).
    if (this.birthEvents !== null) this.birthEvents.length = 0;
    if (this.deathEvents !== null) this.deathEvents.length = 0;
    if (this.collisionEvents !== null) this.collisionEvents.length = 0;

    let i = 0;
    while (i < p.count) {
      const lifetime = p.lifetime[i]!;
      const age = p.age[i]!;
      const ageNorm = lifetime > 0 ? age / lifetime : 1;
      // Accumulated lifetime loss for this step (§M7 kill mechanism). Hoisted above
      // the attractor block so a killRadius consumption and a collision lifetimeLoss
      // both fold into the SAME kill at this step's age/kill stage. 0 for every
      // non-attractor, non-colliding particle, so `+ ageLoss` stays an exact IEEE
      // no-op and the null path is byte-identical to before this milestone.
      let ageLoss = 0;

      // gravity, then wind, then attractor, then drag, then position (normative
      // order §0.3b / E40)
      let vx = p.velX[i]! + gx * dt;
      let vy = p.velY[i]! + gy * dt;
      // Wind (§0.3b, E40): coherent directional acceleration into the stored
      // velocity, added AFTER gravity and BEFORE the attractor block so drag and
      // limitVelocity damp it. The gust and cos/sin are hoisted (position-
      // independent — every particle this step gets the identical gust); only the
      // strength track is evaluated per particle at its ageNorm (rand 0 — a
      // range-forbidding track, zero draws), authoring an ease-in over life. Gated
      // on `wind !== null`, so a null-wind layer is instruction-identical.
      if (wind !== null) {
        const w = evalScalarTrack(windStrength!, ageNorm, 0) * windGust;
        vx += w * windCos * dt;
        vy += w * windSin * dt;
      }
      // Point attractor / vortex (§0.3b): entered only when a document attractor is
      // set or an active host attractor scales onto this layer. Reads the CURRENT
      // position (pre-integration), writes the STORED velocity via the vx/vy locals
      // (committed below like gravity/drag), so the force is dragged this same step.
      if (anyAttractor) {
        const ax = p.x[i]!;
        const ay = p.y[i]!;
        if (att !== null) {
          const dx = attX - ax;
          const dy = attY - ay;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < attRadius && d >= 1e-6) {
            const s = 1 - d / attRadius;
            const w = attFalloff === "none" ? 1 : attFalloff === "linear" ? s : s * s * (3 - 2 * s);
            const ux = dx / d;
            const uy = dy / d;
            const aR = evalScalarTrack(attStrength!, ageNorm, 0) * w;
            const aT = attTangential !== null ? evalScalarTrack(attTangential, ageNorm, 0) * w : 0;
            // Positive tangential ⇒ clockwise on the y-down screen (a particle at +x
            // of the point gains +vy), matching orbital's convention (§0.3b).
            vx += (ux * aR + uy * aT) * dt;
            vy += (uy * aR - ux * aT) * dt;
          }
          // killRadius (0 = off): consume the particle regardless of the force skip
          // above (a particle AT the center, d < 1e-6, is still consumed). Folds the
          // full lifetime into ageLoss so it dies THIS step and death-trigger
          // sub-emitters fire (a black hole spawns a consumption flash).
          if (attKillRadius > 0 && d < attKillRadius) ageLoss += lifetime;
        }
        if (hostActive) {
          const dx = hostX - ax;
          const dy = hostY - ay;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < hostRadius && d >= 1e-6) {
            const s = 1 - d / hostRadius;
            const w = s * s * (3 - 2 * s); // host falloff is fixed smooth (§0.3b)
            const ux = dx / d;
            const uy = dy / d;
            const aR = hostStrength * hostInfluence * w; // radial only, scaled per layer
            vx += ux * aR * dt;
            vy += uy * aR * dt;
          }
        }
      }
      if (drag) {
        const d = evalScalarTrack(drag, ageNorm, p.rand2[i]!);
        const f = Math.max(0, 1 - d * dt);
        vx *= f;
        vy *= f;
      }
      // Limit velocity (§0.3a, E27): a physical, persistent speed cap on the
      // stored velocity, applied AFTER the drag block and BEFORE the
      // speedMultiplier eval / position write — the normative order is
      // gravity → attractor → drag → limitVelocity → speedMultiplier/position. It
      // scales the SAME vx/vy locals that p.velX/velY are committed from below, so
      // (like drag) the cap persists into the next step. `evalScalarTrack` takes
      // the literal `0` uniform — limitVelocity is a range-forbidding track, so
      // this draws no PRNG. `cap = 0` clamps speed to 0 (particles settle in place,
      // valid per E27). Gated on `limitVel !== null` so the null path is
      // instruction-identical.
      if (limitVel !== null) {
        const cap = Math.max(0, evalScalarTrack(limitVel, ageNorm, 0));
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > cap && speed > 1e-6) {
          const s = cap / speed;
          vx *= s;
          vy *= s;
        }
      }
      const sm = speedMul ? evalScalarTrack(speedMul, ageNorm, p.rand3[i]!) : 1;
      p.x[i] = p.x[i]! + vx * sm * dt;
      p.y[i] = p.y[i]! + vy * sm * dt;
      p.velX[i] = vx;
      p.velY[i] = vy;

      // Collision resolve (schemaVersion 3, §M7): PURE, ZERO PRNG draws, run on
      // the BASE-integrated position — BEFORE the velocity-over-lifetime and noise
      // perturbations below. Unlike M3/M2, a hit WRITES the stored velocity (the
      // bounce/dampen are persistent) and defers a lifetimeLoss into `ageLoss`,
      // folded into `newAge` so the existing age/kill stage kills a lethally-worn
      // particle at THIS step's end with no restructuring. IMPORTANT: the M3
      // orbital/radial and M2 noise blocks write p.x/p.y AFTER this resolve, so a
      // strong noise curl (or an orbital track) can push a particle back through
      // the floor on the same step — that is ACCEPTED by the normative order,
      // which only resolves the base-integration position. Do not "fix" it by
      // moving the resolve after those blocks.
      if (colShape !== null) {
        let cx = p.x[i]!;
        let cy = p.y[i]!;
        let hit = false;
        // Pre-impact speed for killOnCollide (B3): the stored velocity's magnitude
        // BEFORE any reflect below mutates vx/vy. Computed only when killOnCollide
        // is set (the ternary short-circuits to 0 otherwise, taking no sqrt), so a
        // non-kill collision layer is instruction-identical.
        const preImpactSpeed = colKillOnCollide ? Math.sqrt(vx * vx + vy * vy) : 0;
        if (colShape.kind === "floor") {
          if (cy > colShape.y && vy > 0) {
            cy = colShape.y;
            vy = -vy * colBounce; // reflect the normal (y) velocity
            vx *= colTangent; // dampen the tangential (x) velocity
            hit = true;
          }
        } else {
          // rect, keep-INSIDE: each of the four inner faces resolved independently
          // so a corner hit (both an x face and a y face violated in one step)
          // resolves BOTH axes this step. Reflect the normal velocity, dampen the
          // tangential velocity of the axis being resolved.
          const left = colShape.x;
          const right = colShape.x + colShape.width;
          const top = colShape.y;
          const bottom = colShape.y + colShape.height;
          if (cx < left && vx < 0) {
            cx = left;
            vx = -vx * colBounce;
            vy *= colTangent;
            hit = true;
          } else if (cx > right && vx > 0) {
            cx = right;
            vx = -vx * colBounce;
            vy *= colTangent;
            hit = true;
          }
          if (cy < top && vy < 0) {
            cy = top;
            vy = -vy * colBounce;
            vx *= colTangent;
            hit = true;
          } else if (cy > bottom && vy > 0) {
            cy = bottom;
            vy = -vy * colBounce;
            vx *= colTangent;
            hit = true;
          }
        }
        if (hit) {
          p.x[i] = cx;
          p.y[i] = cy;
          p.velX[i] = vx; // collision WRITES stored velocity (persistent bounce)
          p.velY[i] = vy;
          // Accumulate (not overwrite): an attractor killRadius may have already
          // added `lifetime` above. For every collision-only layer ageLoss is 0
          // here, so `+=` is byte-identical to the pre-M2 `=` (exact IEEE no-op).
          ageLoss += colLifeLoss * lifetime;
          // killOnCollide (B3): a hard-enough hit shatters — fold a full lifetime
          // into ageLoss so the particle dies at this step's age/kill stage. The
          // threshold is `>=` (a hit exactly AT minKillSpeed kills; `0` = always).
          // The collision event STILL records below, so a shattering particle can
          // fire both a collision-trigger and a death-trigger sub-emitter this step
          // (normative double-event, FORMAT_SPEC E38 — the killRadius precedent).
          if (colKillOnCollide && preImpactSpeed >= colMinKillSpeed) ageLoss += lifetime;
          if (this.recordCollisionEvents) {
            // Record the STABLE ordinal (M8), not the live index `i`: swap-remove
            // can move a different particle into slot `i` before the Effect reads
            // this scratch, so `i` is not a durable identity. A layer that records
            // collision events is a sub-emitter parent, so the ordinal column exists.
            const ord = p.ordinal !== null ? p.ordinal[i]! : 0;
            const arr = (this.collisionEvents ??= []);
            arr.push(cx, cy, vx, vy, ord);
            if (this.captureInherit) this.pushInherit(arr, i); // v9 I4: 6 extra floats
          }
        }
      }

      // Kill zones (schemaVersion 10, B3): post-integration death regions in the
      // layer's sim frame, tested alongside the collision resolve (on the base-
      // integrated position, before the VoL/noise perturbations). A particle whose
      // position lands inside any rect folds a full lifetime into ageLoss so it
      // dies this step. Boundary is inclusive (`>=`/`<=` — a point exactly on an
      // edge is inside). `break` on first containment: ageLoss accumulates once
      // regardless of overlap. Gated on `killZones !== null`; zero PRNG draws.
      if (killZones !== null) {
        const kx = p.x[i]!;
        const ky = p.y[i]!;
        for (let z = 0; z < killZones.length; z++) {
          const zone = killZones[z]!;
          if (kx >= zone.x && kx <= zone.x + zone.width && ky >= zone.y && ky <= zone.y + zone.height) {
            ageLoss += lifetime;
            break;
          }
        }
      }

      // Velocity over lifetime AFTER the base position update, BEFORE noise (§M3).
      // Rotate the offset (p − origin) clockwise by orbital(ageNorm)·dt, push
      // radial(ageNorm)·dt along the normalized offset, then add the x/y track
      // velocities ×dt. Like noise, none of this feeds back into velX/velY.
      if (anyVelTrack) {
        let ox = p.x[i]! - originX;
        let oy = p.y[i]! - originY;
        if (velOrb !== null) {
          // Clockwise on the y-down screen = the standard positive rotation
          // matrix. Magnitude is preserved, so the orbit radius is invariant.
          const a = evalScalarTrack(velOrb, ageNorm, vRandOrb![i]!) * dt * RAD;
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          const rx = ox * cos - oy * sin;
          const ry = ox * sin + oy * cos;
          ox = rx;
          oy = ry;
        }
        if (velRad !== null) {
          const r = Math.sqrt(ox * ox + oy * oy);
          if (r >= 1e-6) {
            const push = (evalScalarTrack(velRad, ageNorm, vRandRad![i]!) * dt) / r;
            ox += ox * push;
            oy += oy * push;
          }
        }
        let nx = originX + ox;
        let ny = originY + oy;
        if (velX !== null) nx += evalScalarTrack(velX, ageNorm, vRandX![i]!) * dt;
        if (velY !== null) ny += evalScalarTrack(velY, ageNorm, vRandY![i]!) * dt;
        p.x[i] = nx;
        p.y[i] = ny;
      }

      // Noise perturbation AFTER the position update (§0.3): a bounded,
      // velocity-style position nudge — NOT accumulated into velX/velY, so there
      // is no energy buildup and it is drag-independent. curl2 writes into its
      // own module scratch (zero allocation).
      if (noise !== null) {
        const nx = p.x[i]!;
        const ny = p.y[i]!;
        const phase = nPhase![i]!;
        const scroll = t * nScroll * nFreq;
        const sx = nx * nFreq + scroll + phase * PHASE_OFF;
        const sy = ny * nFreq + scroll * 0.773;
        const c = curl2(sx, sy, nSeed, nOct);
        const strength = evalScalarTrack(nStrength!, ageNorm, 0);
        p.x[i] = nx + c.x * strength * dt;
        p.y[i] = ny + c.y * strength * dt;
      }

      // Trail point push (§M9): record the CURRENT (fully-perturbed) position as a
      // new head point when it has moved ≥ minVertexDistance from the last one.
      // Runs after every position write above so the ribbon follows the rendered
      // path; before the kill below so index i still names this particle (a dying
      // particle's push is harmless — swap-remove overwrites its block anyway).
      if (trailStore !== null) trailStore.push(i, p.x[i]!, p.y[i]!, trailMinDistSq);

      // rotation over lifetime = (angularVelocity + track [+ bySpeed]) * dt (§2.5,
      // §M6). The by-speed spin is added into the SAME angular term, evaluated at
      // the speed-normalized t (degenerate zero-width range steps 0→1 at the shared
      // bound). It reads the just-integrated vx/vy, so a stopped particle stops
      // spinning. The stored angVel column is never modified.
      let extra = rotTrack ? evalScalarTrack(rotTrack, ageNorm, p.rand1[i]!) : 0;
      if (bsRot !== null) {
        const speed = Math.sqrt(vx * vx + vy * vy);
        const tSpeed = bsRotSpan > 0 ? Math.min(1, Math.max(0, (speed - bsRotMin) / bsRotSpan)) : speed >= bsRotMax ? 1 : 0;
        extra += evalScalarTrack(bsRot, tSpeed, 0);
      }
      p.rotation[i] = p.rotation[i]! + (p.angVel[i]! + extra) * dt;

      // `ageLoss` is 0 for every non-colliding particle (and every null-collision
      // layer), so `+ ageLoss` is an exact IEEE no-op there — the age/kill stage
      // and its snapshot are byte-identical unless a collision actually wore this
      // particle down (§M7 lifetimeLoss).
      const newAge = age + dt + ageLoss;
      p.age[i] = newAge;
      if (newAge >= lifetime) {
        // Death event (M8): record the dying particle's position, stored velocity,
        // and stable ordinal BEFORE the swap-remove reassigns slot `i`. Covers both
        // natural age-out and lifetimeLoss-induced death (both reach here via
        // `newAge >= lifetime`). Gated on the recorder (false unless this layer
        // feeds a death-trigger sub-emitter and it is not prewarming, E19).
        if (this.recordDeathEvents) {
          const ord = p.ordinal !== null ? p.ordinal[i]! : 0;
          const arr = (this.deathEvents ??= []);
          arr.push(p.x[i]!, p.y[i]!, p.velX[i]!, p.velY[i]!, ord);
          if (this.captureInherit) this.pushInherit(arr, i); // v9 I4: 6 extra floats
        }
        p.kill(i); // swap-remove; re-check slot i without advancing
      } else {
        i++;
      }
    }
  }
}
