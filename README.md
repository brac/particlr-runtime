# @sparkr/runtime

The MIT-licensed particle runtime behind [sparkr](../../README.md) — a
framework-agnostic simulation core plus a PixiJS v8 adapter. It plays back
`.spark` effect documents **deterministically**: the same document, seed, and
sequence of `dt` values always produce the same frames. The sparkr editor
previews through this exact package, so what you tune is what you ship.

- **Zero runtime dependencies** in the core (`pixi.js` is an optional peer, used
  only by the `/pixi` adapter).
- **Node-safe core** — no DOM, no `Math.random`, no wall-clock reads.
- Ships the JSON Schema for `.spark` (`@sparkr/runtime/spark.schema.json`).

## Install

```sh
npm install @sparkr/runtime pixi.js
```

`pixi.js@^8` is a peer dependency (only needed if you use the `/pixi` adapter).

## Quick start (Pixi v8)

This is the whole integration — load a `.spark`, step it each frame, render it:

```ts
import { Application } from "pixi.js";
import { parseSpark, Effect } from "@sparkr/runtime";
import { PixiSparkRenderer } from "@sparkr/runtime/pixi";

const app = new Application();
await app.init({ background: "#000", width: 800, height: 600 });
document.body.appendChild(app.canvas);

const doc = parseSpark(await (await fetch("boom.spark")).text()).doc!;
const fx = new Effect(doc, { seed: 1337 });
const view = new PixiSparkRenderer(fx);
view.container.position.set(400, 300); // where the effect plays
app.stage.addChild(view.container);

app.ticker.add((ticker) => {
  fx.step(ticker.deltaMS / 1000); // advance the simulation
  view.sync();                    // copy state onto the Pixi particles
});
```

A complete runnable version lives in [`samples/pixi-game`](../../samples/pixi-game).

## Core API (`@sparkr/runtime`)

### Reading & writing documents

```ts
parseSpark(input: string | object): ParseResult
```
Parses (JSON string or object), migrates to the current schema version, and
validates. Unknown fields are preserved for byte-stable round-tripping. Throws
only if a string isn't valid JSON.

```ts
interface ParseResult {
  ok: boolean;
  doc: SparkDoc | null;      // null when !ok
  errors: ValidationIssue[]; // { path, message, code? }
  warnings: ValidationIssue[];
}
```

```ts
serializeSpark(doc: SparkDoc): string
```
Emits canonical JSON (declared key order, unknown keys preserved, 2-space
indent, `\n` endings, trailing newline). `serializeSpark(parseSpark(text).doc)`
equals `text` byte-for-byte for canonical input.

```ts
validateSpark(input: object): ValidationResult   // { ok, doc, warnings } | { ok:false, errors, warnings }
```

`BUILTIN_TEXTURE_IDS` — the built-in texture ids: `circle-soft`, `circle-hard`,
`square`, `spark`, `smoke`.

### Effect

```ts
class Effect {
  constructor(doc: SparkDoc, opts?: { seed?: number }); // seed overrides doc.seed
  step(dt: number): void;      // advance by dt seconds
  reset(seed?: number): void;  // rewind to t=0 (re-prewarms if configured)
  readonly time: number;       // effect-local seconds
  readonly seed: number;
  readonly isDone: boolean;    // non-looping effect finished and no particles remain
  readonly particleCount: number;
  readonly layers: readonly LayerSim[]; // per-layer: count, capped, typed-array state
}
```

Each `LayerSim` exposes read-only per-particle typed arrays (`x`, `y`, `velX`,
`velY`, `age`, `lifetime`, `rotation`, …) plus `count` and `capped`. Use
`computeRenderState(layerSim, buffers)` to evaluate size / color / flipbook-frame
into your own buffers if you're writing a custom renderer — keeping all renderers
identical to the preview.

### Behavioral guarantees (edge cases)

| # | Case | Behavior |
|---|---|---|
| E1 | `dt` larger than 1/20 s (tab unhide) | clamped to 1/20 s; never sub-steps |
| E2 | `dt <= 0` | no-op |
| E5 | prewarm | simulates one full duration of *continuous* emission (bursts suppressed) before the first visible frame |
| E6 | `looping: false` ends | emitters stop; live particles finish; `isDone` becomes true at 0 particles |
| E7 | pool full (`maxParticles`) | new spawns dropped silently; `layer.capped` flags it |
| E8 | seeking a time | `reset(seed)` then `step(1/60)` to the target — exact, thanks to determinism |
| E9 | serializing while playing | `serializeSpark` uses the authored document; playback state never serializes |

## Pixi adapter (`@sparkr/runtime/pixi`)

```ts
class PixiSparkRenderer {
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

## Determinism contract

Given identical `(document, seed, sequence of dt values)`, output is
bit-identical. The runtime never reads wall-clock time, `Math.random`, or any
global — the only randomness is a seeded mulberry32 PRNG, one stream per layer.
This is what makes seek/scrub exact and enables golden-frame testing.

## The `.spark` format

`.spark` is a small, versioned, declarative JSON document — see
[`FORMAT_SPEC.md`](../../docs/FORMAT_SPEC.md) and the machine-readable
[`spark.schema.json`](./src/format/spark.schema.json) shipped with this package
(`import schema from "@sparkr/runtime/spark.schema.json"`).

Because the format is small, documented, and agent-readable, a coding agent can
author or tweak effects directly — "make the explosion 20% punchier and shift it
orange" is a JSON edit against a published schema, no editor required.

## License

MIT. See [LICENSE](./LICENSE).
