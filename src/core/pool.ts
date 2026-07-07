// Structure-of-arrays particle pool backed by typed arrays (plan WP-1.2).
// Fixed capacity = the layer's maxParticles. Dead particles are removed by
// swap-remove (last alive swaps into the freed slot) so live particles occupy
// [0, count); this ordering is part of the determinism contract (§2.7).

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

  private readonly all: Float32Array[];

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
    }
  }

  clear(): void {
    this.count = 0;
  }
}
