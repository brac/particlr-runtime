// The FORMAT_SPEC edge-case table E1–E14, each with its locked outcome.
// Validator-scope cases (E3, E4, E11, E12, E13, E14) are asserted here now.
// Runtime-scope cases (E1, E2, E5, E6, E7, E8, E9, E10) are recorded as todos
// that WP-1.x / WP-3.x convert into executable assertions against the runtime.
import { describe, it, expect } from "vitest";
import { validateParticle, parseParticle } from "../../src/index.js";
import { makeDoc, makeLayer } from "./_helpers.js";

const curveSize = (keys: { t: number; v: number }[]) =>
  makeDoc({ layers: [makeLayer({ overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys } } })] });

describe("FORMAT_SPEC edge cases — locked outcomes", () => {
  // --- Runtime-scope: valid docs; behavior asserted in later phases ---
  it("E1: dt > maxDt clamps to 1/20 (never sub-steps)");
  it("E2: dt <= 0 is a no-op step");
  it("E5: burst at t=0 with prewarm — prewarm affects continuous emission only");
  it("E6: looping:false ends emission, particles live out; isDone when count hits 0");
  it("E7: pool exhausted -> spawns dropped silently, layer.capped flag set");
  it("E8: scrub re-simulates from t=0 with current seed (exact by determinism)");
  it("E9: export serializes the authored doc, never live playback state");
  it("E10: missing user texture -> substitute soft circle + non-blocking warning");

  // --- Validator-scope: asserted now ---
  it("E3: a one-key curve is valid (evaluates constant)", () => {
    expect(validateParticle(curveSize([{ t: 0, v: 0.5 }])).ok).toBe(true);
  });

  it("E4: a zero-key curve is rejected at import", () => {
    const r = validateParticle(curveSize([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "empty-curve")).toBe(true);
  });

  it("E11: a newer schemaVersion is refused (never best-effort parsed)", () => {
    const r = parseParticle({ ...makeDoc(), schemaVersion: 12 as 11 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("newer-version");
  });

  it("E12: duplicate keys at the same t are allowed (last wins at eval)", () => {
    expect(validateParticle(curveSize([{ t: 0.5, v: 1 }, { t: 0.5, v: 0 }])).ok).toBe(true);
  });

  it("E13: duration below 0.05 is invalid (floor)", () => {
    expect(validateParticle(makeDoc({ duration: 0.049 })).ok).toBe(false);
    expect(validateParticle(makeDoc({ duration: 0 })).ok).toBe(false);
  });

  it("E14: a zero-layer document is valid (renders nothing)", () => {
    expect(validateParticle(makeDoc({ layers: [] })).ok).toBe(true);
  });
});
