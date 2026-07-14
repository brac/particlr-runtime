# @particlr/runtime

[![CI](https://github.com/brac/particlr-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/brac/particlr-runtime/actions/workflows/ci.yml)

Plays `.prt` particle effects in PixiJS v8. Design effects visually in the
[particlr editor](https://particlr.com), export a `.prt` file, play it
back with this package. The editor previews through this exact runtime, and
playback is deterministic (same document + seed ⇒ same frames) — so what you
tune is what you ship.

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

## Going further

`Effect` also has a movable emitter for trails (`setEmitterPosition`),
playback control (`timeScale`, `onDone`), a host-driven attractor
(`setAttractor`), and per-instance parameters (`setParam`, `setColorParam`) —
one `boom.prt`, many weapons. The full API is documented in the shipped
TypeScript types, and the `.prt` format's reference is the bundled JSON
Schema: `import schema from "@particlr/runtime/particle.schema.json"`.

## License

MIT. See [LICENSE](./LICENSE).
