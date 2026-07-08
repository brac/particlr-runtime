// Effect: a running instance of a .prt document. Owns one LayerSim per layer,
// drives emission timing (§2.8), motion integration (via LayerSim.update), the
// effect clock, prewarm (E5), dt clamping (E1/E2), and isDone (E6). This is the
// same code path the editor preview and the shipped runtime both use (L4).
import type { Layer, ScalarTrack, ParticleDoc, Shape, SubEmitterRef } from "../format/types.js";
import { deriveLayerSeed, mulberry32 } from "./prng.js";
import { evalCurve } from "./tracks.js";
import { LayerSim } from "./layerSim.js";

// Sub-emitter event codes (schemaVersion 3, §0.2). Fixed integers folded into the
// child-stream seed formula; also index which per-layer event scratch to consume.
const EVENT_BIRTH = 1;
const EVENT_DEATH = 2;
const EVENT_COLLISION = 3;
// Golden constants of the child-stream seed mix (§0.2). Two odd 32-bit constants
// (the golden-ratio and an xxHash prime) decorrelate the three inputs.
const SEED_MIX_ORDINAL = 0x9e3779b9;
const SEED_MIX_EVENTCODE = 0x85ebca6b;

/** One resolved sub-emitter entry: the child sim it spawns into, its event code,
 * and the authored ref (count/probability/inheritVelocity). Resolved ONCE at
 * construction so processing never does a per-event layer lookup. */
interface SubEntry {
  entry: SubEmitterRef;
  child: LayerSim;
  eventCode: number;
}
/** A parent layer that owns at least one resolvable sub-emitter entry. */
interface ParentPlan {
  index: number; // layer index → parent layer seed via deriveLayerSeed
  sim: LayerSim;
  entries: SubEntry[];
}

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

  // Sub-emitter plan (schemaVersion 3, M8), built once at construction. `parents`
  // lists (in layer index order) every layer that spawns children, with its
  // resolved entries. `wantBirth/Death/Collision` are per-sim-index recorder
  // desires; each advance sets the sim's live recorder to `want && !prewarming`, so
  // event capture is suppressed during prewarm (E19) with a single check.
  private parents: ParentPlan[] = [];
  private wantBirth: boolean[] = [];
  private wantDeath: boolean[] = [];
  private wantCollision: boolean[] = [];

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
    this.buildSubEmitterPlan();
    this.runPrewarm();
  }

  /**
   * Resolve the sub-emitter graph once (schemaVersion 3, M8). For each layer with
   * `subEmitters`, resolve every entry's target LayerSim by id (a map, not a
   * per-event `find`) and mark which recorders the parent needs. Depth-1 is a
   * validator invariant, so a child never itself appears here as a parent unless
   * the document is invalid; this method only reads a layer's OWN `subEmitters`,
   * so it can never recurse into a child's — the sub-emitter graph is strictly one
   * level deep by construction. Unresolvable / self references are skipped
   * defensively (the validator already rejects them).
   */
  private buildSubEmitterPlan(): void {
    const n = this.sims.length;
    this.wantBirth = new Array<boolean>(n).fill(false);
    this.wantDeath = new Array<boolean>(n).fill(false);
    this.wantCollision = new Array<boolean>(n).fill(false);
    this.parents = [];
    const byId = new Map<string, LayerSim>();
    for (const ls of this.sims) byId.set(ls.layer.id, ls);
    this.sims.forEach((sim, index) => {
      const subs = sim.layer.subEmitters;
      if (subs === null || subs.length === 0) return;
      const entries: SubEntry[] = [];
      for (const entry of subs) {
        const child = byId.get(entry.layerId);
        if (child === undefined || child === sim) continue; // validated out; guard
        const eventCode =
          entry.trigger === "birth" ? EVENT_BIRTH : entry.trigger === "death" ? EVENT_DEATH : EVENT_COLLISION;
        if (eventCode === EVENT_BIRTH) this.wantBirth[index] = true;
        else if (eventCode === EVENT_DEATH) this.wantDeath[index] = true;
        else this.wantCollision[index] = true;
        entries.push({ entry, child, eventCode });
      }
      if (entries.length > 0) this.parents.push({ index, sim, entries });
    });
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
    const capture = !this.prewarming; // event capture belongs to the visible cycle (E19)
    for (let i = 0; i < this.sims.length; i++) {
      const ls = this.sims[i]!;
      ls.capped = false;
      // Set the sub-emitter recorders for this step (M8): a parent records the
      // triggers it feeds, but never during prewarm. Cheap booleans; the update
      // and spawn recorders below read them. Non-parent layers keep all three off.
      ls.recordBirthEvents = capture && this.wantBirth[i]!;
      ls.recordDeathEvents = capture && this.wantDeath[i]!;
      ls.recordCollisionEvents = capture && this.wantCollision[i]!;
      ls.setEmitterStep(this.stepStartX, this.stepStartY, this.stepEndX, this.stepEndY, this.evx, this.evy);
      ls.setClock(tStart); // schemaVersion 3: scroll the noise field over effect time
      if (ls.layer.enabled) ls.update(dt);
    }
    this.emit(dt);
    this.emitDistance(dt, tStart);
    // Sub-emitter processing (M8) runs AFTER update+emit+emitDistance so it sees a
    // complete set of this step's birth/death/collision events, and is suppressed
    // during prewarm (E19). Children spawn with age 0 and first integrate next step.
    if (capture) this.processSubEmitters();
  }

  /**
   * Spawn sub-emitter children for every event captured this step (schemaVersion 3,
   * M8). Normative order: parents in layer index order, each parent's entries in
   * array order, each entry's events in capture order. Every event derives its own
   * independent PRNG stream (§0.2) so the child layer's OWN emission stream is never
   * touched — the child continuous stream stays byte-identical whether or not events
   * fire into it. A pool-full child drops silently (E7); the draws are deterministic
   * regardless because the child's fill state is itself deterministic.
   */
  private processSubEmitters(): void {
    for (const parent of this.parents) {
      // Recompute the parent layer seed from the CURRENT effect seed each step so a
      // reset(seed) is honored (deriveLayerSeed is cheap and pure).
      const parentLayerSeed = deriveLayerSeed(this.effectSeed, parent.index);
      const parentLocal = parent.sim.layer.space === "local";
      for (const { entry, child, eventCode } of parent.entries) {
        const scratch =
          eventCode === EVENT_BIRTH
            ? parent.sim.birthEvents
            : eventCode === EVENT_DEATH
              ? parent.sim.deathEvents
              : parent.sim.collisionEvents;
        if (scratch === null || scratch.length === 0) continue;
        const childLocal = child.layer.space === "local";
        for (let e = 0; e + 4 < scratch.length; e += 5) {
          const ex = scratch[e]!;
          const ey = scratch[e + 1]!;
          const evx = scratch[e + 2]!;
          const evy = scratch[e + 3]!;
          const ordinal = scratch[e + 4]!;
          // Child-stream seed (§0.2): decorrelate by ordinal and event code.
          const eventSeed =
            (parentLayerSeed ^ Math.imul(ordinal + 1, SEED_MIX_ORDINAL) ^ Math.imul(eventCode, SEED_MIX_EVENTCODE)) >>> 0;
          const rng = mulberry32(eventSeed);
          // Probability gate (§0.2): ONE draw iff probability !== 1; fires iff the
          // draw < probability. probability === 1 takes no draw (migration default).
          if (entry.probability !== 1 && rng() >= entry.probability) continue;
          // Frame conversion (E22). Velocity is translation-invariant, so only the
          // position needs the emitter-relative shift; pass velocity through.
          let ox = ex;
          let oy = ey;
          if (parentLocal !== childLocal) {
            if (parentLocal) {
              // parent-local event → child-world: add the step-end emitter position.
              ox = ex + this.stepEndX;
              oy = ey + this.stepEndY;
            } else {
              // parent-world event → child-local: subtract it.
              ox = ex - this.stepEndX;
              oy = ey - this.stepEndY;
            }
          }
          const bvx = entry.inheritVelocity * evx;
          const bvy = entry.inheritVelocity * evy;
          for (let k = 0; k < entry.count; k++) child.spawnFrom(rng, ox, oy, bvx, bvy);
        }
      }
    }
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
          // A new loop pass re-rolls every probability-gated burst cycle
          // (§0.2, M4): forget the previous pass's gate outcomes. No-op (null
          // state) for probability-1 documents and during prewarm.
          for (const ls of this.sims) ls.clearBurstGates();
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
      // Push the interval-start normalized time (schemaVersion 3, §M5): a
      // gradients-mode startColor draw samples both gradients at this t, so
      // every burst and continuous spawn in this interval shares it (same
      // precedent as evalRate's normalized time). Inert for null-startColor layers.
      ls.setSpawnTNorm(tNorm);
      const em = layer.emission;
      const delay = em.delay;
      const localStart = t0 - delay;
      const localEnd = t1 - delay;
      // Arc sweep (schemaVersion 3, M4). Only circle/cone carry an arcMode; a
      // "random" mode (every v2/migrated shape) leaves arcActive false, so the
      // spawn path is byte-identical to v2 — arcT stays -1 and is inert.
      const shape = layer.shape;
      const arcActive = (shape.kind === "circle" || shape.kind === "cone") && shape.arcMode !== "random";

      // Bursts fire BEFORE continuous emission when both land in the same step:
      // burst particles take their PRNG draws first and win contested pool slots
      // near the cap (normative order — IMPLEMENTATION_PLAN §emission). (P2.1)
      // Suppressed during prewarm (continuous only, E5).
      if (!this.prewarming) {
        for (let bi = 0; bi < em.bursts.length; bi++) {
          const burst = em.bursts[bi]!;
          const count = burst.count;
          if (count <= 0) continue;
          // At most `capacity` particles can ever exist, so iterating past it
          // can only produce capped no-ops — bound a hostile count (e.g. 2^31)
          // to <= capacity iterations. Sub-event *times* still use the full
          // `count` denominator, so any doc with count <= capacity (every preset
          // and every validated doc) is unaffected. (P1.3)
          const iterations = Math.min(count, ls.pool.capacity);
          if (count > iterations) ls.capped = true;
          // Default to the v2-equivalent single always-firing burst when a field
          // is absent (hand-built layers in tests; migrated docs always carry
          // cycles 1 / interval 0 / probability 1, so this is byte-identical).
          const cycles = burst.cycles ?? 1;
          const interval = burst.interval ?? 0;
          const prob = burst.probability ?? 1;
          // A burst repeats `cycles` times (schemaVersion 3, M4), cycle c's window
          // opening at `time + c·interval`; crossing detection is per (burst,
          // cycle). Cycles ascending, bursts in array order — the fixed order the
          // probability gate draw interleaves against (§0.2).
          for (let c = 0; c < cycles; c++) {
            const cycleTime = burst.time + c * interval;
            // Pre-spawn probability draw (§0.2, normative): iff probability !== 1,
            // ONE draw from the layer stream per due burst cycle, taken immediately
            // before that cycle's spawns (bursts in array order, cycles ascending).
            // "Due" means ≥ 1 sub-event crosses this interval; the roll happens on
            // the FIRST such interval and the outcome is remembered by LayerSim for
            // the cycle's remaining sub-events (a spread window spanning several
            // steps is all-or-nothing — no re-roll, no extra draws). Gate fires iff
            // the draw is < probability. probability === 1 (the migration default)
            // ⇒ zero draws and zero state, so a migrated doc's stream is
            // byte-identical to v2.
            if (prob !== 1) {
              let due = false;
              for (let k = 0; k < iterations; k++) {
                const sk = count === 1 ? cycleTime : cycleTime + (burst.spread * k) / (count - 1);
                const lowerOk = inclusiveLower ? localStart <= sk : localStart < sk;
                if (lowerOk && sk <= localEnd) {
                  due = true;
                  break;
                }
              }
              if (!due) continue;
              if (!ls.burstGateFired(bi, c, prob)) continue; // suppressed for the WHOLE cycle
            }
            for (let k = 0; k < iterations; k++) {
              // Sub-events spread evenly across [cycleTime, cycleTime + spread]
              // *inclusive*: with count >= 2 the last lands exactly at the end. (P2.2)
              const sk = count === 1 ? cycleTime : cycleTime + (burst.spread * k) / (count - 1);
              const lowerOk = inclusiveLower ? localStart <= sk : localStart < sk;
              // World-space spawn fraction: the sub-event's offset within the step
              // (schemaVersion 2). Ignored by local layers.
              if (lowerOk && sk <= localEnd) {
                // burstSpread fans this burst's `count` sub-events evenly across
                // the arc (k/(count−1)); loop/pingPong sweep by the sub-event's
                // effect time (sk + delay). (M4)
                const arcT = arcActive ? this.arcTFor(shape, sk + delay, k, count) : -1;
                ls.spawn(clamp01((elapsed + (sk - localStart)) * invDt), arcT);
              }
            }
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
            // Continuous emission has no discrete burst to fan across, so
            // burstSpread falls back to random (E21); loop/pingPong sweep by the
            // spawn's effect time (local time + delay). (M4)
            let arcT = -1;
            if (arcActive) {
              const spawnLocal = activeStart + (activeDt * (s + 0.5)) / n;
              arcT = this.arcTFor(shape, spawnLocal + delay, -1, 0);
            }
            ls.spawn(clamp01((baseOffset + (activeDt * (s + 0.5)) / n) * invDt), arcT);
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
      // Distance-emitted spawns share the interval-start normalized time too
      // (schemaVersion 3, §M5), so a gradients-mode startColor draw is well
      // defined on this path. Inert for null-startColor layers.
      ls.setSpawnTNorm(tNorm);
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
      // Distance emission is continuous, so burstSpread falls back to random
      // (E21); loop/pingPong sweep by each spawn's midpoint time within the step
      // (mirroring continuous emission's per-spawn granularity, M4) — a fast
      // emitter must not stamp a whole step's spawns at one arc angle.
      const shape = layer.shape;
      const arcActive = (shape.kind === "circle" || shape.kind === "cone") && shape.arcMode !== "random";
      for (let k = 0; k < m; k++) {
        const f = (k + 0.5) / m;
        const arcT = arcActive ? this.arcTFor(shape, tStart + f * dt, -1, 0) : -1;
        ls.spawn(f, arcT);
      }
    }
  }

  /**
   * Driven arc-angle fraction for a spawn (schemaVersion 3, M4), in [0,1], or
   * `-1` meaning "no override — use the drawn angle uniform" (random mode, and
   * burstSpread for continuous emission, E21). `spawnTime` is the spawn's effect
   * time; `burstK`/`burstCount` describe a burst sub-event (`burstK < 0` for
   * continuous emission).
   */
  private arcTFor(shape: Shape, spawnTime: number, burstK: number, burstCount: number): number {
    if (shape.kind !== "circle" && shape.kind !== "cone") return -1;
    switch (shape.arcMode) {
      case "loop": {
        // One full sweep (0→1) per 1/arcSpeed seconds; wrap with frac.
        const p = spawnTime * shape.arcSpeed;
        return p - Math.floor(p);
      }
      case "pingPong": {
        // Triangle wave over the same period, sweeping 0→1→0 (no seam jump).
        const p = spawnTime * shape.arcSpeed;
        const phase = p - Math.floor(p);
        return phase < 0.5 ? phase * 2 : 2 - phase * 2;
      }
      case "burstSpread": {
        if (burstK < 0) return -1; // continuous emission has no burst to fan (E21)
        // Single-particle burst: emit at the arc start (arcT = 0) — documented
        // guard for the k/(count−1) division when count === 1.
        if (burstCount <= 1) return 0;
        return burstK / (burstCount - 1);
      }
      default:
        return -1; // "random": use the drawn angle uniform
    }
  }
}

export type { Layer };
