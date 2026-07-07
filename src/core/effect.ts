// Effect: a running instance of a .prt document. Owns one LayerSim per layer,
// drives emission timing (§2.8), motion integration (via LayerSim.update), the
// effect clock, prewarm (E5), dt clamping (E1/E2), and isDone (E6). This is the
// same code path the editor preview and the shipped runtime both use (L4).
import type { Layer, ScalarTrack, ParticleDoc } from "../format/types.js";
import { deriveLayerSeed } from "./prng.js";
import { evalCurve } from "./tracks.js";
import { LayerSim } from "./layerSim.js";

/** dt is clamped to this ceiling so a tab-unhide can't explode emitters (E1). */
export const MAX_DT = 1 / 20;
const PREWARM_DT = 1 / 60;
const EPS = 1e-9;

function evalRate(track: ScalarTrack, tNorm: number): number {
  switch (track.mode) {
    case "constant":
      return track.value;
    case "curve":
      return evalCurve(track.keys, tNorm);
    // A rate has no per-particle rand; range mode uses the deterministic
    // midpoint (documented ruling — the editor exposes only constant/curve).
    case "range":
      return (track.min + track.max) / 2;
  }
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export class Effect {
  readonly doc: ParticleDoc;
  private readonly sims: LayerSim[];
  private effectSeed: number;
  private t = 0; // effect clock; kept in [0,duration) when looping
  private cycleStart = true; // first emission interval of a cycle uses an inclusive lower bound
  private prewarming = false;

  // Emitter transform (schemaVersion 2). `ex/ey` is where the emitter is now;
  // `pendingX/Y` is the target the host set for the end of the next step (null =
  // unset); `evx/evy` and `stepStart/End` describe the segment the emitter
  // sweeps during the current step, consumed by world-space spawning.
  private ex = 0;
  private ey = 0;
  private pendingX: number | null = null;
  private pendingY: number | null = null;
  private evx = 0;
  private evy = 0;
  private stepStartX = 0;
  private stepStartY = 0;
  private stepEndX = 0;
  private stepEndY = 0;

  constructor(doc: ParticleDoc, opts?: { seed?: number; x?: number; y?: number }) {
    // A non-positive duration would make the looping emit loop never terminate
    // (room stays 0). Fail loud rather than hang; validateParticle enforces the
    // full 0.05 floor for authored documents. (P2.3)
    if (!(doc.duration > 0)) {
      throw new Error("ParticleDoc.duration must be > 0 (run validateParticle first — the floor is 0.05s)");
    }
    this.doc = doc;
    this.effectSeed = (opts?.seed ?? doc.seed) >>> 0;
    this.ex = this.stepStartX = this.stepEndX = opts?.x ?? 0;
    this.ey = this.stepStartY = this.stepEndY = opts?.y ?? 0;
    this.sims = doc.layers.map((layer, i) => new LayerSim(layer, deriveLayerSeed(this.effectSeed, i)));
    this.runPrewarm();
  }

  get time(): number {
    return this.t;
  }
  get seed(): number {
    return this.effectSeed;
  }
  /** Current emitter position (schemaVersion 2). */
  get emitterX(): number {
    return this.ex;
  }
  get emitterY(): number {
    return this.ey;
  }

  /**
   * Set where the emitter will be at the END of the next `step(dt)`
   * (schemaVersion 2). The step derives emitter velocity = Δposition ÷ dt and
   * interpolates world-space spawn positions along the segment, so a moving
   * emitter lays a continuous trail. The last call before a step wins.
   */
  setEmitterPosition(x: number, y: number): void {
    this.pendingX = x;
    this.pendingY = y;
  }

  /**
   * Jump the emitter with NO velocity and NO spawn interpolation across the gap
   * (schemaVersion 2, E15). Use for respawns and screen wraps so a discontinuous
   * move doesn't smear a streak or launch particles at teleport speed.
   */
  teleportEmitter(x: number, y: number): void {
    this.ex = x;
    this.ey = y;
    this.pendingX = null;
    this.pendingY = null;
  }
  get layers(): readonly LayerSim[] {
    return this.sims;
  }
  get particleCount(): number {
    let n = 0;
    for (const ls of this.sims) n += ls.count;
    return n;
  }
  get isDone(): boolean {
    if (this.doc.looping) return false;
    if (this.t < this.doc.duration) return false;
    return this.particleCount === 0; // E6
  }

  reset(seed?: number): void {
    if (seed !== undefined) this.effectSeed = seed >>> 0;
    this.t = 0;
    this.cycleStart = true;
    // The host owns emitter placement, so keep the current position; only clear
    // motion state (velocity + any queued target) so the reset cycle starts still.
    this.pendingX = null;
    this.pendingY = null;
    this.evx = 0;
    this.evy = 0;
    this.stepStartX = this.stepEndX = this.ex;
    this.stepStartY = this.stepEndY = this.ey;
    this.sims.forEach((ls, i) => ls.reset(deriveLayerSeed(this.effectSeed, i)));
    this.runPrewarm();
  }

  step(dt: number): void {
    if (dt <= 0) return; // E2
    if (dt > MAX_DT) dt = MAX_DT; // E1
    // Resolve the emitter's motion segment for this step (schemaVersion 2).
    const sx = this.ex;
    const sy = this.ey;
    const tx = this.pendingX === null ? sx : this.pendingX;
    const ty = this.pendingY === null ? sy : this.pendingY;
    this.stepStartX = sx;
    this.stepStartY = sy;
    this.stepEndX = tx;
    this.stepEndY = ty;
    this.evx = (tx - sx) / dt;
    this.evy = (ty - sy) / dt;
    this.advance(dt);
    // Commit the emitter to the segment end; clear per-step motion state.
    this.ex = tx;
    this.ey = ty;
    this.pendingX = null;
    this.pendingY = null;
    this.evx = 0;
    this.evy = 0;
  }

  // --- internals -----------------------------------------------------------

  private advance(dt: number): void {
    // Integrate existing particles once with the full dt (no substeps, E1),
    // then emit new particles (age 0) for the interval this step covers.
    const tStart = this.t;
    for (const ls of this.sims) {
      ls.capped = false;
      ls.setEmitterStep(this.stepStartX, this.stepStartY, this.stepEndX, this.stepEndY, this.evx, this.evy);
      if (ls.layer.enabled) ls.update(dt);
    }
    this.emit(dt);
    this.emitDistance(dt, tStart);
  }

  private runPrewarm(): void {
    if (!this.doc.layers.some((l) => l.emission.prewarm)) return;
    const steps = Math.max(1, Math.round(this.doc.duration / PREWARM_DT));
    this.prewarming = true;
    for (let i = 0; i < steps; i++) this.advance(PREWARM_DT);
    this.prewarming = false;
    // Visible cycle starts fresh; particles produced during prewarm are kept.
    this.t = 0;
    this.cycleStart = true;
  }

  private emit(dt: number): void {
    const duration = this.doc.duration;
    if (this.doc.looping) {
      let remaining = dt;
      let t = this.t;
      // Offset of the current interval's start from the step's start, in seconds.
      // World-space spawn fractions are measured against the whole step, so the
      // interpolation stays monotonic across a looping wrap. (schemaVersion 2)
      let elapsed = 0;
      while (remaining > EPS) {
        const room = duration - t;
        if (remaining < room - EPS) {
          this.emitInterval(t, t + remaining, this.cycleStart, elapsed, dt);
          this.cycleStart = false;
          elapsed += remaining;
          t += remaining;
          remaining = 0;
        } else {
          this.emitInterval(t, duration, this.cycleStart, elapsed, dt);
          this.cycleStart = false;
          elapsed += room;
          remaining -= room;
          t = 0;
          this.cycleStart = true;
        }
      }
      this.t = t;
    } else {
      // Non-looping: emission only within [0,duration); the clock keeps running
      // so existing particles live out their lives (E6).
      const emitEnd = Math.min(this.t + dt, duration);
      if (emitEnd > this.t) this.emitInterval(this.t, emitEnd, this.cycleStart, 0, dt);
      this.cycleStart = false;
      this.t += dt;
    }
  }

  private emitInterval(t0: number, t1: number, inclusiveLower: boolean, elapsed: number, stepDt: number): void {
    const duration = this.doc.duration;
    const tNorm = duration > 0 ? Math.min(t0, duration) / duration : 0;
    const invDt = stepDt > 0 ? 1 / stepDt : 0;

    for (const ls of this.sims) {
      const layer = ls.layer;
      if (!layer.enabled) continue;
      const em = layer.emission;
      const delay = em.delay;
      const localStart = t0 - delay;
      const localEnd = t1 - delay;

      // Bursts fire BEFORE continuous emission when both land in the same step:
      // burst particles take their PRNG draws first and win contested pool slots
      // near the cap (normative order — IMPLEMENTATION_PLAN §emission). (P2.1)
      // Suppressed during prewarm (continuous only, E5).
      if (!this.prewarming) {
        for (const burst of em.bursts) {
          const count = burst.count;
          if (count <= 0) continue;
          // At most `capacity` particles can ever exist, so iterating past it
          // can only produce capped no-ops — bound a hostile count (e.g. 2^31)
          // to <= capacity iterations. Sub-event *times* still use the full
          // `count` denominator, so any doc with count <= capacity (every preset
          // and every validated doc) is unaffected. (P1.3)
          const iterations = Math.min(count, ls.pool.capacity);
          if (count > iterations) ls.capped = true;
          for (let k = 0; k < iterations; k++) {
            // Sub-events spread evenly across [time, time + spread] *inclusive*:
            // with count >= 2 the last lands exactly at time + spread. (P2.2)
            const sk = count === 1 ? burst.time : burst.time + (burst.spread * k) / (count - 1);
            const lowerOk = inclusiveLower ? localStart <= sk : localStart < sk;
            // World-space spawn fraction: the sub-event's offset within the step
            // (schemaVersion 2). Ignored by local layers.
            if (lowerOk && sk <= localEnd) ls.spawn(clamp01((elapsed + (sk - localStart)) * invDt));
          }
        }
      }

      // Continuous emission (skipped for non-prewarm layers during prewarm).
      if (!(this.prewarming && !em.prewarm) && localEnd > 0) {
        const activeStart = Math.max(localStart, 0);
        const activeDt = localEnd - activeStart;
        if (activeDt > 0) {
          // Clamp negative rate to 0 so a dipping rate curve can't bank spurious
          // spawn credit (floor(-0.5) then acc -= n would *add* a particle). (P2.3)
          const rate = Math.max(0, evalRate(em.rateOverTime, tNorm));
          ls.acc += rate * activeDt;
          let n = Math.floor(ls.acc);
          ls.acc -= n;
          // Clamp to the pool's free slots. Spawns past capacity are dropped
          // no-ops anyway (spawn() sets `capped` and draws nothing), so this is
          // behavior-preserving — it just bounds a hostile rate (e.g. 1e15,
          // which validates but yields n≈5e13) to at most `capacity` iterations.
          const room = ls.pool.capacity - ls.pool.count;
          if (n > room) {
            ls.capped = true;
            n = room;
          }
          // Distribute the batch across the interval at midpoint fractions so a
          // fast-moving world-space emitter lays a smooth streak instead of a
          // clump; local layers ignore the fraction. (schemaVersion 2)
          const baseOffset = elapsed + (activeStart - localStart);
          for (let s = 0; s < n; s++) {
            ls.spawn(clamp01((baseOffset + (activeDt * (s + 0.5)) / n) * invDt));
          }
        }
      }
    }
  }

  /**
   * Rate-over-distance emission (schemaVersion 2): spawn particles per pixel the
   * emitter traveled this step, distributed evenly along the motion segment.
   * World-space layers only; a stationary emitter (and every teleport) travels
   * zero distance and emits nothing. Runs after time-based emission so PRNG draw
   * order within a step is fixed: bursts, continuous, then distance.
   */
  private emitDistance(dt: number, tStart: number): void {
    const dx = this.stepEndX - this.stepStartX;
    const dy = this.stepEndY - this.stepStartY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= EPS || this.prewarming) return;
    const duration = this.doc.duration;
    const tNorm = duration > 0 ? Math.min(tStart, duration) / duration : 0;

    for (const ls of this.sims) {
      const layer = ls.layer;
      if (!layer.enabled || layer.space !== "world") continue;
      const rod = layer.emission.rateOverDistance;
      if (!rod) continue;
      // Gate on the emission delay like continuous emission: nothing until the
      // effect clock reaches the layer's delay.
      if (tStart + dt <= layer.emission.delay) continue;
      const rate = Math.max(0, evalRate(rod, tNorm)); // particles per pixel
      ls.accDist += rate * dist;
      let m = Math.floor(ls.accDist);
      ls.accDist -= m;
      const room = ls.pool.capacity - ls.pool.count;
      if (m > room) {
        ls.capped = true;
        m = room;
      }
      for (let k = 0; k < m; k++) ls.spawn((k + 0.5) / m);
    }
  }
}

export type { Layer };
