// @sparkr/runtime — public entry (format + core only; never imports pixi).
// The Pixi v8 adapter is a separate entry: `@sparkr/runtime/pixi`.

export * from "./format/index.js";

export const RUNTIME_VERSION = "0.0.0";
