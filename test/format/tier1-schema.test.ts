import { describe, it, expect } from "vitest";
import { parseParticle, serializeParticle, validateParticle, type ParticleDoc } from "../../src/index.js";

// A "maximal" schemaVersion-3 document: every feature module non-null, both
// shape arc kinds, burst cycles, and velocity-over-lifetime tracks populated.
// It proves the whole v3 surface round-trips byte-stably (UI -> doc -> export ->
// import -> identical), which the per-property editor test cannot yet cover
// because the controls land milestone-by-milestone.
function maximalDoc(): ParticleDoc {
  const grad = { keys: [{ t: 0, r: 1, g: 0.5, b: 0.2, a: 1 }, { t: 1, r: 0, g: 0, b: 0, a: 0 }] };
  const curve = { mode: "curve" as const, keys: [{ t: 0, v: 1, ease: "easeOut" as const }, { t: 1, v: 0 }] };
  return {
    schemaVersion: 11,
    meta: { name: "Maximal", createdWith: "particlr@0.x", notes: "" },
    duration: 2,
    looping: true,
    seed: 4242,
    // A9 (schemaVersion 6): no params/bindings declared — unbound is the v5 path,
    // and an already-current doc round-trips without the migration injecting them.
    params: [],
    layers: [
      {
        id: "parent",
        name: "parent",
        enabled: true,
        blend: "add",
        texture: { ref: "spark", frames: null },
        emission: {
          rateOverTime: { mode: "constant", value: 40 },
          rateOverDistance: null,
          bursts: [{ time: 0, count: 12, spread: 0.1, cycles: 3, interval: 0.4, probability: 0.8 }],
          delay: 0,
          prewarm: false,
          maxParticles: 300,
        },
        shape: { kind: "circle", radius: 40, innerRadius: 12, arc: 270, arcMode: "loop", arcSpeed: 2, emitFrom: "surface" },
        space: "world",
        inheritVelocity: 0.3,
        attractorInfluence: 0,
        initial: {
          life: { mode: "range", min: 0.5, max: 1 },
          speed: { mode: "constant", value: 60 },
          size: { mode: "constant", value: 8 },
          rotation: { mode: "constant", value: 0 },
          angularVelocity: { mode: "constant", value: 0 },
        },
        overLifetime: {
          size: curve,
          color: grad,
          rotation: null,
          velocity: {
            gravity: { x: 0, y: 40 },
            drag: { mode: "constant", value: 1 },
            speedMultiplier: null,
            x: { mode: "constant", value: 5 },
            y: null,
            orbital: { mode: "constant", value: 90 },
            radial: { mode: "constant", value: 20 },
          },
        },
        limitVelocity: null,
        noise: { strength: curve, frequency: 0.02, scrollSpeed: 0.5, octaves: 2 },
        bySpeed: { range: { min: 0, max: 200 }, size: curve, color: grad, rotation: null },
        startColor: { mode: "palette", colors: [{ r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 1, b: 0, a: 1 }] },
        randomFlip: { x: 0.5, y: 0.25 },
        render: { align: "velocity", speedScale: 0.01, minStretch: 1, maxStretch: 4 },
        dissolve: null,
        collision: { shape: { kind: "rect", x: -100, y: -100, width: 200, height: 200 }, bounce: 0.6, dampen: 0.1, lifetimeLoss: 0.05 },
        attractor: null,
        subEmitters: [{ trigger: "death", layerId: "child", count: 8, probability: 0.9, inheritVelocity: 0.5 }],
        trail: null,
      },
      {
        id: "child",
        name: "child",
        enabled: true,
        blend: "add",
        texture: { ref: "spark", frames: null },
        emission: {
          rateOverTime: { mode: "constant", value: 0 },
          rateOverDistance: null,
          bursts: [],
          delay: 0,
          prewarm: false,
          maxParticles: 200,
        },
        shape: { kind: "cone", direction: -90, spread: 40, radius: 2, arcMode: "pingPong", arcSpeed: 1.5, emitFrom: "volume" },
        space: "world",
        inheritVelocity: 0,
        attractorInfluence: 0,
        initial: {
          life: { mode: "range", min: 0.3, max: 0.6 },
          speed: { mode: "range", min: 80, max: 160 },
          size: { mode: "constant", value: 4 },
          rotation: { mode: "constant", value: 0 },
          angularVelocity: { mode: "constant", value: 0 },
        },
        overLifetime: {
          size: curve,
          color: grad,
          rotation: null,
          velocity: { gravity: { x: 0, y: 100 }, drag: null, speedMultiplier: null, x: null, y: null, orbital: null, radial: null },
        },
        limitVelocity: null,
        noise: null,
        bySpeed: null,
        startColor: { mode: "gradients", a: grad, b: { keys: [{ t: 0, r: 0.2, g: 0.4, b: 1, a: 1 }] } },
        randomFlip: null,
        render: null,
        dissolve: null,
        collision: null,
        attractor: null,
        subEmitters: null,
        trail: { maxPoints: 16, minVertexDistance: 3, width: curve, color: grad },
      },
    ],
  };
}

describe("schemaVersion 3 — maximal document", () => {
  it("validates (with only unimplemented/authoring warnings)", () => {
    const r = validateParticle(maximalDoc());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.every((w) => w.code === "unimplemented" || w.code === undefined)).toBe(true);
  });

  it("round-trips byte-stably and deep-equal (export -> import -> identical)", () => {
    const doc = maximalDoc();
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc); // deep equal — every field survived
    expect(serializeParticle(back.doc!)).toBe(text); // byte-identical
  });

  it("is unchanged by re-migration (already current)", () => {
    const text = serializeParticle(maximalDoc());
    // parseParticle migrates internally; a v3 doc must pass through untouched.
    expect(serializeParticle(parseParticle(text).doc!)).toBe(text);
  });
});
