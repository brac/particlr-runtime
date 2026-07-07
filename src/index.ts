// @particlr/runtime — public entry (format + core only; never imports pixi).
// The Pixi v8 adapter is a separate entry: `@particlr/runtime/pixi`.

export * from "./format/index.js";
export * from "./core/index.js";

export const RUNTIME_VERSION = "0.0.0";
