// Source of truth for the committed .spark fixtures. Run with:
//   npx tsx test/fixtures/_generate.ts
// It builds the documents as objects and writes them through serializeSpark so
// the files are guaranteed canonical (plan §2.10) and byte-stable on round-trip.
// The round-trip test (roundtrip.test.ts) then re-derives and diffs the bytes,
// so any hand-edit that breaks canonical form is caught.
import { serializeSpark, type SparkDoc } from "../../src/index.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

const explosion: SparkDoc = {
  schemaVersion: 2,
  meta: { name: "Explosion", createdWith: "particlr@0.x", notes: "Flash + fireball + smoke. Slice One reference effect." },
  duration: 1.2,
  looping: true,
  seed: 1337,
  layers: [
    {
      id: "flash",
      name: "flash",
      enabled: true,
      blend: "add",
      texture: { ref: "circle-soft", frames: null },
      emission: {
        rateOverTime: { mode: "constant", value: 0 },
        bursts: [{ time: 0, count: 1, spread: 0 }],
        delay: 0,
        rateOverDistance: null,
        prewarm: false,
        maxParticles: 4,
      },
      shape: { kind: "point", emitFrom: "volume" },
      initial: {
        life: { mode: "constant", value: 0.15 },
        speed: { mode: "constant", value: 0 },
        size: { mode: "constant", value: 140 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: { mode: "curve", keys: [{ t: 0, v: 1, ease: "easeOut" }, { t: 1, v: 0.2 }] },
        color: {
          keys: [
            { t: 0, r: 1, g: 1, b: 0.9, a: 1 },
            { t: 1, r: 1, g: 0.8, b: 0.4, a: 0 },
          ],
        },
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null },
      },
      space: "local",
      inheritVelocity: 0,
      subEmitters: null,
      trail: null,
    },
    {
      id: "fireball",
      name: "fireball",
      enabled: true,
      blend: "add",
      texture: { ref: "circle-soft", frames: null },
      emission: {
        rateOverTime: { mode: "constant", value: 0 },
        bursts: [{ time: 0, count: 24, spread: 0 }],
        delay: 0,
        rateOverDistance: null,
        prewarm: false,
        maxParticles: 64,
      },
      shape: { kind: "circle", radius: 8, emitFrom: "volume" },
      initial: {
        life: { mode: "range", min: 0.4, max: 0.7 },
        speed: { mode: "range", min: 60, max: 160 },
        size: { mode: "range", min: 18, max: 34 },
        rotation: { mode: "range", min: 0, max: 360 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: { mode: "curve", keys: [{ t: 0, v: 1, ease: "easeOut" }, { t: 1, v: 0 }] },
        color: {
          keys: [
            { t: 0, r: 1, g: 0.9, b: 0.5, a: 1 },
            { t: 0.4, r: 1, g: 0.35, b: 0.08, a: 1 },
            { t: 1, r: 0.4, g: 0.05, b: 0, a: 0 },
          ],
        },
        rotation: null,
        velocity: {
          gravity: { x: 0, y: 40 },
          drag: { mode: "constant", value: 2.5 },
          speedMultiplier: null,
        },
      },
      space: "local",
      inheritVelocity: 0,
      subEmitters: null,
      trail: null,
    },
    {
      id: "smoke",
      name: "smoke",
      enabled: true,
      blend: "normal",
      texture: { ref: "smoke", frames: null },
      emission: {
        rateOverTime: { mode: "constant", value: 20 },
        bursts: [],
        delay: 0.05,
        rateOverDistance: null,
        prewarm: false,
        maxParticles: 128,
      },
      shape: { kind: "circle", radius: 12, emitFrom: "volume" },
      initial: {
        life: { mode: "range", min: 0.8, max: 1.4 },
        speed: { mode: "range", min: 10, max: 40 },
        size: { mode: "range", min: 30, max: 60 },
        rotation: { mode: "range", min: 0, max: 360 },
        angularVelocity: { mode: "range", min: -30, max: 30 },
      },
      overLifetime: {
        size: { mode: "curve", keys: [{ t: 0, v: 0.6, ease: "easeOut" }, { t: 1, v: 1.6 }] },
        color: {
          keys: [
            { t: 0, r: 0.3, g: 0.3, b: 0.32, a: 0 },
            { t: 0.2, r: 0.28, g: 0.28, b: 0.3, a: 0.5 },
            { t: 1, r: 0.15, g: 0.15, b: 0.17, a: 0 },
          ],
        },
        rotation: null,
        velocity: {
          gravity: { x: 0, y: -20 },
          drag: { mode: "constant", value: 1.5 },
          speedMultiplier: null,
        },
      },
      space: "local",
      inheritVelocity: 0,
      subEmitters: null,
      trail: null,
    },
  ],
};

// A minimal valid doc annotated with unknown fields at every nesting level, to
// prove unknown-field preservation + byte-stable round-trip (plan §2.10).
const unknowns = {
  schemaVersion: 2,
  meta: { name: "Unknowns", createdWith: "particlr@0.x", notes: "", metaExtra: "kept" },
  duration: 1,
  looping: false,
  seed: 1,
  layers: [
    {
      id: "l1",
      name: "layer",
      enabled: true,
      blend: "normal",
      texture: { ref: "square", frames: null, textureExtra: 7 },
      emission: {
        rateOverTime: { mode: "constant", value: 5, trackExtra: true },
        bursts: [],
        delay: 0,
        rateOverDistance: null,
        prewarm: false,
        maxParticles: 16,
        emissionExtra: [1, 2, 3],
      },
      shape: { kind: "point", emitFrom: "volume" },
      initial: {
        life: { mode: "constant", value: 1 },
        speed: { mode: "constant", value: 0 },
        size: { mode: "constant", value: 10 },
        rotation: { mode: "constant", value: 0 },
        angularVelocity: { mode: "constant", value: 0 },
      },
      overLifetime: {
        size: null,
        color: { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1, keyExtra: "x" }] },
        rotation: null,
        velocity: { gravity: { x: 0, y: 0 }, drag: null, speedMultiplier: null },
      },
      space: "local",
      inheritVelocity: 0,
      subEmitters: null,
      trail: null,
      layerExtra: { nested: { deep: [true, null, "value"] } },
    },
  ],
  futureField: { z: 1, a: [1, 2], nested: { keep: "me" } },
} as unknown as SparkDoc;

writeFileSync(resolve(dir, "explosion.spark"), serializeSpark(explosion));
writeFileSync(resolve(dir, "unknowns.spark"), serializeSpark(unknowns));
console.log("wrote explosion.spark, unknowns.spark");
