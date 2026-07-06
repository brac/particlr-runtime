import { describe, it, expect } from "vitest";
import { EASING } from "../../src/index.js";

describe("easing functions (§2.2)", () => {
  const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 12);

  it("linear", () => {
    for (const u of [0, 0.25, 0.5, 1]) near(EASING.linear(u), u);
  });

  it("easeIn = u^2", () => {
    near(EASING.easeIn(0), 0);
    near(EASING.easeIn(0.25), 0.0625);
    near(EASING.easeIn(0.5), 0.25);
    near(EASING.easeIn(1), 1);
  });

  it("easeOut = 1-(1-u)^2", () => {
    near(EASING.easeOut(0), 0);
    near(EASING.easeOut(0.25), 0.4375);
    near(EASING.easeOut(0.5), 0.75);
    near(EASING.easeOut(1), 1);
  });

  it("easeInOut is symmetric with midpoint 0.5", () => {
    near(EASING.easeInOut(0), 0);
    near(EASING.easeInOut(0.25), 0.125);
    near(EASING.easeInOut(0.5), 0.5);
    near(EASING.easeInOut(0.75), 0.875);
    near(EASING.easeInOut(1), 1);
  });

  it("step holds until the next key", () => {
    near(EASING.step(0), 0);
    near(EASING.step(0.99), 0);
    near(EASING.step(1), 1);
  });
});
