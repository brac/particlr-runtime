// Per-particle ribbon trail storage (schemaVersion 3, M9). A ring buffer of the
// last `maxPoints` positions per live particle, registered with the pool as
// strided columns so swap-remove kill() moves a whole particle's block and the
// trail follows its particle. Only allocated when the layer has a trail module;
// a trail-null layer never constructs one, so the store is zero-cost otherwise.
export class TrailStore {
  readonly maxPoints: number;
  /** capacity · maxPoints · 2 floats: [x, y] per ring slot, blocked per particle
   * (particle i occupies pts[i·maxPoints·2 .. +maxPoints·2)). */
  readonly pts: Float32Array;
  /** Ring head — index of the newest recorded slot — per particle. */
  readonly head: Uint16Array;
  /** Number of valid recorded points per particle (1..maxPoints). */
  readonly len: Uint16Array;

  constructor(capacity: number, maxPoints: number) {
    this.maxPoints = maxPoints;
    // Validator caps (maxParticles ≤ 10000, maxPoints ≤ 32) bound this ring
    // buffer at 10000·32·2·4 B ≈ 2.5 MB worst case — its whole footprint.
    this.pts = new Float32Array(capacity * maxPoints * 2);
    this.head = new Uint16Array(capacity);
    this.len = new Uint16Array(capacity);
  }

  /** Record the spawn position as the first (head) point (len = 1). */
  spawn(i: number, x: number, y: number): void {
    const b = i * this.maxPoints * 2;
    this.pts[b] = x;
    this.pts[b + 1] = y;
    this.head[i] = 0;
    this.len[i] = 1;
  }

  /** Push the current position as a new head point when it has moved at least
   * √minDistSq from the last recorded point (ring: overwrite the oldest slot
   * when the buffer is full). Below the threshold nothing is recorded. */
  push(i: number, x: number, y: number, minDistSq: number): void {
    const mp = this.maxPoints;
    const b = i * mp * 2;
    const h = this.head[i]!;
    const dx = x - this.pts[b + h * 2]!;
    const dy = y - this.pts[b + h * 2 + 1]!;
    if (dx * dx + dy * dy < minDistSq) return; // gate: push iff dist² ≥ minDistSq
    const nh = h + 1 === mp ? 0 : h + 1;
    this.pts[b + nh * 2] = x;
    this.pts[b + nh * 2 + 1] = y;
    this.head[i] = nh;
    const l = this.len[i]!;
    if (l < mp) this.len[i] = l + 1;
  }
}
