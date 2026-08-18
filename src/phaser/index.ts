// @particlr/runtime/phaser — Phaser 4 adapter entry. `phaser` is an optional
// peer dependency (>=4.2 <5). Renders the 2D sim as a native Phaser citizen:
// a GameObject on the display list, batched through Phaser's own quad batcher.
export {
  PhaserParticleRenderer,
  ParticlrLayer,
  ParticlrTrailLayer,
  type PhaserParticleRendererOptions,
} from "./renderer.js";
export { registerParticlr } from "./plugin.js";
