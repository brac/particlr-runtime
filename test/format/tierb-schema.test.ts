import { describe, it, expect } from "vitest";
import {
  parseParticle,
  serializeParticle,
  validateParticle,
  migrateToCurrent,
  Effect,
  POLYLINE_DIRECTIONS,
  SHAPE_KINDS,
  type ParticleDoc,
  type Layer,
  type Shape,
  type WindConfig,
  type ByEmitterSpeedConfig,
  type CollisionConfig,
  type Rect,
} from "../../src/index.js";
import { stateHash } from "../core/_statehash.js";
import { makeDoc, makeLayer, clone } from "./_helpers.js";

// TIERB_PLAN M0 (schemaVersion 10): the format surface for polyline spawn (B1),
// kill-on-collide / min-kill-speed / kill zones (B3), by-emitter-speed (B5), and
// wind (B6). ZERO runtime behavior this milestone — nothing reads the new fields,
// so a v9 doc migrates to v10 bit-inert (per layer: wind/byEmitterSpeed/killZones
// null; a non-null collision gains killOnCollide:false, minKillSpeed:0). Draw-free.

// --- shared builders -------------------------------------------------------
const polyline = (over: Partial<Extract<Shape, { kind: "polyline" }>> = {}): Shape => ({
  kind: "polyline",
  points: [{ x: -40, y: 0 }, { x: 0, y: -30 }, { x: 40, y: 0 }],
  closed: false,
  direction: "normal",
  emitFrom: "volume",
  ...over,
});
const wind = (over: Partial<WindConfig> = {}): WindConfig => ({
  direction: -90,
  strength: { mode: "constant", value: 120 },
  gustFrequency: 0.5,
  gustAmount: 0.4,
  windStrengthParam: null,
  windDirectionParam: null,
  ...over,
});
const byEmitterSpeed = (over: Partial<ByEmitterSpeedConfig> = {}): ByEmitterSpeedConfig => ({
  range: { min: 0, max: 400 },
  size: { mode: "constant", value: 1.5 },
  speed: null,
  life: { mode: "curve", keys: [{ t: 0, v: 1 }, { t: 1, v: 2 }] },
  ...over,
});
const collision = (over: Partial<CollisionConfig> = {}): CollisionConfig => ({
  shape: { kind: "floor", y: 80 },
  bounce: 0.3,
  dampen: 0.1,
  lifetimeLoss: 0,
  killOnCollide: false,
  minKillSpeed: 0,
  ...over,
});
const killZones = (): Rect[] => [{ x: -200, y: 120, width: 400, height: 80 }];

// A doc holding a single layer patched with `over`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docWith = (over: Record<string, any>) => makeDoc({ layers: [makeLayer(over as never)] });
const res = (over: Record<string, unknown>) => validateParticle(docWith(over));
const ok = (over: Record<string, unknown>) => res(over).ok;
const errPaths = (over: Record<string, unknown>): string[] => {
  const r = res(over);
  return r.ok ? [] : r.errors.map((e) => e.path);
};

// A v9-shaped doc reconstructed from a current v10 doc by stripping the v10
// additions (wind/byEmitterSpeed/killZones off every layer; the two kill fields off
// every non-null collision) — the pre-migration input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toV9(v10: ParticleDoc): any {
  const d = clone(v10) as any;
  d.schemaVersion = 9;
  for (const l of d.layers) {
    delete l.wind;
    delete l.byEmitterSpeed;
    delete l.killZones;
    if (l.collision && typeof l.collision === "object") {
      delete l.collision.killOnCollide;
      delete l.collision.minKillSpeed;
    }
  }
  return d;
}

function runHash(doc: ParticleDoc): string {
  const fx = new Effect(doc, { seed: 1337 });
  for (let i = 0; i < 60; i++) fx.step(1 / 60);
  return stateHash(fx);
}

// A doc whose single layer carries a non-null collision (so the migration
// collision-walk has something to inject into).
const collisionDoc = (): ParticleDoc => makeDoc({ layers: [makeLayer({ collision: collision() })] });

// ---------------------------------------------------------------------------
describe("v9 -> v10 migration (wind / byEmitterSpeed / kill zones / kill-on-collide)", () => {
  it("injects wind/byEmitterSpeed/killZones null per layer and bumps to 10", () => {
    const v9 = toV9(makeDoc());
    expect(v9.layers[0].wind).toBeUndefined();
    const m = migrateToCurrent(v9);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const doc = m.doc as ParticleDoc;
    expect(doc.schemaVersion).toBe(11); // migrateToCurrent chains to CURRENT (now 11)
    expect(doc.layers[0]!.wind).toBe(null);
    expect(doc.layers[0]!.byEmitterSpeed).toBe(null);
    expect(doc.layers[0]!.killZones).toBe(null);
  });

  it("injects killOnCollide:false, minKillSpeed:0 into a non-null collision only", () => {
    const v9 = toV9(collisionDoc());
    expect(v9.layers[0].collision.killOnCollide).toBeUndefined();
    const m = migrateToCurrent(v9);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const col = (m.doc as ParticleDoc).layers[0]!.collision!;
    expect(col.killOnCollide).toBe(false);
    expect(col.minKillSpeed).toBe(0);
    // Pre-existing collision floats survive verbatim.
    expect(col.bounce).toBe(0.3);
  });

  it("leaves a null collision untouched (no object materialized)", () => {
    const v9 = toV9(makeDoc()); // default makeLayer: collision null
    const m = migrateToCurrent(v9);
    expect(m.ok).toBe(true);
    if (m.ok) expect((m.doc as ParticleDoc).layers[0]!.collision).toBe(null);
  });

  it("spread-first never clobbers a present wind/killZones or kill flag", () => {
    // A v9-labelled doc that ALREADY carries the v10 fields (a hand-authored /
    // forward-written doc); migration must not overwrite them.
    const v9 = clone(makeDoc({ layers: [makeLayer({ wind: wind(), killZones: killZones(), collision: collision({ killOnCollide: true, minKillSpeed: 50 }) })] })) as ParticleDoc;
    v9.schemaVersion = 9 as 10;
    const m = migrateToCurrent(v9);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const l = (m.doc as ParticleDoc).layers[0]!;
    expect(l.wind).not.toBe(null);
    expect(l.killZones).not.toBe(null);
    expect(l.collision!.killOnCollide).toBe(true);
    expect(l.collision!.minKillSpeed).toBe(50);
  });

  it("migration is bit-inert: stateHash of a migrated v9 doc == the hand-built v10 doc", () => {
    // Includes a non-null collision so the collision-walk runs; nothing reads the
    // new fields in M0, so the migrated doc simulates identically.
    const v10 = collisionDoc();
    const migrated = migrateToCurrent(toV9(v10));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(runHash(migrated.doc as ParticleDoc)).toBe(runHash(v10));
  });
});

// ---------------------------------------------------------------------------
describe("validator — E37 polyline shape", () => {
  it("exposes exactly the three directions and adds polyline to SHAPE_KINDS", () => {
    expect([...POLYLINE_DIRECTIONS]).toEqual(["normal", "outward", "random"]);
    expect(SHAPE_KINDS).toContain("polyline");
  });

  it("accepts a valid polyline for each direction", () => {
    for (const direction of POLYLINE_DIRECTIONS) {
      expect(ok({ shape: polyline({ direction }) })).toBe(true);
    }
    expect(ok({ shape: polyline({ closed: true }) })).toBe(true);
  });

  it("rejects fewer than 2 or more than 64 points", () => {
    expect(errPaths({ shape: polyline({ points: [{ x: 0, y: 0 }] }) })).toContain("layers[0].shape.points");
    const many = Array.from({ length: 65 }, (_, i) => ({ x: i, y: 0 }));
    expect(errPaths({ shape: polyline({ points: many }) })).toContain("layers[0].shape.points");
  });

  it("rejects a non-finite point channel", () => {
    expect(errPaths({ shape: polyline({ points: [{ x: 0, y: 0 }, { x: Infinity, y: 1 }] }) })).toContain("layers[0].shape.points[1].x");
  });

  it("rejects a non-boolean closed and a bad direction enum", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(errPaths({ shape: polyline({ closed: "yes" as any }) })).toContain("layers[0].shape.closed");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(errPaths({ shape: polyline({ direction: "sideways" as any }) })).toContain("layers[0].shape.direction");
  });

  it("warns (non-blocking) on a degenerate zero-length polyline (bad-polyline)", () => {
    const r = res({ shape: polyline({ points: [{ x: 5, y: 5 }, { x: 5, y: 5 }] }) });
    expect(r.ok).toBe(true); // non-blocking
    expect(r.warnings.some((w) => w.code === "bad-polyline")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validator — E38 kill-on-collide / min-kill-speed / kill zones", () => {
  it("accepts a valid kill-on-collide collision and kill zones", () => {
    expect(ok({ collision: collision({ killOnCollide: true, minKillSpeed: 100 }) })).toBe(true);
    expect(ok({ killZones: killZones() })).toBe(true);
    expect(ok({ killZones: [] })).toBe(true);
  });

  it("rejects a non-boolean killOnCollide and a negative minKillSpeed", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(errPaths({ collision: collision({ killOnCollide: 1 as any }) })).toContain("layers[0].collision.killOnCollide");
    expect(errPaths({ collision: collision({ minKillSpeed: -5 }) })).toContain("layers[0].collision.minKillSpeed");
  });

  it("rejects > 8 kill zones and a non-positive width/height", () => {
    const nine = Array.from({ length: 9 }, () => ({ x: 0, y: 0, width: 10, height: 10 }));
    expect(errPaths({ killZones: nine })).toContain("layers[0].killZones");
    expect(errPaths({ killZones: [{ x: 0, y: 0, width: 0, height: 10 }] })).toContain("layers[0].killZones[0].width");
    expect(errPaths({ killZones: [{ x: 0, y: 0, width: 10, height: -1 }] })).toContain("layers[0].killZones[0].height");
    expect(errPaths({ killZones: [{ x: Infinity, y: 0, width: 10, height: 10 }] })).toContain("layers[0].killZones[0].x");
  });

  it("warns that local-space kill zones ride the emitter (E20 lineage)", () => {
    const r = res({ space: "local", killZones: killZones() });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.path === "layers[0].killZones")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validator — E39 byEmitterSpeed", () => {
  it("accepts a valid module (null tracks allowed)", () => {
    expect(ok({ byEmitterSpeed: byEmitterSpeed() })).toBe(true);
    expect(ok({ byEmitterSpeed: byEmitterSpeed({ size: null, speed: null, life: null }) })).toBe(true);
  });

  it("rejects range min > max", () => {
    expect(errPaths({ byEmitterSpeed: byEmitterSpeed({ range: { min: 400, max: 0 } }) })).toContain("layers[0].byEmitterSpeed.range");
  });

  it("rejects a per-particle range/randomBetweenCurves track (constant/curve only)", () => {
    expect(errPaths({ byEmitterSpeed: byEmitterSpeed({ size: { mode: "range", min: 1, max: 2 } }) })).toContain("layers[0].byEmitterSpeed.size.mode");
  });
});

// ---------------------------------------------------------------------------
describe("validator — E40 wind", () => {
  it("accepts a valid wind (constant or curve strength)", () => {
    expect(ok({ wind: wind() })).toBe(true);
    expect(ok({ wind: wind({ strength: { mode: "curve", keys: [{ t: 0, v: 0 }, { t: 1, v: 200 }] }, gustFrequency: 0 }) })).toBe(true);
  });

  it("rejects a non-finite direction", () => {
    expect(errPaths({ wind: wind({ direction: NaN }) })).toContain("layers[0].wind.direction");
  });

  it("rejects a range-mode strength (constant/curve only)", () => {
    expect(errPaths({ wind: wind({ strength: { mode: "range", min: 0, max: 100 } }) })).toContain("layers[0].wind.strength.mode");
  });

  it("rejects a negative gustFrequency and an out-of-range gustAmount", () => {
    expect(errPaths({ wind: wind({ gustFrequency: -1 }) })).toContain("layers[0].wind.gustFrequency");
    expect(errPaths({ wind: wind({ gustAmount: 1.5 }) })).toContain("layers[0].wind.gustAmount");
  });
});

// ---------------------------------------------------------------------------
describe("serializer — v10 round-trip + canonical order", () => {
  function fullDoc(): ParticleDoc {
    const l = makeLayer({
      shape: polyline({ closed: true, direction: "outward" }),
      wind: wind(),
      byEmitterSpeed: byEmitterSpeed(),
      collision: collision({ killOnCollide: true, minKillSpeed: 60 }),
      killZones: killZones(),
    });
    return makeDoc({ layers: [l] });
  }

  it("validates with no errors", () => {
    expect(validateParticle(fullDoc()).ok).toBe(true);
  });

  it("survives serialize -> parse deep-equal and byte-stable re-serialize", () => {
    const doc = fullDoc();
    const text = serializeParticle(doc);
    const back = parseParticle(text);
    expect(back.ok).toBe(true);
    expect(back.doc).toEqual(doc);
    expect(serializeParticle(back.doc!)).toBe(text);
  });

  it("emits the v10 fields in canonical order (wind after noise; byEmitterSpeed after bySpeed; killZones after collision; kill fields after lifetimeLoss)", () => {
    const text = serializeParticle(fullDoc());
    const idx = (s: string) => text.indexOf(s);
    // wind groups with noise (before bySpeed); byEmitterSpeed after bySpeed.
    expect(idx('"noise"')).toBeLessThan(idx('"wind"'));
    expect(idx('"wind"')).toBeLessThan(idx('"bySpeed"'));
    expect(idx('"bySpeed"')).toBeLessThan(idx('"byEmitterSpeed"'));
    // killZones directly after collision.
    expect(idx('"collision"')).toBeLessThan(idx('"killZones"'));
    expect(idx('"killZones"')).toBeLessThan(idx('"attractor"'));
    // kill fields append after lifetimeLoss inside collision.
    expect(idx('"lifetimeLoss"')).toBeLessThan(idx('"killOnCollide"'));
    expect(idx('"killOnCollide"')).toBeLessThan(idx('"minKillSpeed"'));
    // polyline point entries order kind, points, closed, direction, emitFrom.
    expect(idx('"points"')).toBeLessThan(idx('"closed"'));
    expect(idx('"closed"')).toBeLessThan(idx('"direction"'));
  });
});
