# @particlr/runtime

[![CI](https://github.com/brac/particlr-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/brac/particlr-runtime/actions/workflows/ci.yml)

Plays `.prt` particle effects in PixiJS v8 (and PixiJS v7, via a separate
subpath — see below). Design effects visually in the
[particlr editor](https://particlr.com), export a `.prt` file, play it
back with this package. The editor previews through this exact runtime, and
playback is deterministic (same document + seed ⇒ same frames) — so what you
tune is what you ship.

<!-- ABSOLUTE URL, deliberately: npm does not resolve relative image paths, and
     this README is subtree-split into the public mirror where no repo-relative
     asset path exists. The image is served from the landing app's public/ dir. -->
![The 57 CC0 presets bundled with the particlr editor, each labelled](https://particlr.com/presets-contact-sheet.png)

The editor ships 57 CC0 presets — every frame above was rendered by *this*
package. Open any of them at [particlr.com](https://particlr.com), tune it,
export, and play it back here.

## Install

```sh
npm install @particlr/runtime pixi.js
```

## Use

```ts
import { Application } from "pixi.js";
import { parseParticle, Effect } from "@particlr/runtime";
import { PixiParticleRenderer } from "@particlr/runtime/pixi";

const app = new Application();
await app.init({ width: 800, height: 600 });
document.body.appendChild(app.canvas);

const doc = parseParticle(await (await fetch("boom.prt")).text()).doc!;
const fx = new Effect(doc, { seed: 1337 });
const view = new PixiParticleRenderer(fx);
view.container.position.set(400, 300); // where the effect plays
app.stage.addChild(view.container);

app.ticker.add((t) => {
  fx.step(t.deltaMS / 1000); // advance the simulation
  view.sync();               // draw it
});
```

That's the whole integration. Live example:
[particlr.com/sample](https://particlr.com/sample/).

## Pixi v7

Games still on PixiJS v7 (the v7 → v8 migration is a large lift) can consume the
same `.prt` effects without migrating. The v7 adapter lives on its own subpath —
**one subpath per major**: `./pixi` is the v8 adapter, `./pixi7` is the v7
adapter. The `pixi.js` peer range is `">=7.2.0 <9"`, and the v7 adapter is
developed and golden-tested against **pixi.js 7.4.3**.

The only differences from the v8 snippet above are the v7 `Application` idiom
(the constructor is synchronous — no `await app.init()` — and the canvas is
`app.view`, typed as `ICanvas`, hence the cast) and the import path:

```ts
import { Application } from "pixi.js";
import { parseParticle, Effect } from "@particlr/runtime";
import { PixiParticleRenderer } from "@particlr/runtime/pixi7";

const app = new Application({ width: 800, height: 600 });
document.body.appendChild(app.view as HTMLCanvasElement);

const doc = parseParticle(await (await fetch("boom.prt")).text()).doc!;
const fx = new Effect(doc, { seed: 1337 });
const view = new PixiParticleRenderer(fx);
view.container.position.set(400, 300); // where the effect plays
app.stage.addChild(view.container);

app.ticker.add(() => {
  fx.step(app.ticker.deltaMS / 1000); // advance the simulation
  view.sync();                        // draw it
});
```

The public API is identical to `./pixi` — migrating between majors is a one-line
import change. The v7 adapter is at **full feature parity**: flipbooks, trails
(including connect ribbons), sub-emitter rendering (driven by the shared core),
and dissolve (via a forked v7 particle pipeline). The one hard limit is the
renderer: v7 has no WebGPU, so the v7 adapter is **WebGL only**.

Performance note, measured honestly: v7's `ParticleContainer` renders full
`Sprite` objects where v8 renders lightweight `Particle` structs, so the v7
adapter costs more CPU per frame by construction — in our benchmarks (~500
live particles, high churn, real Chromium) the v7 adapter spends ~1.3 ms per
frame where v8 spends ~0.1 ms. Both are far under a 60 fps budget; at typical
2D-game particle counts this is not a limiting factor, but if you are pushing
tens of thousands of particles, v8 is the faster target.

## Going further

`Effect` also has a movable emitter for trails (`setEmitterPosition`),
playback control (`timeScale`, `onDone`), a host-driven attractor
(`setAttractor`), and per-instance parameters (`setParam`, `setColorParam`) —
one `boom.prt`, many weapons. The full API is documented in the shipped
TypeScript types, and the `.prt` format's reference is the bundled JSON
Schema: `import schema from "@particlr/runtime/particle.schema.json"`.

## License

MIT. See [LICENSE](./LICENSE).
