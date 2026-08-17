import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Mesh } from "three";
import { parseParticle } from "../../src/index.js";
import { Effect } from "../../src/core/effect.js";
import { ThreeParticleRenderer } from "../../src/three/renderer.js";
import { presetsDir, hasPresets } from "../_presets.js";

// comet is the per-particle-ribbon preset (tests/golden golden.spec.ts M9 note).
describe.skipIf(!hasPresets)("three trails", () => {
  it("a trail layer adds a ribbon mesh BEHIND its sprite mesh, with live draw range", () => {
    const parsed = parseParticle(readFileSync(resolve(presetsDir, "comet.prt"), "utf8"));
    if (!parsed.ok) throw new Error("fixture invalid");
    const fx = new Effect(parsed.doc!, { seed: 1337 });
    const r = new ThreeParticleRenderer(fx);
    const trailIdx = fx.layers.findIndex((ls) => ls.layer.trail !== null);
    expect(trailIdx).toBeGreaterThanOrEqual(0);
    // Child order: ribbon first (renders under), sprites second — mirror Pixi's
    // "mesh added BEFORE the ParticleContainer" rule (renderer.ts:258).
    // Locate this layer's pair among root.children and assert ribbon index < sprite index.
    for (let f = 0; f < 40; f++) fx.step(1 / 60);
    r.sync();
    const ribbons = r.root.children.filter((c) => c.userData.particlrTrail === true) as Mesh[];
    expect(ribbons.length).toBeGreaterThan(0);
    const ribbon = ribbons[0]!;
    expect(ribbon.geometry.drawRange.count).toBeGreaterThan(0);
    expect(r.root.children.indexOf(ribbon)).toBeLessThan(
      r.root.children.indexOf(r.root.children.find((c) => c.userData.particlrLayer === trailIdx && c.userData.particlrTrail !== true)!),
    );
    r.destroy();
  });
  it("empty frame draws zero trail indices", () => {
    const parsed = parseParticle(readFileSync(resolve(presetsDir, "comet.prt"), "utf8"));
    if (!parsed.ok) throw new Error("fixture invalid");
    const fx = new Effect(parsed.doc!, { seed: 1337 });
    const r = new ThreeParticleRenderer(fx);
    r.sync(); // frame 0, nothing alive yet (comet emits over time; if frame 0 already has particles, assert after reset instead)
    const ribbon = r.root.children.find((c) => c.userData.particlrTrail === true) as Mesh;
    expect(ribbon.geometry.drawRange.count).toBe(0);
    r.destroy();
  });
});
