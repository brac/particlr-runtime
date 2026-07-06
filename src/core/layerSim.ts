// Per-layer simulation: spawning (fixed PRNG draw order, §2.7) and the per-step
// integration of motion (§2.4), rotation (§2.5), ageing, and death. Emission
// *timing* (when to call spawn) lives in Effect (§2.8); this class only knows
// how to make one particle and how to advance the ones it has.
import type { Layer } from "../format/types.js";
import { mulberry32, type Rng } from "./prng.js";
import { drawScalarInit, evalScalarTrack } from "./tracks.js";
import { ParticlePool } from "./pool.js";
import { sampleShape } from "./shapes.js";

const RAD = Math.PI / 180;

export class LayerSim {
  readonly layer: Layer;
  readonly pool: ParticlePool;
  private rng: Rng;
  /** True if a spawn was dropped since the flag was last reset (E7). */
  capped = false;
  /** Continuous-emission fractional accumulator (§2.8), owned by Effect. */
  acc = 0;

  constructor(layer: Layer, layerSeed: number) {
    this.layer = layer;
    this.pool = new ParticlePool(layer.emission.maxParticles);
    this.rng = mulberry32(layerSeed);
  }

  get count(): number {
    return this.pool.count;
  }

  reset(layerSeed: number): void {
    this.rng = mulberry32(layerSeed);
    this.pool.clear();
    this.capped = false;
    this.acc = 0;
  }

  /**
   * Spawn one particle. Performs exactly the fixed 13 draws in the normative
   * order regardless of shape/mode (§2.7). If the pool is full the spawn is
   * dropped with no draws (deterministic) and `capped` is set; returns false.
   */
  spawn(): boolean {
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

    const i = p.spawn();
    const s = sampleShape(this.layer.shape, uPos1, uPos2, uDir);
    const dirRad = s.dirDeg * RAD;
    p.x[i] = s.px;
    p.y[i] = s.py;
    p.velX[i] = speed * Math.cos(dirRad);
    p.velY[i] = speed * Math.sin(dirRad);
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
