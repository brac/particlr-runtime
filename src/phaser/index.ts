// @particlr/runtime/phaser — Phaser 4 adapter entry. `phaser` is an optional
// peer dependency (>=4.2 <5). Renders the 2D sim as a native Phaser citizen:
// a GameObject on the display list, batched through Phaser's own quad batcher.
// The layer GameObject classes (`ParticlrLayer`, `ParticlrTrailLayer`) are
// deliberately NOT re-exported: they are an implementation detail of the
// renderer, the sibling adapters export no display-object classes either
// ("R4: do not widen"), and nothing outside the adapter's own tests — which
// import them from `./renderer.js` — has a use for them.
export { PhaserParticleRenderer, type PhaserParticleRendererOptions } from "./renderer.js";
export { registerParticlr } from "./plugin.js";
