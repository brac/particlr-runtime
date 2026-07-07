import { describe, it, expect } from "vitest";
import { validateSpark } from "../../src/index.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

function errPaths(input: unknown): string[] {
  const r = validateSpark(input);
  return r.ok ? [] : r.errors.map((e) => e.path);
}
function firstCode(input: unknown): string | undefined {
  const r = validateSpark(input);
  return r.ok ? undefined : r.errors[0]?.code;
}

describe("validateSpark — happy path", () => {
  it("accepts a complete valid document", () => {
    const r = validateSpark(makeDoc());
    expect(r.ok).toBe(true);
  });

  it("accepts a zero-layer document (E14)", () => {
    const r = validateSpark(makeDoc({ layers: [] }));
    expect(r.ok).toBe(true);
  });
});

describe("validateSpark — document rules", () => {
  it("rejects a non-object", () => {
    expect(validateSpark(42 as unknown).ok).toBe(false);
  });

  it("rejects schemaVersion < 1 or non-integer", () => {
    expect(firstCode(makeDoc({ schemaVersion: 0 as 2 }))).toBe("invalid-version");
    expect(firstCode(makeDoc({ schemaVersion: 1.5 as 2 }))).toBe("invalid-version");
  });

  it("refuses a newer schemaVersion (E11)", () => {
    expect(firstCode(makeDoc({ schemaVersion: 3 as 2 }))).toBe("newer-version");
  });

  it("rejects duration below the 0.05 floor (E13)", () => {
    const r = validateSpark(makeDoc({ duration: 0.01 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "duration-floor")).toBe(true);
  });

  it("accepts duration exactly at the floor", () => {
    expect(validateSpark(makeDoc({ duration: 0.05 })).ok).toBe(true);
  });

  it("rejects non-boolean looping and non-number seed", () => {
    expect(errPaths(makeDoc({ looping: "yes" as unknown as boolean }))).toContain("looping");
    expect(errPaths(makeDoc({ seed: "x" as unknown as number }))).toContain("seed");
  });

  it("rejects more than 4 layers", () => {
    const many = [makeLayer(), makeLayer(), makeLayer(), makeLayer(), makeLayer()];
    expect(errPaths(makeDoc({ layers: many }))).toContain("layers");
  });

  it("requires string meta fields", () => {
    const d = clone(makeDoc());
    (d.meta as { name: unknown }).name = 5;
    expect(errPaths(d)).toContain("meta.name");
  });
});

describe("validateSpark — texture rules", () => {
  it("accepts all built-in ids", () => {
    for (const ref of ["circle-soft", "circle-hard", "square", "spark", "smoke"]) {
      const d = makeDoc({ layers: [makeLayer({ texture: { ref, frames: null } })] });
      expect(validateSpark(d).ok).toBe(true);
    }
  });

  it("errors on an unknown non-user ref", () => {
    const d = makeDoc({ layers: [makeLayer({ texture: { ref: "bogus", frames: null } })] });
    expect(errPaths(d)).toContain("layers[0].texture.ref");
  });

  it("warns (not errors) on a user ref with no embedded entry (E10)", () => {
    const d = makeDoc({ layers: [makeLayer({ texture: { ref: "user:puff", frames: null } })] });
    const r = validateSpark(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.code === "missing-texture")).toBe(true);
  });

  it("accepts a user ref with a matching textures entry", () => {
    const d = makeDoc({
      textures: { puff: "data:image/png;base64,AAAA" },
      layers: [makeLayer({ texture: { ref: "user:puff", frames: null } })],
    });
    const r = validateSpark(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.length).toBe(0);
  });

  it("validates flipbook frames", () => {
    const bad = makeDoc({
      layers: [makeLayer({ texture: { ref: "circle-soft", frames: { cols: 0, rows: 2, fps: 12, mode: "loop" } } })],
    });
    expect(errPaths(bad)).toContain("layers[0].texture.frames.cols");
  });
});

describe("validateSpark — emission rules", () => {
  it("rejects maxParticles out of range", () => {
    expect(errPaths(makeDoc({ layers: [makeLayer({ emission: { ...makeLayer().emission, maxParticles: 0 } })] }))).toContain(
      "layers[0].emission.maxParticles",
    );
    expect(
      errPaths(makeDoc({ layers: [makeLayer({ emission: { ...makeLayer().emission, maxParticles: 20000 } })] })),
    ).toContain("layers[0].emission.maxParticles");
  });

  it("rejects negative burst time and non-integer count", () => {
    const l = makeLayer({ emission: { ...makeLayer().emission, bursts: [{ time: -1, count: 1.5, spread: 0 }] } });
    const paths = errPaths(makeDoc({ layers: [l] }));
    expect(paths).toContain("layers[0].emission.bursts[0].time");
    expect(paths).toContain("layers[0].emission.bursts[0].count");
  });
});

describe("validateSpark — shape rules", () => {
  it("accepts every shape kind with its fields", () => {
    const shapes = [
      { kind: "point", emitFrom: "volume" },
      { kind: "circle", radius: 10, emitFrom: "surface" },
      { kind: "cone", direction: 0, spread: 20, radius: 5, emitFrom: "volume" },
      { kind: "rect", width: 4, height: 2, emitFrom: "volume" },
      { kind: "edge", length: 8, emitFrom: "surface" },
    ] as const;
    for (const shape of shapes) {
      expect(validateSpark(makeDoc({ layers: [makeLayer({ shape })] })).ok).toBe(true);
    }
  });

  it("errors on an unknown shape kind and bad emitFrom", () => {
    expect(errPaths(makeDoc({ layers: [makeLayer({ shape: { kind: "blob" } as never })] }))).toContain(
      "layers[0].shape.kind",
    );
    expect(
      errPaths(makeDoc({ layers: [makeLayer({ shape: { kind: "point", emitFrom: "middle" } as never })] })),
    ).toContain("layers[0].shape.emitFrom");
  });

  it("errors when a required shape field is missing", () => {
    expect(errPaths(makeDoc({ layers: [makeLayer({ shape: { kind: "circle", emitFrom: "volume" } as never })] }))).toContain(
      "layers[0].shape.radius",
    );
  });
});

describe("validateSpark — track & gradient rules", () => {
  it("rejects an empty curve (E4)", () => {
    const l = makeLayer({ overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [] } } });
    const r = validateSpark(makeDoc({ layers: [l] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "empty-curve")).toBe(true);
  });

  it("accepts a single-key curve (E3)", () => {
    const l = makeLayer({ overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [{ t: 0, v: 1 }] } } });
    expect(validateSpark(makeDoc({ layers: [l] })).ok).toBe(true);
  });

  it("allows duplicate t in a curve (E12) but rejects descending t", () => {
    const dup = makeLayer({
      overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [{ t: 0.5, v: 1 }, { t: 0.5, v: 0 }] } },
    });
    expect(validateSpark(makeDoc({ layers: [dup] })).ok).toBe(true);

    const desc = makeLayer({
      overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [{ t: 1, v: 1 }, { t: 0, v: 0 }] } },
    });
    expect(validateSpark(makeDoc({ layers: [desc] })).ok).toBe(false);
  });

  it("rejects curve t outside [0,1]", () => {
    const l = makeLayer({ overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [{ t: 2, v: 1 }] } } });
    expect(errPaths(makeDoc({ layers: [l] }))).toContain("layers[0].overLifetime.size.keys[0].t");
  });

  it("rejects a range track with min > max", () => {
    const l = makeLayer({ initial: { ...makeLayer().initial, speed: { mode: "range", min: 10, max: 5 } } });
    expect(errPaths(makeDoc({ layers: [l] }))).toContain("layers[0].initial.speed");
  });

  it("requires a color gradient with >=1 key and channels in [0,1]", () => {
    const empty = makeLayer({ overLifetime: { ...makeLayer().overLifetime, color: { keys: [] } } });
    expect(validateSpark(makeDoc({ layers: [empty] })).ok).toBe(false);

    const bad = makeLayer({ overLifetime: { ...makeLayer().overLifetime, color: { keys: [{ t: 0, r: 2, g: 0, b: 0, a: 1 }] } } });
    expect(errPaths(makeDoc({ layers: [bad] }))).toContain("layers[0].overLifetime.color.keys[0].r");
  });
});

describe("validateSpark — reserved fields (L8)", () => {
  it("rejects non-null subEmitters and trail", () => {
    expect(errPaths(makeDoc({ layers: [makeLayer({ subEmitters: {} as null })] }))).toContain("layers[0].subEmitters");
    expect(errPaths(makeDoc({ layers: [makeLayer({ trail: {} as null })] }))).toContain("layers[0].trail");
  });
});

describe("validateSpark — emitter motion (schemaVersion 2)", () => {
  function warns(input: unknown) {
    const r = validateSpark(input);
    return r.warnings.map((w) => w.path);
  }

  it("accepts a valid world-space layer with inherited velocity", () => {
    const l = makeLayer({ space: "world", inheritVelocity: 1 });
    expect(validateSpark(makeDoc({ layers: [l] })).ok).toBe(true);
  });

  it("rejects an unknown simulation space", () => {
    const l = makeLayer({ space: "screen" as unknown as "local" });
    expect(errPaths(makeDoc({ layers: [l] }))).toContain("layers[0].space");
  });

  it("rejects inheritVelocity out of [-2, 2] or non-numeric", () => {
    expect(errPaths(makeDoc({ layers: [makeLayer({ inheritVelocity: 3 })] }))).toContain("layers[0].inheritVelocity");
    expect(errPaths(makeDoc({ layers: [makeLayer({ inheritVelocity: -2.5 })] }))).toContain("layers[0].inheritVelocity");
    expect(errPaths(makeDoc({ layers: [makeLayer({ inheritVelocity: "x" as unknown as number })] }))).toContain(
      "layers[0].inheritVelocity",
    );
  });

  it("accepts rateOverDistance as a track or null; enforces the rate ceiling", () => {
    const ok = makeLayer({
      space: "world",
      emission: { ...makeLayer().emission, rateOverDistance: { mode: "constant", value: 2 } },
    });
    expect(validateSpark(makeDoc({ layers: [ok] })).ok).toBe(true);

    const tooBig = makeLayer({
      space: "world",
      emission: { ...makeLayer().emission, rateOverDistance: { mode: "constant", value: 1e9 } },
    });
    expect(errPaths(makeDoc({ layers: [tooBig] }))).toContain("layers[0].emission.rateOverDistance.value");
  });

  it("warns when motion features are set on a local-space layer", () => {
    const l = makeLayer({
      space: "local",
      inheritVelocity: 1,
      emission: { ...makeLayer().emission, rateOverDistance: { mode: "constant", value: 2 } },
    });
    const w = warns(makeDoc({ layers: [l] }));
    expect(w).toContain("layers[0].inheritVelocity");
    expect(w).toContain("layers[0].emission.rateOverDistance");
  });

  it("warns when a world-space layer prewarms", () => {
    const l = makeLayer({ space: "world", emission: { ...makeLayer().emission, prewarm: true } });
    expect(warns(makeDoc({ layers: [l] }))).toContain("layers[0].emission.prewarm");
  });
});
