// @particlr/runtime — public entry (format + core only; never imports pixi).
// The Pixi v8 adapter is a separate entry: `@particlr/runtime/pixi`.

export * from "./format/index.js";
export * from "./core/index.js";

// Keep in sync with package.json "version" — pinned by a test in
// test/placeholder.test.ts so the two can never drift.
export const RUNTIME_VERSION = "0.5.0";
