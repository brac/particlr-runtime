// Structure-of-arrays particle pool backed by typed arrays (plan WP-1.2).
// Fixed capacity = the layer's maxParticles. Dead particles are removed by
// swap-remove (last alive swaps into the freed slot) so live particles occupy
// [0, count); this ordering is part of the determinism contract (§2.7).
import { TrailStore } from "./trails.js";

/**
 * Which optional per-particle columns a pool must allocate (TIER1_PLAN §0.2).
 * Every flag is derived from the owning layer; an absent/false flag means the
 * column is never allocated and never looped, so a layer with all schemaVersion-3
 * modules null keeps the exact v2 pool footprint (and its snapshot digest). Later
 * milestones extend this with their own columns (M3 velRand*, M5 tint/flip,
 * M8 ordinal, M9 trail) — each additive, none disturbing the base layout. */
export interface PoolFlags {
  /** Per-particle noise phase, one draw at spawn (draw 14). Set iff layer.noise !== null. */
  noise?: boolean;
  /** Per-particle range-mode uniform for velocity.x over lifetime (draw 15). Set iff velocity.x !== null. */
  velX?: boolean;
  /** Per-particle range-mode uniform for velocity.y over lifetime (draw 16). Set iff velocity.y !== null. */
  velY?: boolean;
  /** Per-particle range-mode uniform for velocity.orbital over lifetime (draw 17). Set iff velocity.orbital !== null. */
  velOrbital?: boolean;
  /** Per-particle range-mode uniform for velocity.radial over lifetime (draw 18). Set iff velocity.radial !== null. */
  velRadial?: boolean;
  /** Per-particle start-color tint RGBA columns (draw 19). Set iff layer.startColor !== null. */
  tint?: boolean;
  /** Per-particle random-flip bitmask column (draws 20–21). Set iff layer.randomFlip !== null. */
  flip?: boolean;
  /** Per-particle monotone spawn ordinal (schemaVersion 3, M8). Set iff the layer
   * is a sub-emitter PARENT (layer.subEmitters !== null): its birth/death/collision
   * event streams key an independent child PRNG off each event particle's ordinal.
   * Draws nothing (assigned from a per-layer counter at spawn), so it never
   * perturbs the spawn stream. */
  ordinal?: boolean;
  /** Per-particle ribbon-trail ring buffer, `maxPoints` slots per particle
   * (schemaVersion 3, M9). Set to `layer.trail.maxPoints` iff the layer has a
   * trail module; the store's pts/head/len are registered as STRIDED columns so
   * swap-remove kill() moves a whole particle's ring block. Draws nothing. */
  trailMaxPoints?: number;
}

export class ParticlePool {
  readonly capacity: number;
  count = 0;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  readonly age: Float32Array;
  readonly lifetime: Float32Array;
  readonly sizeInit: Float32Array;
  readonly rotation: Float32Array;
  readonly angVel: Float32Array;
  readonly rand0: Float32Array;
  readonly rand1: Float32Array;
  readonly rand2: Float32Array;
  readonly rand3: Float32Array;
  readonly frameRand: Float32Array;
  /** Per-particle noise sampling phase (schemaVersion 3, draw 14); null unless
   * the layer has a noise module. Survives swap-remove like every column. */
  readonly noisePhase: Float32Array | null;
  /** Per-particle range-mode uniforms for the four velocity-over-lifetime tracks
   * (schemaVersion 3, draws 15–18); each null unless its track is non-null. They
   * feed range-mode tracks the same way rand0..3 feed the other over-lifetime
   * tracks. Survive swap-remove like every column. */
  readonly velRandX: Float32Array | null;
  readonly velRandY: Float32Array | null;
  readonly velRandOrbital: Float32Array | null;
  readonly velRandRadial: Float32Array | null;
  /** Per-particle start-color tint (schemaVersion 3, draw 19); each null unless
   * the layer has a startColor module. A constant multiplier over the
   * over-lifetime gradient (L7 amendment). Survive swap-remove like every column. */
  readonly tintR: Float32Array | null;
  readonly tintG: Float32Array | null;
  readonly tintB: Float32Array | null;
  readonly tintA: Float32Array | null;
  /** Per-particle random-flip bitmask (schemaVersion 3, draws 20–21); null unless
   * the layer has a randomFlip module. Bit 1 = flip X, bit 2 = flip Y. A
   * Uint8Array (values 0..3) — the swap-remove `all` list carries it alongside
   * the Float32 columns. */
  readonly flipBits: Uint8Array | null;
  /** Per-particle monotone spawn ordinal (schemaVersion 3, M8); null unless the
   * layer is a sub-emitter parent. A Uint32Array (values 0..2^32−1). Survives
   * swap-remove like every column so an event particle carries the SAME ordinal
   * regardless of how the pool has compacted since it spawned — the M7 event
   * scratch recorded the live index as a placeholder, which swap-remove could
   * reassign; the ordinal is the stable identity the event stream keys off. */
  readonly ordinal: Uint32Array | null;
  /** Per-particle ribbon-trail ring buffer (schemaVersion 3, M9); null unless the
   * layer has a trail module. Its pts (stride maxPoints·2), head and len (stride 1)
   * arrays are registered as STRIDED columns, so swap-remove kill() moves a whole
   * particle's block and the trail follows its particle. */
  readonly trail: TrailStore | null;

  // Float32 columns plus the single Uint8 flipBits column and the Uint32 ordinal
  // column are swap-removed together; all typed arrays support numeric index
  // read/write identically.
  private readonly all: (Float32Array | Uint8Array | Uint16Array | Uint32Array)[];
  // Strided columns (schemaVersion 3, M9): each holds `stride` values per
  // particle, so swap-remove copies a whole block rather than one element. Empty
  // for every layer without a trail — kill()'s strided loop is then a no-op.
  private readonly strided: { data: Float32Array | Uint16Array; stride: number }[] = [];

  constructor(capacity: number, flags: PoolFlags = {}) {
    this.capacity = capacity;
    const mk = () => new Float32Array(capacity);
    this.x = mk();
    this.y = mk();
    this.velX = mk();
    this.velY = mk();
    this.age = mk();
    this.lifetime = mk();
    this.sizeInit = mk();
    this.rotation = mk();
    this.angVel = mk();
    this.rand0 = mk();
    this.rand1 = mk();
    this.rand2 = mk();
    this.rand3 = mk();
    this.frameRand = mk();
    this.all = [
      this.x, this.y, this.velX, this.velY, this.age, this.lifetime, this.sizeInit,
      this.rotation, this.angVel, this.rand0, this.rand1, this.rand2, this.rand3, this.frameRand,
    ];
    // Optional columns are allocated only when their module is present, and
    // pushed onto `all` so swap-remove moves them with the base columns.
    this.noisePhase = flags.noise ? mk() : null;
    if (this.noisePhase) this.all.push(this.noisePhase);
    this.velRandX = flags.velX ? mk() : null;
    if (this.velRandX) this.all.push(this.velRandX);
    this.velRandY = flags.velY ? mk() : null;
    if (this.velRandY) this.all.push(this.velRandY);
    this.velRandOrbital = flags.velOrbital ? mk() : null;
    if (this.velRandOrbital) this.all.push(this.velRandOrbital);
    this.velRandRadial = flags.velRadial ? mk() : null;
    if (this.velRandRadial) this.all.push(this.velRandRadial);
    // Start-color tint (draw 19): four Float32 columns, allocated together.
    this.tintR = flags.tint ? mk() : null;
    this.tintG = flags.tint ? mk() : null;
    this.tintB = flags.tint ? mk() : null;
    this.tintA = flags.tint ? mk() : null;
    if (this.tintR) this.all.push(this.tintR, this.tintG!, this.tintB!, this.tintA!);
    // Random-flip bitmask (draws 20–21): one Uint8 column carried by swap-remove.
    this.flipBits = flags.flip ? new Uint8Array(capacity) : null;
    if (this.flipBits) this.all.push(this.flipBits);
    // Sub-emitter spawn ordinal (M8): one Uint32 column carried by swap-remove.
    this.ordinal = flags.ordinal ? new Uint32Array(capacity) : null;
    if (this.ordinal) this.all.push(this.ordinal);
    // Per-particle trail ring buffer (M9): allocated only when the layer has a
    // trail module. pts is strided (maxPoints·2 floats/particle); head and len
    // are stride-1 columns carried by the same swap-remove block copy.
    this.trail = flags.trailMaxPoints ? new TrailStore(capacity, flags.trailMaxPoints) : null;
    if (this.trail) {
      this.registerStrided(this.trail.pts, flags.trailMaxPoints! * 2);
      this.registerStrided(this.trail.head, 1);
      this.registerStrided(this.trail.len, 1);
    }
  }

  /** Register a strided per-particle column (schemaVersion 3, M9): `stride`
   * consecutive values per particle. swap-remove kill() copies the whole
   * `stride`-value block from the last slot into the freed one, so a strided
   * store (like the trail ring buffer) follows its particle through compaction. */
  registerStrided(data: Float32Array | Uint16Array, stride: number): void {
    this.strided.push({ data, stride });
  }

  /** Allocate a slot for a new particle; returns its index, or -1 if full (E7). */
  spawn(): number {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  /** Swap-remove the particle at index i (last alive moves into slot i). */
  kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      for (const arr of this.all) arr[i] = arr[last]!;
      // Strided columns (M9): copy the whole per-particle block. Empty for every
      // non-trail layer, so this loop is a no-op there (kill stays byte-identical).
      for (const s of this.strided) {
        const di = i * s.stride;
        const dl = last * s.stride;
        for (let k = 0; k < s.stride; k++) s.data[di + k] = s.data[dl + k]!;
      }
    }
  }

  clear(): void {
    this.count = 0;
  }
}
