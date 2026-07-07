// Per-layer simulation: spawning (fixed PRNG draw order, §2.7) and the per-step
// integration of motion (§2.4), rotation (§2.5), ageing, and death. Emission
// *timing* (when to call spawn) lives in Effect (§2.8); this class only knows
// how to make one particle and how to advance the ones it has.
import type { Layer } from "../format/types.js";
import { mulberry32, type Rng } from "./prng.js";
import { drawScalarInit, evalScalarTrack } from "./tracks.js";
import { ParticlePool } from "./pool.js";
import { sampleShape } from "./shapes.js";
import { curl2 } from "./noise.js";

const RAD = Math.PI / 180;
// De-synchronizes the noise phase of point/co-located spawns so fireflies from
// one emitter don't wander in lockstep (§0.3). Multiplies the per-particle phase
// into the x sample coordinate only.
const PHASE_OFF = 37.0;
// Offset from the layer seed to the noise seed (§0.3), so the turbulence field
// is decorrelated from the spawn PRNG stream.
const NOISE_SEED_OFFSET = 0x9e3779b9;

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
  /** True if a spawn was dropped since the flag was last reset (E7). */
  capped = false;
  /** Continuous-emission fractional accumulator (§2.8), owned by Effect. */
  acc = 0;
  /** Rate-over-distance fractional accumulator (schemaVersion 2), owned by Effect. */
  accDist = 0;

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

  constructor(layer: Layer, layerSeed: number) {
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
    });
    this.rng = mulberry32(layerSeed);
    this.layerSeed = layerSeed;
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
  }

  /** Push the effect clock (step start) into this sim (schemaVersion 3); the
   * noise field scrolls with it. Zero-cost for layers without noise. */
  setClock(t: number): void {
    this.clock = t;
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

  /**
   * Spawn one particle. Performs exactly the fixed 13 draws in the normative
   * order regardless of shape/mode/space (§2.7). If the pool is full the spawn is
   * dropped with no draws (deterministic) and `capped` is set; returns false.
   *
   * `f` ∈ [0,1] is the spawn's fractional position through the current step
   * (schemaVersion 2). It is used ONLY by world-space layers, to interpolate the
   * spawn position along the emitter's motion segment; local-space layers ignore
   * it, so their spawn path is byte-identical to v1.
   */
  spawn(f = 1): boolean {
    const p = this.pool;
    if (p.count >= p.capacity) {
      this.capped = true;
      return false;
    }
    const rng = this.rng;
    const init = this.layer.initial;

    // 1) position (2 draws), 2) direction (1 draw)
    const uPos1 = rng();
    const uPos2 = rng();
    const uDir = rng();
    // 3) life, speed, size, rotation, angularVelocity (1 draw each, always)
    const life = drawScalarInit(init.life, rng);
    const speed = drawScalarInit(init.speed, rng);
    const size = drawScalarInit(init.size, rng);
    const rot = drawScalarInit(init.rotation, rng);
    const angVel = drawScalarInit(init.angularVelocity, rng);
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

    const i = p.spawn();
    const s = sampleShape(this.layer.shape, uPos1, uPos2, uDir);
    const dirRad = s.dirDeg * RAD;
    let px = s.px;
    let py = s.py;
    let vx = speed * Math.cos(dirRad);
    let vy = speed * Math.sin(dirRad);
    if (this.layer.space === "world") {
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
    return true;
  }

  /** Advance all live particles by dt (§2.4 motion, §2.5 rotation, age/kill). */
  update(dt: number): void {
    const p = this.pool;
    const ol = this.layer.overLifetime;
    const gx = ol.velocity.gravity.x;
    const gy = ol.velocity.gravity.y;
    const drag = ol.velocity.drag;
    const speedMul = ol.velocity.speedMultiplier;
    const rotTrack = ol.rotation;

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

    let i = 0;
    while (i < p.count) {
      const lifetime = p.lifetime[i]!;
      const age = p.age[i]!;
      const ageNorm = lifetime > 0 ? age / lifetime : 1;

      // gravity, then drag, then position (normative order §2.4)
      let vx = p.velX[i]! + gx * dt;
      let vy = p.velY[i]! + gy * dt;
      if (drag) {
        const d = evalScalarTrack(drag, ageNorm, p.rand2[i]!);
        const f = Math.max(0, 1 - d * dt);
        vx *= f;
        vy *= f;
      }
      const sm = speedMul ? evalScalarTrack(speedMul, ageNorm, p.rand3[i]!) : 1;
      p.x[i] = p.x[i]! + vx * sm * dt;
      p.y[i] = p.y[i]! + vy * sm * dt;
      p.velX[i] = vx;
      p.velY[i] = vy;

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

      // rotation over lifetime = (angularVelocity + track) * dt (§2.5)
      const extra = rotTrack ? evalScalarTrack(rotTrack, ageNorm, p.rand1[i]!) : 0;
      p.rotation[i] = p.rotation[i]! + (p.angVel[i]! + extra) * dt;

      const newAge = age + dt;
      p.age[i] = newAge;
      if (newAge >= lifetime) {
        p.kill(i); // swap-remove; re-check slot i without advancing
      } else {
        i++;
      }
    }
  }
}
