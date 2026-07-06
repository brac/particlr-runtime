import { describe, it, expect } from "vitest";
import { ParticlePool } from "../../src/index.js";

describe("ParticlePool", () => {
  it("allocates slots in order and reports full via -1 (E7)", () => {
    const p = new ParticlePool(2);
    expect(p.spawn()).toBe(0);
    expect(p.spawn()).toBe(1);
    expect(p.spawn()).toBe(-1);
    expect(p.count).toBe(2);
  });

  it("swap-removes: last alive moves into the freed slot", () => {
    const p = new ParticlePool(4);
    p.spawn();
    p.spawn();
    p.spawn();
    p.x[0] = 10;
    p.x[1] = 20;
    p.x[2] = 30;
    p.kill(0);
    expect(p.count).toBe(2);
    expect(p.x[0]).toBe(30); // last (30) swapped into slot 0
    expect(p.x[1]).toBe(20);
  });

  it("killing the last particle just shrinks count", () => {
    const p = new ParticlePool(4);
    p.spawn();
    p.spawn();
    p.x[1] = 99;
    p.kill(1);
    expect(p.count).toBe(1);
    expect(p.x[0]).toBe(0);
  });

  it("clear resets count", () => {
    const p = new ParticlePool(4);
    p.spawn();
    p.spawn();
    p.clear();
    expect(p.count).toBe(0);
  });
});
