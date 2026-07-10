import { describe, it, expect } from "vitest";
import { RUNTIME_VERSION } from "../src/index.js";
import pkg from "../package.json";

describe("runtime version", () => {
  it("exports a version string", () => {
    expect(typeof RUNTIME_VERSION).toBe("string");
  });

  // The published package and the exported constant must agree — a consumer
  // reading RUNTIME_VERSION should get the real package version, not a stale
  // placeholder (this pins the fix for the shipped "0.0.0" bug).
  it("matches package.json version", () => {
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });
});
