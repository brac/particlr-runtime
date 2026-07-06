// Effect: a running instance of a .spark document. Owns one LayerSim per layer,
// drives emission timing (§2.8), motion integration (via LayerSim.update), the
// effect clock, prewarm (E5), dt clamping (E1/E2), and isDone (E6). This is the
// same code path the editor preview and the shipped runtime both use (L4).
import type { Layer, ScalarTrack, SparkDoc } from "../format/types.js";
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

export class Effect {
  readonly doc: SparkDoc;
  private readonly sims: LayerSim[];
  private effectSeed: number;
  private t = 0; // effect clock; kept in [0,duration) when looping
  private cycleStart = true; // first emission interval of a cycle uses an inclusive lower bound
  private prewarming = false;

  constructor(doc: SparkDoc, opts?: { seed?: number }) {
    this.doc = doc;
    this.effectSeed = (opts?.seed ?? doc.seed) >>> 0;
    this.sims = doc.layers.map((layer, i) => new LayerSim(layer, deriveLayerSeed(this.effectSeed, i)));
    this.runPrewarm();
  }

  get time(): number {
    return this.t;
  }
  get seed(): number {
    return this.effectSeed;
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
    this.sims.forEach((ls, i) => ls.reset(deriveLayerSeed(this.effectSeed, i)));
    this.runPrewarm();
  }

  step(dt: number): void {
    if (dt <= 0) return; // E2
    if (dt > MAX_DT) dt = MAX_DT; // E1
    this.advance(dt);
  }

  // --- internals -----------------------------------------------------------

  private advance(dt: number): void {
    // Integrate existing particles once with the full dt (no substeps, E1),
    // then emit new particles (age 0) for the interval this step covers.
    for (const ls of this.sims) {
      ls.capped = false;
      if (ls.layer.enabled) ls.update(dt);
    }
    this.emit(dt);
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
      while (remaining > EPS) {
        const room = duration - t;
        if (remaining < room - EPS) {
          this.emitInterval(t, t + remaining, this.cycleStart);
          this.cycleStart = false;
          t += remaining;
          remaining = 0;
        } else {
          this.emitInterval(t, duration, this.cycleStart);
          this.cycleStart = false;
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
      if (emitEnd > this.t) this.emitInterval(this.t, emitEnd, this.cycleStart);
      this.cycleStart = false;
      this.t += dt;
    }
  }

  private emitInterval(t0: number, t1: number, inclusiveLower: boolean): void {
    const duration = this.doc.duration;
    const tNorm = duration > 0 ? Math.min(t0, duration) / duration : 0;

    for (const ls of this.sims) {
      const layer = ls.layer;
      if (!layer.enabled) continue;
      const em = layer.emission;
      const delay = em.delay;
      const localStart = t0 - delay;
      const localEnd = t1 - delay;

      // Continuous emission (skipped for non-prewarm layers during prewarm).
      if (!(this.prewarming && !em.prewarm) && localEnd > 0) {
        const activeStart = Math.max(localStart, 0);
        const activeDt = localEnd - activeStart;
        if (activeDt > 0) {
          const rate = evalRate(em.rateOverTime, tNorm);
          ls.acc += rate * activeDt;
          let n = Math.floor(ls.acc);
          ls.acc -= n;
          while (n-- > 0) ls.spawn();
        }
      }

      // Bursts (suppressed during prewarm — continuous only, E5).
      if (!this.prewarming) {
        for (const burst of em.bursts) {
          const count = burst.count;
          if (count <= 0) continue;
          for (let k = 0; k < count; k++) {
            const sk = count === 1 ? burst.time : burst.time + (burst.spread * k) / count;
            const lowerOk = inclusiveLower ? localStart <= sk : localStart < sk;
            if (lowerOk && sk <= localEnd) ls.spawn();
          }
        }
      }
    }
  }
}

export type { Layer };
