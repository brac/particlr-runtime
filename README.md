# @particlr/runtime

The MIT-licensed particle runtime behind [particlr](../../README.md) — a
framework-agnostic simulation core plus a PixiJS v8 adapter. It plays back
`.prt` effect documents **deterministically**: the same document, seed, and
sequence of `dt` values always produce the same frames. The particlr editor
previews through this exact package, so what you tune is what you ship.

- **Zero runtime dependencies** in the core (`pixi.js` is an optional peer, used
  only by the `/pixi` adapter).
- **Node-safe core** — no DOM, no `Math.random`, no wall-clock reads.
- Ships the JSON Schema for `.prt` (`@particlr/runtime/particle.schema.json`).

## Install

```sh
npm install @particlr/runtime pixi.js
```

`pixi.js@^8` is a peer dependency (only needed if you use the `/pixi` adapter).

## Quick start (Pixi v8)

This is the whole integration — load a `.prt`, step it each frame, render it:

```ts
import { Application } from "pixi.js";
import { parseParticle, Effect } from "@particlr/runtime";
import { PixiParticleRenderer } from "@particlr/runtime/pixi";

const app = new Application();
await app.init({ background: "#000", width: 800, height: 600 });
document.body.appendChild(app.canvas);

const doc = parseParticle(await (await fetch("boom.prt")).text()).doc!;
const fx = new Effect(doc, { seed: 1337 });
const view = new PixiParticleRenderer(fx);
view.container.position.set(400, 300); // where the effect plays
app.stage.addChild(view.container);

app.ticker.add((ticker) => {
  fx.step(ticker.deltaMS / 1000); // advance the simulation
  view.sync();                    // copy state onto the Pixi particles
});
```

A complete runnable version lives in [`samples/pixi-game`](../../samples/pixi-game).

## Core API (`@particlr/runtime`)

### Reading & writing documents

```ts
parseParticle(input: string | object): ParseResult
```
Parses (JSON string or object), migrates to the current schema version, and
validates. Unknown fields are preserved for byte-stable round-tripping. Throws
only if a string isn't valid JSON.

```ts
interface ParseResult {
  ok: boolean;
  doc: ParticleDoc | null;      // null when !ok
  errors: ValidationIssue[]; // { path, message, code? }
  warnings: ValidationIssue[];
}
```

```ts
serializeParticle(doc: ParticleDoc): string
```
Emits canonical JSON (declared key order, unknown keys preserved, 2-space
indent, `\n` endings, trailing newline). `serializeParticle(parseParticle(text).doc)`
equals `text` byte-for-byte for canonical input.

```ts
validateParticle(input: object): ValidationResult   // { ok, doc, warnings } | { ok:false, errors, warnings }
```

`BUILTIN_TEXTURE_IDS` — the built-in texture ids: `circle-soft`, `circle-hard`,
`square`, `spark`, `smoke`.

### Effect

```ts
class Effect {
  constructor(doc: ParticleDoc, opts?: { seed?: number; x?: number; y?: number }); // seed overrides doc.seed; x/y = initial emitter position
  step(dt: number): void;      // advance by dt seconds
  reset(seed?: number): void;  // rewind to t=0 (re-prewarms if configured); keeps the emitter position
  setEmitterPosition(x: number, y: number): void; // emitter position at the END of the next step (drives world-space trails)
  teleportEmitter(x: number, y: number): void;    // jump with no velocity/interpolation (respawns, screen wraps)
  setAttractor(x: number, y: number, strength: number, radius: number): void; // host-driven attractor (schemaVersion 4); radius <= 0 clears
  clearAttractor(): void;                          // remove the host attractor
  readonly emitterX: number;
  readonly emitterY: number;
  readonly time: number;       // effect-local seconds
  readonly seed: number;
  readonly isDone: boolean;    // non-looping effect finished and no particles remain
  readonly particleCount: number;
  readonly layers: readonly LayerSim[]; // per-layer: count, capped, typed-array state
}
```

#### Simulation space & moving emitters (schemaVersion 2)

Each layer has a `space`: **`local`** particles ride the emitter (weld to the
source — muzzle flash, aura); **`world`** particles spawn at the emitter's
current position and then simulate independently, so a moving emitter leaves
them behind — a **trail** (flamethrower, rocket smoke, comet, a flaming
projectile).

**Host contract:** place `view.container` at the effect's world origin **once**,
then drive motion through the emitter — never by moving the container (that drags
world-space particles too). A projectile with a trail:

```ts
const fx = new Effect(fireballDoc, { seed });
const view = new PixiParticleRenderer(fx);
view.container.position.set(0, 0);      // fixed; the emitter moves, not this
fx.teleportEmitter(startX, startY);     // launch point, no start smear
app.stage.addChild(view.container);

app.ticker.add((t) => {
  x += speed * (t.deltaMS / 1000);
  fx.setEmitterPosition(x, y);          // advance the head; world layers shed a trail
  fx.step(t.deltaMS / 1000);
  view.sync();
});
```

`inheritVelocity` (per layer, `[-2,2]`) adds a fraction of the emitter's velocity
to each spawned particle; `emission.rateOverDistance` spawns particles per pixel
traveled (uniform trail density at any speed). Both are world-space only.
Determinism extends to identical `(document, seed, sequence of (dt, emitter
position))`.

Each `LayerSim` exposes read-only per-particle typed arrays (`x`, `y`, `velX`,
`velY`, `age`, `lifetime`, `rotation`, …) plus `count` and `capped`. Use
`computeRenderState(layerSim, buffers)` to evaluate size / color / flipbook-frame
into your own buffers if you're writing a custom renderer — keeping all renderers
identical to the preview.

#### Schema v3 (Tier-1 feature surface)

schemaVersion 3 adds per-layer feature modules, each `null` = off: `noise`
(curl turbulence), `bySpeed` (speed-driven size/color/rotation remaps),
`startColor` (per-particle spawn tint — two-gradient lerp or a ≤16-color
palette), `randomFlip`, `render` (velocity alignment + speed stretch),
`collision` (floor/rect planes), `subEmitters` (depth-1 refs to sibling
layers), and `trail` (per-particle ribbons). `overLifetime.velocity` gains
additive `x`/`y`/`orbital`/`radial` tracks; circles gain `innerRadius`/`arc`/
`arcMode`/`arcSpeed` (donut + arc sweeps; cones get the arc modes too); bursts
gain `cycles`/`interval`/`probability`. The layer cap is 8 (was 4). Exported
types: `NoiseConfig`, `BySpeedConfig`, `StartColor`, `RandomFlip`,
`RenderConfig`, `CollisionConfig`, `SubEmitterRef`, `TrailConfig`, `ArcMode`,
`SubTrigger`, `RGBAColor`. v1/v2 documents migrate forward losslessly and
behave bit-identically. Feature behaviors land milestone-by-milestone
(TIER1_PLAN); a document using a not-yet-implemented module validates with an
`"unimplemented"` warning and the field stays inert. Full semantics:
`docs/FORMAT_SPEC.md`.

#### Schema v4 — point attractor / vortex + host hook

schemaVersion 4 adds a per-layer `attractor` (point attractor / vortex; `null` =
off) and a per-layer `attractorInfluence` (`[-2, 2]`, `0` = off). The document
`attractor: { x, y, strength, tangential, radius, falloff, killRadius }` applies
a radial (`strength`) and tangential (`tangential`, orbiting) acceleration in
px/s² over particle ageNorm to particles within `radius`, in the layer's **sim
frame** (local ⇒ the point rides the emitter). Positive `tangential` orbits
clockwise on screen. `killRadius` (`0` = off) consumes particles that reach it —
firing death-trigger sub-emitters. The force is applied to **stored velocity**
(like gravity, so it composes with drag/collision/bySpeed), after the gravity
add and before drag. `strength`/`tangential` are constant/curve only (zero PRNG
draws). Exported types: `AttractorConfig`, `AttractorFalloff`,
`ATTRACTOR_FALLOFFS`, `DissolveConfig`.

**Host attractor hook.** `effect.setAttractor(x, y, strength, radius)` drives a
transient attractor from game code; `effect.clearAttractor()` removes it (a
non-positive `radius` clears too). Coordinates are **parent-frame** — the same
frame as `setEmitterPosition` — and are converted per layer (world layers use
them as-is; local layers subtract the step-end emitter position). The host force
uses a fixed `smooth` falloff, is **radial only** (no tangential, no kill), and
is scaled per layer by `attractorInfluence` — so it is inert on any layer with
influence `0` (the migration default, hence a no-op on every v1–v3 document). The
last call before a `step()` wins, and the value **persists across `step()` and
`reset()` until cleared**.

```ts
const fx = new Effect(doc, { seed });
fx.setAttractor(pointerX, pointerY, 800, 240); // suck particles toward the cursor
// …later…
fx.clearAttractor();                            // release them
```

### Behavioral guarantees (edge cases)

| # | Case | Behavior |
|---|---|---|
| E1 | `dt` larger than 1/20 s (tab unhide) | clamped to 1/20 s; never sub-steps |
| E2 | `dt <= 0` | no-op |
| E5 | prewarm | simulates one full duration of *continuous* emission (bursts suppressed) before the first visible frame |
| E6 | `looping: false` ends | emitters stop; live particles finish; `isDone` becomes true at 0 particles |
| E7 | pool full (`maxParticles`) | new spawns dropped silently; `layer.capped` flags it |
| E8 | seeking a time | `reset(seed)` then `step(1/60)` to the target — exact, thanks to determinism |
| E9 | serializing while playing | `serializeParticle` uses the authored document; playback state never serializes |
| E15 | `teleportEmitter` (respawn/wrap) | jump with no velocity and no spawn interpolation across the gap; resets the distance accumulator |
| E16 | prewarm on a world-space layer | prewarm runs at the initial emitter position with zero velocity; particles pile there |

## Pixi adapter (`@particlr/runtime/pixi`)

```ts
class PixiParticleRenderer {
  constructor(effect: Effect, opts?: { renderer?: unknown });
  readonly container: Container; // one ParticleContainer per layer
  readonly warnings: string[];   // e.g. a missing user texture fell back to a built-in
  sync(): void;                  // call after effect.step(dt)
  destroy(): void;
}
```

Built-in textures are generated procedurally (pure math, no asset files, no
canvas) so output is identical across browsers and GPUs. Blend modes map
directly to Pixi's (`normal`/`add`/`multiply`/`screen`).

Embedded **user textures** (`"user:<name>"` refs backed by a data URL in
`doc.textures`) decode asynchronously: the layer renders the soft-circle
built-in until the image is ready, then swaps in. Decoded user textures are
cached by data URL and shared across renderer instances for the lifetime of the
page — the runtime does not evict them (per-texture refcounting is a v1.5
concern; a document embedding many large textures is out of scope for v1).

## Determinism contract

Given identical `(document, seed, sequence of (dt, emitter-position,
host-attractor state) tuples)`, output is bit-identical — the emitter position
(`setEmitterPosition`) and the host attractor (`setAttractor` parameters) are
per-step host inputs exactly like `dt` (schemaVersion 4 amendment). The runtime
never reads wall-clock time, `Math.random`, or any global — the only randomness
is a seeded mulberry32 PRNG, one stream per layer. This is what makes seek/scrub
exact and enables golden-frame testing.

## The `.prt` format

`.prt` is a small, versioned, declarative JSON document — see
[`FORMAT_SPEC.md`](../../docs/FORMAT_SPEC.md) and the machine-readable
[`particle.schema.json`](./src/format/particle.schema.json) shipped with this package
(`import schema from "@particlr/runtime/particle.schema.json"`).

Because the format is small, documented, and agent-readable, a coding agent can
author or tweak effects directly — "make the explosion 20% punchier and shift it
orange" is a JSON edit against a published schema, no editor required.

## License

MIT. See [LICENSE](./LICENSE).
