// Phaser-native sugar (D3 adoption hook). `registerParticlr()` is explicit —
// no import side effects — and idempotent: it touches only Phaser's static
// registries (`FileTypesManager`'s module-scope `types` map and
// `GameObjectFactory.prototype`), so it is safe to call before any `Game`
// exists. The `.prt` fetch happens inside Phaser's `LoaderPlugin`
// (host-initiated); runtime code never fetches (zero network capability rule).
// D7 amendment (spec, docs/superpowers/specs/2026-08-17-phaser-adapter-design.md):
// the sugar's core imports are value-level (parseParticle, Effect) and MUST
// resolve through the package's own name, not a relative path. A relative
// import bundles core+format INTO the phaser adapter (measured +18.5 KB,
// blowing the 10 KB adapter budget); the self-reference resolves the same
// way for a host that has already loaded `@particlr/runtime` (the package.json
// `exports` map makes this legal both at runtime, via Node's self-referencing
// packages, and in the emitted dist), and `check-size-phaser.mjs` externals
// `@particlr/runtime` so the size gate measures the adapter's MARGINAL cost,
// not core's cost a second time.
import Phaser from "phaser";
import { parseParticle, Effect } from "@particlr/runtime";
import { PhaserParticleRenderer } from "./renderer.js";

let registered = false;

/**
 * `.prt` loader file type. `JSONFile`'s real constructor
 * (`node_modules/phaser/src/loader/filetypes/JSONFile.js`) accepts either
 * `(loader, key, url, xhrSettings, dataKey)` or `(loader, config)`; only the
 * config route lets us override `extension` (the base class hardcodes
 * `type: 'json'`, `cache: loader.cacheManager.json`, `responseType: 'text'`
 * itself regardless of route — that cache is what `this.add.particlr` reads
 * from via `scene.cache.json`).
 *
 * `onProcess` is a full override, not a `super.onProcess()` call: the parent
 * runs a bare `JSON.parse` + optional `dataKey` pluck; this file needs
 * `parseParticle`'s migrate/normalize/validate pipeline instead, so
 * replaying the parent's parse would be redundant work with the wrong
 * failure mode. The parent's `FILE_PROCESSING` intermediate state (set
 * before parsing) only matters for the pre-populated-JS-object constructor
 * path (`IsPlainObject(url)`), which this file never takes — `onProcessComplete`
 * / `onProcessError` both set their own terminal state unconditionally, so
 * skipping it is the minimal correct override.
 */
class ParticlrFile extends Phaser.Loader.FileTypes.JSONFile {
  constructor(loader: Phaser.Loader.LoaderPlugin, key: string, url: string) {
    super(loader, { key, url, extension: "prt" });
  }

  override onProcess(): void {
    let parsed: ReturnType<typeof parseParticle>;
    try {
      parsed = parseParticle(this.xhrLoader!.responseText);
    } catch (err) {
      // The try wraps parseParticle's whole migrate/normalize/validate
      // pipeline, not just JSON.parse — keep the message accurate for any
      // throw source in that chain, not just malformed JSON.
      console.warn(`particlr: "${this.key}" could not be parsed as a .prt document`, err);
      this.onProcessError();
      return;
    }
    if (!parsed.ok) {
      console.warn(`particlr: "${this.key}" is not a valid .prt document`, parsed.errors);
      this.onProcessError();
      return;
    }
    this.data = parsed.doc;
    this.onProcessComplete();
  }
}

export function registerParticlr(): void {
  if (registered) return;
  registered = true;

  Phaser.Loader.FileTypesManager.register(
    "particlr",
    function (this: Phaser.Loader.LoaderPlugin, key: string, url: string) {
      this.addFile(new ParticlrFile(this, key, url));
      return this;
    },
  );

  Phaser.GameObjects.GameObjectFactory.register(
    "particlr",
    function (
      this: Phaser.GameObjects.GameObjectFactory,
      key: string,
      x: number,
      y: number,
      opts?: { autoStep?: boolean; seed?: number },
    ) {
      const doc = this.scene.cache.json.get(key);
      if (doc === undefined) {
        throw new Error(
          `particlr: no loaded document for key "${key}". Did you forget ` +
            `this.load.particlr("${key}", url) in preload, or is the key misspelled?`,
        );
      }
      const fx = new Effect(doc, { seed: opts?.seed ?? 1337 });
      const view = new PhaserParticleRenderer(fx, { scene: this.scene, autoStep: opts?.autoStep });
      view.gameObject.setPosition(x, y);
      (view.gameObject as unknown as { particlr: { fx: Effect; view: PhaserParticleRenderer } }).particlr = {
        fx,
        view,
      };
      return this.displayList.add(view.gameObject);
    },
  );
}

// Typed sugar for hosts: `this.load.particlr(key, url)` and
// `this.add.particlr(key, x, y, opts?)`. Ambient augmentation only — no
// runtime effect, so it is safe to ship even for hosts that never call
// `registerParticlr()`. `phaser`'s bundled types declare a GLOBAL ambient
// `Phaser` namespace (`declare namespace Phaser { ... }` in phaser.d.ts) and
// separately `declare module "phaser" { export = Phaser; }` — there is no
// `Phaser` namespace *nested inside* the module block to augment, so merging
// has to happen through `declare global`, not `declare module "phaser"`.
// `LoaderPlugin`/`GameObjectFactory` are declared as `class`, which merges
// with an `interface` of the same name in the same namespace.
declare global {
  namespace Phaser.Loader {
    interface LoaderPlugin {
      particlr(key: string, url: string): this;
    }
  }
  namespace Phaser.GameObjects {
    interface GameObjectFactory {
      particlr(
        key: string,
        x: number,
        y: number,
        opts?: { autoStep?: boolean; seed?: number },
      ): Phaser.GameObjects.Container;
    }
  }
}
