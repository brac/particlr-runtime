// Shared fakes for the Phaser adapter's structural tests.
//
// NOTE ON IMPORTS: this module must NOT statically `import Phaser from
// "phaser"` — static imports hoist above `beforeAll`, and Phaser's module-scope
// canvas-2D probe throws under jsdom before `installPhaserCanvasStub()` has
// run (see `_phaserEnv.ts`). `makeFakeScene` is therefore async and pulls
// Phaser in with a dynamic `import()` at call time, by which point the stub is
// installed. Test files must likewise `await import(...)` any adapter module
// that imports `phaser`.
import { makeDoc, makeLayer } from "../format/_helpers.js";
import type { ParticleDoc } from "../../src/index.js";

/** A minimal valid `.prt` doc with `n` layers (ids l1..ln). */
export function makeEffectDoc(nLayers: number): ParticleDoc {
  return makeDoc({
    layers: Array.from({ length: nLayers }, (_, i) => makeLayer({ id: `l${i + 1}`, name: `layer ${i + 1}` })),
  });
}

export interface FakeFrame {
  source: { width: number; height: number; glTexture: object };
  width: number;
  height: number;
}

export interface FakeTexture {
  key: string;
  source: Array<{ width: number; height: number; glTexture: object }>;
  get(name?: string | number): FakeFrame;
}

function fakeTexture(key: string, width: number, height: number): FakeTexture {
  const source = { width, height, glTexture: { key } };
  return { key, source: [source], get: () => ({ source, width, height }) };
}

/** A TextureManager double: real Phaser never runs, so nothing touches GL. */
export function makeFakeTextureManager() {
  const keys = new Map<string, FakeTexture>();
  return {
    keys,
    exists: (k: string) => keys.has(k),
    get(k: string) {
      return keys.get(k) ?? fakeTexture(k, 1, 1);
    },
    addUint8Array(k: string, _d: Uint8Array, w: number, h: number) {
      const t = fakeTexture(k, w, h);
      keys.set(k, t);
      return t;
    },
    addCanvas(k: string, c: { width: number; height: number }) {
      const t = fakeTexture(k, c.width, c.height);
      keys.set(k, t);
      return t;
    },
  };
}

/** A BatchHandlerQuad double: records every submitted quad. */
export function makeFakeQuadHandler() {
  const calls: unknown[][] = [];
  return {
    name: "BatchHandlerQuad",
    calls,
    batch(...args: unknown[]) {
      calls.push(args);
    },
  };
}

/** A BatchHandlerStrip double: records every submitted ribbon. */
export function makeFakeStripHandler() {
  const calls: unknown[][] = [];
  return {
    name: "BatchHandlerStrip",
    calls,
    batchStrip(...args: unknown[]) {
      calls.push(args);
    },
  };
}

/**
 * A `ParticlrDissolveBatch` double. The real subclass extends
 * `BatchHandlerQuad`, whose constructor demands a live WebGL context
 * (index buffers, VAOs, a ProgramManager), so the fake manager NEVER invokes
 * the registered constructor — it hands back this stand-in instead, exactly
 * as `getNode("BatchHandlerQuad")` hands back `makeFakeQuadHandler()`.
 */
export function makeFakeDissolveHandler(name: string) {
  const calls: unknown[][] = [];
  const handler = {
    name,
    calls,
    /** Whatever `registerDissolveHandler`/`releaseDissolveHandler` last
     * re-pointed this node at; `null` until a reuse or release happens. */
    layerRef: null as unknown,
    batch(...args: unknown[]) {
      calls.push(args);
    },
    setLayerRef(ref: unknown) {
      handler.layerRef = ref;
    },
  };
  return handler;
}

export type FakeScene = Awaited<ReturnType<typeof makeFakeScene>>;

/**
 * A Scene double carrying exactly the internals Phaser's real `GameObject` and
 * `Container` constructors touch (`sys.events`, `sys.queueDepthSort`,
 * `sys.displayList`, `sys.renderer`), plus the adapter's own needs
 * (`sys.textures`, `sys.renderer.renderNodes`, `events`).
 */
export async function makeFakeScene() {
  const Phaser = (await import("phaser")).default;
  const events = new Phaser.Events.EventEmitter();
  const quadHandler = makeFakeQuadHandler();
  const stripHandler = makeFakeStripHandler();
  const textures = makeFakeTextureManager();

  // Phaser reserves indices 0..27 for its native blend modes; a custom mode is
  // appended past the end (Task 2 reads `blendModes.length - 1`).
  const blendModes: object[] = Array.from({ length: 28 }, () => ({}));

  const displayList = {
    active: true,
    exists: () => false,
    add() {},
    remove() {},
    queueDepthSort() {},
    events,
    willRender: () => true,
  };

  // Custom render nodes registered through the manager, in registration order.
  const registeredNodes: string[] = [];
  const customNodes = new Map<string, ReturnType<typeof makeFakeDissolveHandler>>();
  /** Mirrors Phaser's `_nodeConstructors`: entries are added, never removed. */
  const nodeConstructors = new Map<string, unknown>();

  const renderNodes = {
    registeredNodes,
    hasNode: (name: string) =>
      customNodes.has(name) || name === "BatchHandlerQuad" || name === "BatchHandlerStrip",
    addNode(name: string, _node: unknown) {
      if (renderNodes.hasNode(name)) throw new Error(`node ${name} already exists.`);
      registeredNodes.push(name);
      customNodes.set(name, makeFakeDissolveHandler(name));
    },
    /**
     * Real Phaser stores the constructor in `_nodeConstructors[name]`,
     * instantiates it on the first `getNode`, files the instance under
     * `_nodes[name]` — and **never deletes the constructor entry**. That
     * retention is modelled faithfully here (`nodeConstructors` is only ever
     * added to) because it is the mechanism behind a whole class of leak: a
     * closure registered here is pinned for the Game's life.
     *
     * What is NOT modelled is the construction itself — a real
     * `ParticlrDissolveBatch` needs a live WebGL context — so `getNode` hands
     * back a stand-in, exactly as it does for `"BatchHandlerQuad"`. Tests that
     * need the constructor's effects invoke it themselves via
     * `scene.nodeConstructor(name)`.
     */
    addNodeConstructor(name: string, ctor: unknown) {
      if (renderNodes.hasNode(name)) throw new Error(`node constructor ${name} already exists.`);
      registeredNodes.push(name);
      nodeConstructors.set(name, ctor);
      customNodes.set(name, makeFakeDissolveHandler(name));
    },
    getNode: (name: string) => {
      if (name === "BatchHandlerQuad") return quadHandler;
      if (name === "BatchHandlerStrip") return stripHandler;
      // NB: the constructor entry deliberately survives this call.
      return customNodes.get(name) ?? null;
    },
  };

  const renderer = {
    blendModes,
    addBlendMode(func: number[], equation: number) {
      blendModes.push({ func, equation });
      return blendModes.length - 2; // mirrors Phaser 4.2.1's off-by-one
    },
    renderNodes,
  };

  const scene = {
    events,
    quadHandler,
    stripHandler,
    /** Names passed to `renderNodes.addNode`/`addNodeConstructor`, in order. */
    registeredNodes,
    /** The double standing in for a registered custom node, by name. */
    customNode: (name: string) => customNodes.get(name) ?? null,
    /** The constructor Phaser would retain forever under `name`. Tests invoke
     * it directly, since the double never constructs (see addNodeConstructor). */
    nodeConstructor: (name: string) => nodeConstructors.get(name) ?? null,
    textures,
    sys: {
      events,
      displayList,
      textures,
      renderer,
      queueDepthSort() {},
    },
    add: {
      existing<T>(go: T): T {
        return go;
      },
    },
    /** Register a fake decoded texture directly into the fake TextureManager,
     * for tests that inject a `loadTexture` resolving to a known-size sheet. */
    addFakeTexture(key: string, width: number, height: number): FakeTexture {
      return textures.addUint8Array(key, new Uint8Array(0), width, height)!;
    },
  };

  return scene;
}
