import { describe, it, expect } from "vitest";
import { RUNTIME_VERSION } from "../src/index.js";

describe("runtime placeholder", () => {
  it("exports a version string", () => {
    expect(typeof RUNTIME_VERSION).toBe("string");
  });
});
