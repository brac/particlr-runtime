import { describe, it, expect } from "vitest";
import { validateParticle } from "../../src/index.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

function errPaths(input: unknown): string[] {
  const r = validateParticle(input);
  return r.ok ? [] : r.errors.map((e) => e.path);
}
function firstCode(input: unknown): string | undefined {
  const r = validateParticle(input);
  return r.ok ? undefined : r.errors[0]?.code;
}

describe("validateParticle — happy path", () => {
  it("accepts a complete valid document", () => {
    const r = validateParticle(makeDoc());
    expect(r.ok).toBe(true);
  });

  it("accepts a zero-layer document (E14)", () => {
    const r = validateParticle(makeDoc({ layers: [] }));
    expect(r.ok).toBe(true);
  });
});

describe("validateParticle — document rules", () => {
  it("rejects a non-object", () => {
    expect(validateParticle(42 as unknown).ok).toBe(false);
  });

  it("rejects schemaVersion < 1 or non-integer", () => {
    expect(firstCode(makeDoc({ schemaVersion: 0 as 10 }))).toBe("invalid-version");
    expect(firstCode(makeDoc({ schemaVersion: 1.5 as 10 }))).toBe("invalid-version");
  });

  it("refuses a newer schemaVersion (E11)", () => {
    expect(firstCode(makeDoc({ schemaVersion: 13 as 12 }))).toBe("newer-version");
  });

  it("rejects duration below the 0.05 floor (E13)", () => {
    const r = validateParticle(makeDoc({ duration: 0.01 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "duration-floor")).toBe(true);
  });

  it("accepts duration exactly at the floor", () => {
    expect(validateParticle(makeDoc({ duration: 0.05 })).ok).toBe(true);
  });

  it("rejects non-boolean looping and non-number seed", () => {
    expect(errPaths(makeDoc({ looping: "yes" as unknown as boolean }))).toContain("looping");
    expect(errPaths(makeDoc({ seed: "x" as unknown as number }))).toContain("seed");
  });

  it("accepts up to 8 layers and rejects more (schemaVersion 3 cap)", () => {
    const eight = Array.from({ length: 8 }, (_, i) => makeLayer({ id: `l${i}` }));
    expect(validateParticle(makeDoc({ layers: eight })).ok).toBe(true);
    const nine = Array.from({ length: 9 }, (_, i) => makeLayer({ id: `l${i}` }));
    expect(errPaths(makeDoc({ layers: nine }))).toContain("layers");
  });

  it("rejects duplicate layer ids (sub-emitter refs resolve by id)", () => {
    const dup = [makeLayer({ id: "same" }), makeLayer({ id: "same" })];
    expect(errPaths(makeDoc({ layers: dup }))).toContain("layers[1].id");
  });

  it("requires string meta fields", () => {
    const d = clone(makeDoc());
    (d.meta as { name: unknown }).name = 5;
    expect(errPaths(d)).toContain("meta.name");
  });
});

describe("validateParticle — texture rules", () => {
  it("accepts all built-in ids", () => {
    for (const ref of ["circle-soft", "circle-hard", "square", "spark", "smoke"]) {
      const d = makeDoc({ layers: [makeLayer({ texture: { ref, frames: null } })] });
      expect(validateParticle(d).ok).toBe(true);
    }
  });

  it("errors on an unknown non-user ref", () => {
    const d = makeDoc({ layers: [makeLayer({ texture: { ref: "bogus", frames: null } })] });
    expect(errPaths(d)).toContain("layers[0].texture.ref");
  });

  it("warns (not errors) on a user ref with no embedded entry (E10)", () => {
    const d = makeDoc({ layers: [makeLayer({ texture: { ref: "user:puff", frames: null } })] });
    const r = validateParticle(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.code === "missing-texture")).toBe(true);
  });

  it("accepts a user ref with a matching textures entry", () => {
    const d = makeDoc({
      textures: { puff: "data:image/png;base64,AAAA" },
      layers: [makeLayer({ texture: { ref: "user:puff", frames: null } })],
    });
    const r = validateParticle(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.length).toBe(0);
  });

  it("rejects a texture value that is not a base64 image data URL (E44)", () => {
    const bads = [
      "https://evil.example/x.png", // remote URL — must never be loadable
      "data:text/html;base64,AAAA", // non-image MIME
      "data:image/png,rawpayload", // data URL but not base64
      "x.png", // bare path
    ];
    for (const bad of bads) {
      const d = makeDoc({
        textures: { puff: bad },
        layers: [makeLayer({ texture: { ref: "user:puff", frames: null } })],
      });
      expect(errPaths(d), bad).toContain("textures.puff");
    }
  });

  it("accepts any image MIME subtype as a texture data URL (E44)", () => {
    for (const ok of ["data:image/jpeg;base64,AAAA", "data:image/webp;base64,AAAA", "data:image/svg+xml;base64,AAAA"]) {
      const d = makeDoc({
        textures: { puff: ok },
        layers: [makeLayer({ texture: { ref: "user:puff", frames: null } })],
      });
      expect(validateParticle(d).ok, ok).toBe(true);
    }
  });

  it("validates flipbook frames", () => {
    const bad = makeDoc({
      layers: [makeLayer({ texture: { ref: "circle-soft", frames: { cols: 0, rows: 2, fps: 12, mode: "loop" } } })],
    });
    expect(errPaths(bad)).toContain("layers[0].texture.frames.cols");
  });
});

describe("validateParticle — emission rules", () => {
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

  // F-2/S-6: burst.cycles and bursts.length must be bounded like every peer cap,
  // else the core's per-cycle-per-burst emit loop freezes the sim for seconds.
  const oneBurst = (over: Record<string, unknown>) =>
    makeDoc({
      layers: [
        makeLayer({
          emission: {
            ...makeLayer().emission,
            bursts: [{ time: 0, count: 1, spread: 0, cycles: 1, interval: 0.001, probability: 1, ...over }],
          },
        }),
      ],
    });

  it("accepts cycles at the ceiling (10000)", () => {
    expect(validateParticle(oneBurst({ cycles: 10000 })).ok).toBe(true);
  });

  it("rejects cycles above the ceiling (10001)", () => {
    expect(errPaths(oneBurst({ cycles: 10001 }))).toContain("layers[0].emission.bursts[0].cycles");
  });

  it("rejects the audit repro cycles: 9007199254740991", () => {
    const r = validateParticle(oneBurst({ cycles: 9007199254740991 }));
    expect(r.ok).toBe(false);
    expect(errPaths(oneBurst({ cycles: 9007199254740991 }))).toContain("layers[0].emission.bursts[0].cycles");
  });

  const nBursts = (n: number) =>
    makeDoc({
      layers: [
        makeLayer({
          emission: {
            ...makeLayer().emission,
            bursts: Array.from({ length: n }, () => ({ time: 0, count: 1, spread: 0, cycles: 1, interval: 0, probability: 1 })),
          },
        }),
      ],
    });

  it("accepts a burst list at the ceiling (32 entries)", () => {
    expect(validateParticle(nBursts(32)).ok).toBe(true);
  });

  it("rejects a burst list above the ceiling (33 entries)", () => {
    expect(errPaths(nBursts(33))).toContain("layers[0].emission.bursts");
  });
});

describe("validateParticle — shape rules", () => {
  it("accepts every shape kind with its fields", () => {
    const shapes = [
      { kind: "point", emitFrom: "volume" },
      { kind: "circle", radius: 10, innerRadius: 0, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "surface" },
      { kind: "cone", direction: 0, spread: 20, radius: 5, arcMode: "random", arcSpeed: 1, emitFrom: "volume" },
      { kind: "rect", width: 4, height: 2, emitFrom: "volume" },
      { kind: "edge", length: 8, emitFrom: "surface" },
    ] as const;
    for (const shape of shapes) {
      expect(validateParticle(makeDoc({ layers: [makeLayer({ shape })] })).ok).toBe(true);
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

  // F-1: the arc fields are in the circle's (and, for arcMode/arcSpeed, the cone's)
  // `required` list in types.ts + particle.schema.json, but nothing backfills them
  // for a doc already at schemaVersion >= 3 — an absent one used to validate clean
  // and then sample as NaN. Absence is an error, one per field.
  const shapeMissing = (full: Record<string, unknown>, field: string) => {
    const shape = { ...full };
    delete shape[field];
    return validateParticle(makeDoc({ layers: [makeLayer({ shape: shape as never })] }));
  };

  it("errors when a circle omits innerRadius/arc/arcMode/arcSpeed (F-1)", () => {
    const full = { kind: "circle", radius: 20, innerRadius: 0, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "volume" };
    expect(validateParticle(makeDoc({ layers: [makeLayer({ shape: full as never })] })).ok).toBe(true);
    for (const field of ["innerRadius", "arc", "arcMode", "arcSpeed"]) {
      const r = shapeMissing(full, field);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      const issue = r.errors.find((e) => e.path === `layers[0].shape.${field}`);
      expect(issue?.message).toContain(field);
      expect(issue?.code).toBe("missing-shape-field");
    }
  });

  it("errors when a cone omits arcMode/arcSpeed (F-1)", () => {
    const full = { kind: "cone", direction: 0, spread: 20, radius: 5, arcMode: "random", arcSpeed: 1, emitFrom: "volume" };
    expect(validateParticle(makeDoc({ layers: [makeLayer({ shape: full as never })] })).ok).toBe(true);
    for (const field of ["arcMode", "arcSpeed"]) {
      const r = shapeMissing(full, field);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      const issue = r.errors.find((e) => e.path === `layers[0].shape.${field}`);
      expect(issue?.message).toContain(field);
      expect(issue?.code).toBe("missing-shape-field");
    }
  });

  it("rejects the bare v2-style circle that used to spawn all-NaN particles (F-1)", () => {
    const shape = { kind: "circle", radius: 50, emitFrom: "volume" };
    const r = validateParticle(makeDoc({ layers: [makeLayer({ shape: shape as never })] }));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => e.path).sort()).toEqual([
        "layers[0].shape.arc",
        "layers[0].shape.arcMode",
        "layers[0].shape.arcSpeed",
        "layers[0].shape.innerRadius",
      ]);
  });
});

describe("validateParticle — track & gradient rules", () => {
  it("rejects an empty curve (E4)", () => {
    const l = makeLayer({ overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [] } } });
    const r = validateParticle(makeDoc({ layers: [l] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "empty-curve")).toBe(true);
  });

  it("accepts a single-key curve (E3)", () => {
    const l = makeLayer({ overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [{ t: 0, v: 1 }] } } });
    expect(validateParticle(makeDoc({ layers: [l] })).ok).toBe(true);
  });

  it("allows duplicate t in a curve (E12) but rejects descending t", () => {
    const dup = makeLayer({
      overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [{ t: 0.5, v: 1 }, { t: 0.5, v: 0 }] } },
    });
    expect(validateParticle(makeDoc({ layers: [dup] })).ok).toBe(true);

    const desc = makeLayer({
      overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: [{ t: 1, v: 1 }, { t: 0, v: 0 }] } },
    });
    expect(validateParticle(makeDoc({ layers: [desc] })).ok).toBe(false);
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
    expect(validateParticle(makeDoc({ layers: [empty] })).ok).toBe(false);

    const bad = makeLayer({ overLifetime: { ...makeLayer().overLifetime, color: { keys: [{ t: 0, r: 2, g: 0, b: 0, a: 1 }] } } });
    expect(errPaths(makeDoc({ layers: [bad] }))).toContain("layers[0].overLifetime.color.keys[0].r");
  });

  // F-5: evalCurve/evalGradient scan the key array linearly per particle per track
  // per frame, so an unbounded array is a per-frame cost multiplier (a 200k-key curve
  // measured 234 ms/frame on a 2,000-particle pool). MAX_TRACK_KEYS = 64.
  const curveKeys = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i / (n - 1), v: 1 }));
  const gradientKeys = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i / (n - 1), r: 1, g: 1, b: 1, a: 1 }));
  const sizeCurve = (n: number) =>
    makeLayer({ overLifetime: { ...makeLayer().overLifetime, size: { mode: "curve", keys: curveKeys(n) } } });

  it("accepts a 64-key curve and rejects 65 (F-5)", () => {
    expect(validateParticle(makeDoc({ layers: [sizeCurve(64)] })).ok).toBe(true);

    const r = validateParticle(makeDoc({ layers: [sizeCurve(65)] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.path === "layers[0].overLifetime.size.keys");
      expect(issue?.code).toBe("too-many-curve-keys");
      expect(issue?.message).toContain("64");
    }
  });

  it("caps both randomBetweenCurves arms (F-5)", () => {
    const rbc = (an: number, bn: number) =>
      makeLayer({
        overLifetime: {
          ...makeLayer().overLifetime,
          size: { mode: "randomBetweenCurves", a: curveKeys(an), b: curveKeys(bn) },
        },
      });
    expect(validateParticle(makeDoc({ layers: [rbc(64, 64)] })).ok).toBe(true);
    expect(errPaths(makeDoc({ layers: [rbc(65, 2)] }))).toContain("layers[0].overLifetime.size.a");
    expect(errPaths(makeDoc({ layers: [rbc(2, 65)] }))).toContain("layers[0].overLifetime.size.b");
  });

  it("accepts a 64-key gradient and rejects 65 (F-5)", () => {
    const grad = (n: number) =>
      makeLayer({ overLifetime: { ...makeLayer().overLifetime, color: { keys: gradientKeys(n) } } });
    expect(validateParticle(makeDoc({ layers: [grad(64)] })).ok).toBe(true);

    const r = validateParticle(makeDoc({ layers: [grad(65)] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.path === "layers[0].overLifetime.color.keys");
      expect(issue?.code).toBe("too-many-gradient-keys");
      expect(issue?.message).toContain("64");
    }
  });
});

// F-3: types.ts declares killOnCollide/minKillSpeed non-optional and neither is
// `| null`, so COLLISION_NULLABLE_KEYS is empty and nothing backfills them on a doc
// already at schemaVersion >= 10. An absent minKillSpeed made layerSim evaluate
// `preImpactSpeed >= undefined` — always false — so an explicitly enabled
// killOnCollide was a permanent silent no-op. Absent is now an error.
describe("validateParticle — collision required fields (E38, F-3)", () => {
  const withCollision = (col: Record<string, unknown>) =>
    makeDoc({ layers: [makeLayer({ collision: col as never })] });
  const full = (): Record<string, unknown> => ({
    shape: { kind: "floor", y: 0 },
    bounce: 0.5,
    dampen: 0.2,
    lifetimeLoss: 0,
    killOnCollide: true,
    minKillSpeed: 120,
  });

  it("accepts a collision carrying both fields", () => {
    expect(validateParticle(withCollision(full())).ok).toBe(true);
  });

  it("rejects killOnCollide:true with no minKillSpeed (the silent no-op repro)", () => {
    const col = full();
    delete col.minKillSpeed;
    const r = validateParticle(withCollision(col));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.path === "layers[0].collision.minKillSpeed");
      expect(issue?.code).toBe("missing-collision-field");
      expect(issue?.message).toContain("minKillSpeed");
    }
  });

  it("rejects an absent killOnCollide", () => {
    const col = full();
    delete col.killOnCollide;
    const r = validateParticle(withCollision(col));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.find((e) => e.path === "layers[0].collision.killOnCollide")?.code).toBe("missing-collision-field");
  });

  it("rejects the bare pre-v10 collision that omits both", () => {
    const col = full();
    delete col.killOnCollide;
    delete col.minKillSpeed;
    expect(errPaths(withCollision(col)).sort()).toEqual([
      "layers[0].collision.killOnCollide",
      "layers[0].collision.minKillSpeed",
    ]);
  });

  it("still type-checks the fields when present", () => {
    expect(errPaths(withCollision({ ...full(), killOnCollide: "yes" }))).toContain("layers[0].collision.killOnCollide");
    expect(errPaths(withCollision({ ...full(), minKillSpeed: -1 }))).toContain("layers[0].collision.minKillSpeed");
  });

  it("leaves collision:null unaffected", () => {
    expect(validateParticle(makeDoc({ layers: [makeLayer({ collision: null })] })).ok).toBe(true);
  });
});

describe("validateParticle — schemaVersion 3 feature modules", () => {
  const withLayer = (over: Record<string, unknown>) =>
    makeDoc({ layers: [makeLayer(over as never)] });
  const warns = (input: unknown) => {
    const r = validateParticle(input);
    return r.warnings;
  };

  it("accepts null for every module (the migration default)", () => {
    expect(validateParticle(makeDoc()).ok).toBe(true);
  });

  it("does NOT warn 'unimplemented' for any module (all landed as of M9)", () => {
    // M9 is the final Tier-1 milestone: every schemaVersion-3 module now behaves,
    // so the temporary "unimplemented" warning is gone. trail was the last holdout.
    const l = makeLayer({ trail: { maxPoints: 8, minVertexDistance: 2, width: { mode: "constant", value: 4 }, color: null } });
    const r = validateParticle(makeDoc({ layers: [l] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "unimplemented")).toBe(false);
  });

  it("does NOT warn 'unimplemented' for the collision module (implemented in M7)", () => {
    const l = makeLayer({
      collision: { shape: { kind: "floor", y: 100 }, bounce: 0.5, dampen: 0.1, lifetimeLoss: 0, killOnCollide: false, minKillSpeed: 0 },
    });
    const r = validateParticle(makeDoc({ layers: [l] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "unimplemented" && w.path === "layers[0].collision")).toBe(false);
  });

  it("does NOT warn 'unimplemented' for the noise module (implemented in M2)", () => {
    const l = makeLayer({ noise: { strength: { mode: "constant", value: 40 }, frequency: 0.01, scrollSpeed: 0.2, octaves: 2 } });
    const r = validateParticle(makeDoc({ layers: [l] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "unimplemented" && w.path === "layers[0].noise")).toBe(false);
  });

  it("does NOT warn 'unimplemented' for the bySpeed module (implemented in M6)", () => {
    const l = makeLayer({ bySpeed: { range: { min: 0, max: 100 }, size: { mode: "constant", value: 1 }, color: null, rotation: null } });
    const r = validateParticle(makeDoc({ layers: [l] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "unimplemented" && w.path === "layers[0].bySpeed")).toBe(false);
  });

  // noise
  it("validates noise ranges (frequency > 0, octaves 1..3, no range strength)", () => {
    const noise = (o: Record<string, unknown>) => withLayer({ noise: { strength: { mode: "constant", value: 1 }, frequency: 0.01, scrollSpeed: 0, octaves: 1, ...o } });
    expect(errPaths(noise({ frequency: 0 }))).toContain("layers[0].noise.frequency");
    expect(errPaths(noise({ octaves: 4 }))).toContain("layers[0].noise.octaves");
    expect(errPaths(noise({ strength: { mode: "range", min: 1, max: 2 } }))).toContain("layers[0].noise.strength.mode");
  });

  // render
  it("validates render (align enum, minStretch <= maxStretch)", () => {
    const render = (o: Record<string, unknown>) => withLayer({ render: { align: "velocity", speedScale: 0.01, minStretch: 1, maxStretch: 3, ...o } });
    expect(validateParticle(render({})).ok).toBe(true);
    expect(errPaths(render({ align: "sideways" }))).toContain("layers[0].render.align");
    expect(errPaths(render({ minStretch: 5, maxStretch: 2 }))).toContain("layers[0].render");
  });

  it("warns when align:velocity is combined with a rotation module", () => {
    const l = makeLayer({
      render: { align: "velocity", speedScale: 0.01, minStretch: 1, maxStretch: 2 },
      overLifetime: { ...makeLayer().overLifetime, rotation: { mode: "constant", value: 90 } },
    });
    expect(warns(makeDoc({ layers: [l] })).some((w) => w.path === "layers[0].render.align")).toBe(true);
  });

  // bySpeed
  it("validates bySpeed (range min<=max, no range-mode tracks)", () => {
    const bs = (o: Record<string, unknown>) => withLayer({ bySpeed: { range: { min: 0, max: 100 }, size: null, color: null, rotation: null, ...o } });
    expect(validateParticle(bs({})).ok).toBe(true);
    expect(errPaths(bs({ range: { min: 100, max: 0 } }))).toContain("layers[0].bySpeed.range");
    expect(errPaths(bs({ size: { mode: "range", min: 1, max: 2 } }))).toContain("layers[0].bySpeed.size.mode");
  });

  // startColor
  it("validates startColor palette (1..16 colors) and gradients mode", () => {
    const grad = { keys: [{ t: 0, r: 1, g: 1, b: 1, a: 1 }] };
    expect(validateParticle(withLayer({ startColor: { mode: "gradients", a: grad, b: grad } })).ok).toBe(true);
    expect(validateParticle(withLayer({ startColor: { mode: "palette", colors: [{ r: 1, g: 0, b: 0, a: 1 }] } })).ok).toBe(true);
    expect(errPaths(withLayer({ startColor: { mode: "palette", colors: [] } }))).toContain("layers[0].startColor.colors");
    const many = Array.from({ length: 17 }, () => ({ r: 0, g: 0, b: 0, a: 1 }));
    expect(errPaths(withLayer({ startColor: { mode: "palette", colors: many } }))).toContain("layers[0].startColor.colors");
  });

  // randomFlip
  it("validates randomFlip probabilities in [0,1]", () => {
    expect(validateParticle(withLayer({ randomFlip: { x: 0.5, y: 0 } })).ok).toBe(true);
    expect(errPaths(withLayer({ randomFlip: { x: 1.5, y: 0 } }))).toContain("layers[0].randomFlip.x");
  });

  // collision
  it("validates collision shapes and unit params, hints on local space", () => {
    const floor = { shape: { kind: "floor", y: 100 }, bounce: 0.5, dampen: 0.1, lifetimeLoss: 0, killOnCollide: false, minKillSpeed: 0 };
    expect(validateParticle(withLayer({ collision: floor })).ok).toBe(true);
    expect(errPaths(withLayer({ collision: { ...floor, bounce: 2 } }))).toContain("layers[0].collision.bounce");
    expect(warns(withLayer({ collision: floor })).some((w) => w.path === "layers[0].collision")).toBe(true); // E20 local hint
  });

  // trail
  it("validates trail (maxPoints 2..32, minVertexDistance > 0, no range width)", () => {
    const trail = (o: Record<string, unknown>) => withLayer({ trail: { maxPoints: 16, minVertexDistance: 4, width: { mode: "constant", value: 3 }, color: null, ...o } });
    expect(validateParticle(trail({})).ok).toBe(true);
    expect(errPaths(trail({ maxPoints: 64 }))).toContain("layers[0].trail.maxPoints");
    expect(errPaths(trail({ minVertexDistance: 0 }))).toContain("layers[0].trail.minVertexDistance");
    expect(errPaths(trail({ width: { mode: "range", min: 1, max: 2 } }))).toContain("layers[0].trail.width.mode");
  });

  // shape arc / donut
  it("validates circle donut + arc (0<=innerRadius<=radius, arc in (0,360])", () => {
    const circle = (o: Record<string, unknown>) => withLayer({ shape: { kind: "circle", radius: 20, innerRadius: 0, arc: 360, arcMode: "random", arcSpeed: 1, emitFrom: "volume", ...o } });
    expect(validateParticle(circle({})).ok).toBe(true);
    expect(errPaths(circle({ innerRadius: 30 }))).toContain("layers[0].shape.innerRadius");
    expect(errPaths(circle({ arc: 0 }))).toContain("layers[0].shape.arc");
    expect(errPaths(circle({ arc: 400 }))).toContain("layers[0].shape.arc");
    expect(errPaths(circle({ arcMode: "spin" }))).toContain("layers[0].shape.arcMode");
  });

  // burst cycles
  it("validates burst cycles/interval/probability", () => {
    const burst = (o: Record<string, unknown>) => {
      const l = makeLayer();
      l.emission.bursts = [{ time: 0, count: 5, spread: 0, cycles: 1, interval: 0, probability: 1, ...o } as never];
      return makeDoc({ layers: [l] });
    };
    expect(validateParticle(burst({})).ok).toBe(true);
    expect(errPaths(burst({ cycles: 0 }))).toContain("layers[0].emission.bursts[0].cycles");
    expect(errPaths(burst({ cycles: 3, interval: 0 }))).toContain("layers[0].emission.bursts[0].interval");
    expect(errPaths(burst({ probability: 2 }))).toContain("layers[0].emission.bursts[0].probability");
  });
});

describe("validateParticle — sub-emitter references (schemaVersion 3)", () => {
  const parent = (refOver: Record<string, unknown> = {}) =>
    makeLayer({
      id: "parent",
      subEmitters: [{ trigger: "death", layerId: "child", count: 5, probability: 1, inheritVelocity: 0, ...refOver }] as never,
    });
  const child = (over: Record<string, unknown> = {}) => {
    const l = makeLayer({ id: "child", ...over });
    l.emission.rateOverTime = { mode: "constant", value: 0 }; // children emit only on trigger
    return l;
  };

  it("accepts a valid depth-1 reference to a sibling layer", () => {
    const r = validateParticle(makeDoc({ layers: [parent(), child()] }));
    expect(r.ok).toBe(true);
  });

  it("rejects a self reference, a missing target, and a depth-2 chain", () => {
    expect(errPaths(makeDoc({ layers: [parent({ layerId: "parent" }), child()] }))).toContain("layers[0].subEmitters[0].layerId");
    expect(errPaths(makeDoc({ layers: [parent({ layerId: "ghost" }), child()] }))).toContain("layers[0].subEmitters[0].layerId");
    // child itself has sub-emitters -> depth 2, illegal
    const deepChild = makeLayer({ id: "child", subEmitters: [{ trigger: "birth", layerId: "parent", count: 1, probability: 1, inheritVelocity: 0 }] as never });
    expect(errPaths(makeDoc({ layers: [parent(), deepChild] }))).toContain("layers[0].subEmitters[0].layerId");
  });

  it("rejects count out of [1,100] and probability out of [0,1]", () => {
    expect(errPaths(makeDoc({ layers: [parent({ count: 0 }), child()] }))).toContain("layers[0].subEmitters[0].count");
    expect(errPaths(makeDoc({ layers: [parent({ count: 101 }), child()] }))).toContain("layers[0].subEmitters[0].count");
    expect(errPaths(makeDoc({ layers: [parent({ probability: 1.5 }), child()] }))).toContain("layers[0].subEmitters[0].probability");
  });

  it("warns when a sub-emitter target still emits continuously", () => {
    const busyChild = makeLayer({ id: "child" }); // makeLayer default rate is constant 20
    const r = validateParticle(makeDoc({ layers: [parent(), busyChild] }));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.path === "layers[0].subEmitters[0].layerId")).toBe(true);
  });
});

describe("validateParticle — emitter motion (schemaVersion 2)", () => {
  function warns(input: unknown) {
    const r = validateParticle(input);
    return r.warnings.map((w) => w.path);
  }

  it("accepts a valid world-space layer with inherited velocity", () => {
    const l = makeLayer({ space: "world", inheritVelocity: 1 });
    expect(validateParticle(makeDoc({ layers: [l] })).ok).toBe(true);
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
    expect(validateParticle(makeDoc({ layers: [ok] })).ok).toBe(true);

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
