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
  setParam(name: string, value: number): void; // drive an exposed parameter (schemaVersion 6); clamps to [min,max]; unknown name / non-finite value = no-op
  getParam(name: string): number;              // current param value (authored default until first set); unknown name ⇒ NaN
  timeScale: number;           // host playback rate; 1 = real time, 0 = frozen (hit-stop), <1 slow-mo; non-finite/≤0 ⇒ 0
  onDone: (() => void) | null; // fired once when a non-looping effect finishes (isDone); re-armed by reset()
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

#### Playback control & completion (host API)

Two host-only handles on `Effect` — no document surface, no schema change.

**`effect.timeScale`** multiplies the `dt` you pass to `step()`. It is applied as
the very first thing `step()` does, so it composes with the existing guards:

```ts
fx.timeScale = 0.25;  // slow-motion
fx.timeScale = 3;     // fast-forward (each step still clamps to MAX_DT, so a
                      // fast-forward can never explode emitters)
fx.timeScale = 0;     // hit-stop: freeze the effect in place. `timeScale = 0` is
                      // exactly `step(0)` every frame — the clock and every
                      // particle hold, and a pending setEmitterPosition target
                      // stays queued for the next un-paused step.
```

The setter normalizes: any non-finite, negative, or zero value stores `0`
(paused) — it never throws. `timeScale` is sugar over the `dt` you already
control: `timeScale = s; step(dt)` is bitwise-identical to
`timeScale = 1; step(dt·s)`. One consequence worth knowing: under slow-motion the
emitter still traverses its full pending segment within the (smaller) scaled step,
so its implied velocity `(target − start) / scaledDt` **rises** — a host that
moves the emitter in real time correctly reads as fast in particle-time
(`inheritVelocity`, world trails). That is authentic game slow-mo, not a bug.
`timeScale` persists across `step()` and `reset()` until reassigned.

**`effect.onDone`** is a single completion callback (assign a function or `null`;
a host wanting fan-out wraps it). It fires **synchronously at the end of the
`step()`** on which the effect first reads `isDone` (a non-looping effect past its
duration with zero live particles) — after all state is committed, so inside the
callback `isDone === true` and `particleCount === 0`. It fires **at most once**
until `reset()`, which re-arms it (the `onDone` property itself survives `reset()`,
like `timeScale`). Attaching a callback *after* the effect has already finished
still fires it on the next `step()` (latch-on-fire, not on transition — friendlier
to hosts that attach late). A paused step (`dt ≤ 0`, including `timeScale = 0`)
runs no completion check. **Looping effects never fire** (`isDone` is always
false), and prewarm never fires. Calling ordinary API from inside the callback —
including `reset()` — is legal and safe; the callback runs after the step body, so
it can never affect the state that step produced.

```ts
fx.onDone = () => {
  view.destroy();          // tear down the renderer
  removeFromActiveList(fx);
};
app.ticker.add((t) => { fx.step(t.deltaMS / 1000); fx.view.sync(); });
```

#### Exposed parameters (schemaVersion 6, A9)

**One `boom.prt`, N weapons.** A document may declare named scalar parameters,
and any of seven well-known knobs may **bind** to one. The host drives them per
instance with `setParam` / `getParam` — no document mutation — so a pistol muzzle
flash and a rocket blast are the **same** `.prt` at `intensity = 0.3` and
`intensity = 1.0`.

```ts
// pistol / rifle / rocket from one document
const fx = new Effect(boomDoc, { seed });
fx.setParam("intensity", tier);   // 0.3 … 1.0
fx.getParam("intensity");         // read back the current (clamped) value
```

- **Author surface.** `doc.params: { name, default, min, max }[]`. Each bindable
  knob carries an optional sibling reference field (`…Param: string | null`);
  `null`/absent = unbound. The multiply is **multiply-only** and applies to the
  knob's *evaluated* value — never its stored track keys — so a bound knob at
  param value `1` is an IEEE-exact no-op (a `params`-carrying document renders
  byte-identically to one with `params: []`). The **authoring identity is the
  value `1`** ("default 1 = as authored"); the editor seeds a new param as
  `{ default: 1, min: 0, max: 2 }`.
- **Setter behavior.** `setParam` clamps `value` into the param's authored
  `[min, max]`; a non-finite `value` is ignored (no-op) and an unknown `name` is a
  silent no-op — house tolerance, no throws (cf. `timeScale` normalizes,
  `setAttractor` clears). `getParam` returns the authored `default` until the first
  `setParam`, and `NaN` for an unknown name. For sim-consumed knobs
  (rate/speed/life/gravity) the **last call before a `step()` wins**; the
  render-path knobs (`size`/`opacity`) are **frame-live** — a `setParam` shows in
  the very next render even while paused (`timeScale = 0` hit-stop, a paused
  preview), no step needed. Param values **persist across `reset()`** (like
  `timeScale`) — so "scrub with `intensity = 0.7`" replays exactly.

The seven bindable knobs, and whether a mid-flight change is **live** (already-alive
particles respond next step/render) or **future-spawn** (baked at spawn):

| Binding field | Knob | Mid-flight |
|---|---|---|
| `emission.rateOverTimeParam` | continuous emission rate | emission timing (future) |
| `emission.rateOverDistanceParam` | rate-over-distance (world trails) | emission timing (future) |
| `initial.speedParam` | launch speed | **future spawns only** |
| `initial.lifeParam` | particle lifetime | **future spawns only** |
| `initial.sizeParam` | particle size (render multiply) | **live** |
| `overLifetime.velocity.gravityParam` | gravity vector | **live** |
| `opacityParam` (layer-level) | particle alpha | **live** |

`speed`/`life` are baked into pool state at spawn, so changing them never rescales
particles already on screen; `size`/`gravity`/`opacity` are re-evaluated every
step/frame, so they retune the whole live population for free. Params **join the
determinism tuple** (below): the vector of current `setParam` values in force at
each `step()` is a per-step host input, exactly like `dt` and `timeScale`.

#### Schema v4 — dissolve / alpha erosion

schemaVersion 4 adds a per-layer `dissolve` (`null` = off):
`{ frequency, scroll, edgeWidth, edgeColor }`. It is a **renderer-only** effect —
the sim is untouched, no PRNG draws, no pool columns. The particle's final render
alpha **is** the erosion progress: whatever modules drive per-particle alpha (the
color gradient, `bySpeed`, `startColor`) drive the dissolve, so a fading puff
erodes through an internal procedural noise tile instead of fading uniformly.
`frequency ∈ (0, 64]` is the noise repeat across the sprite; `scroll` is UV/s over
the effect clock (`uTime = effect.time`, so the burn is exact under scrub and
golden replay); `edgeWidth ∈ [0, 1]` is the soft erosion band; `edgeColor`
(`null` = off) is a hot-rim RGBA tint that glows at the erosion edge. It keeps
**one draw call per layer** (no render targets, no extra passes) via a forked
`ParticleContainer` shader. Exported type: `DissolveConfig`.

**Renderer parity — WebGL only.** The dissolve fork ships both a GLSL and a WGSL
source, but only the **WebGL (GLSL)** path is verified: the golden-frame suite
runs SwiftShader WebGL and there is no WebGPU golden lane yet, so L4
preview/runtime parity is **attested on WebGL only**; the WGSL path ships
unverified. Pin `preference: "webgl"` in your host `app.init` if you rely on
byte-exact parity (the editor preview, the golden harness, and the
`samples/pixi-game` host all do). Dissolve does **not** erode a trail ribbon
(E25) — a trail on the same layer renders un-eroded through its separate mesh
shader.

#### Schema v5 — cheap wins (limit-velocity · random-between-curves · hue jitter · flipbook upgrades)

schemaVersion 5 adds four companion features. Every one **reuses an
already-drawn per-particle uniform**, so the batch adds **zero new PRNG draws and
zero pool columns** — a v4 document migrates forward bit-identically
(`limitVelocity` defaults `null`; a flipbook gains `randomStartFrame: false`,
`frameOverLife: null`; the new track/startColor modes are opt-in enum values).

- **`limitVelocity: ScalarTrack | null`** (per layer; constant/curve only — no
  range/`randomBetweenCurves`, zero draws). A speed cap over particle ageNorm,
  applied to **stored velocity** right after drag and before the position write,
  so it persists and composes like drag: `speed = √(velX²+velY²)`; when
  `speed > cap` the velocity is scaled down to `cap`. `cap = 0` freezes particles
  in place (E27).
- **`randomBetweenCurves` `ScalarTrack` mode** — `{ mode, a: CurveKey[], b:
  CurveKey[] }`. Each particle draws a stable blend factor `r` for life and
  evaluates `lerp(evalCurve(a, t), evalCurve(b, t), r)`, so the population reads as
  a mix of two shapes. Valid **only** on the eight per-particle over-lifetime
  tracks that own a reserved spawn uniform — `overLifetime.size`,
  `overLifetime.rotation`, and `overLifetime.velocity.{drag, speedMultiplier, x, y,
  orbital, radial}` — consuming the SAME uniform `range` does (hence no new draw).
  The validator rejects it on `emission.rateOverTime` and every constant/curve-only
  track.
- **`hueJitter` `startColor` mode** — `{ mode, degrees }` (`degrees ∈ [0, 180]`),
  mutually exclusive with the two-gradient/`palette` startColor modes. At spawn it
  reuses the existing startColor uniform (draw 19) to store a per-particle hue
  offset `∈ [−degrees, +degrees]`; at render it **hue-rotates** the over-lifetime
  gradient colour per particle (alpha untouched) instead of multiplying a tint —
  so a warm base reads as a natural spread of hues.
- **Flipbook `randomStartFrame: boolean` + `frameOverLife: ScalarTrack | null`**
  (both render-only, deterministic, NOT folded into the statehash). Frame-index
  precedence (E30): `frameOverLife` — a deterministic 0..1 position across the
  sheet evaluated over ageNorm — **overrides the mode entirely**; else
  `mode: "random"` keeps its stable per-particle frame (`randomStartFrame`
  ignored); else `loop`/`once` with `randomStartFrame` adds a per-particle start
  offset (reusing the draw-13 frame uniform), then wraps (`loop`) or clamps
  (`once`). With `randomStartFrame: false` and `frameOverLife: null` the frame is
  exactly `⌊age·fps⌋`, byte-identical to v4.

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
| E27 | `limitVelocity` `cap = 0` | clamps stored velocity to zero — particles settle in place (valid, not an error) |
| E30 | flipbook frame precedence | `frameOverLife` (deterministic) > `mode:"random"` > `loop`/`once` + `randomStartFrame` |

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
host-attractor state, timeScale, param-values) tuples)`, output is bit-identical —
the emitter position (`setEmitterPosition`), the host attractor (`setAttractor`
parameters), `timeScale`, and the exposed-parameter values (`setParam`,
schemaVersion 6) are per-step host inputs exactly like `dt` (schemaVersion 4 +
host-API amendments). The runtime
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
