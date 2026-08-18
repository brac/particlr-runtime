// Test-only environment shim for importing `phaser` under jsdom.
//
// WHY THIS EXISTS: Phaser's ESM bundle runs canvas-2D feature detection
// (`checkInverseAlpha`, deep inside dist/phaser.esm.js's internal require
// graph) as a MODULE-SCOPE side effect the instant `phaser` is evaluated —
// before any test code runs. jsdom implements `HTMLCanvasElement` but not a
// real 2D rendering context (`getContext('2d')` returns `null` without the
// optional `canvas` npm package), so Phaser's unguarded
// `context.fillStyle = ...` throws `TypeError: Cannot set properties of
// null`. Installing the `canvas` npm package (a native-binary shim) is
// disallowed by the plan.
//
// This file is a hand-rolled, in-memory 2D context TEST DOUBLE — not the
// `canvas` package, no native code, no npm dependency — that supplies just
// enough surface for Phaser's module-scope detection and factory internals
// to run to completion without throwing: fillStyle/globalCompositeOperation
// state, fillRect/drawImage/clearRect, getImageData/createImageData/
// putImageData (the last of these was the final piece the probe needed),
// measureText, and the path ops Phaser touches during init.
//
// USAGE PATTERN (Tasks 2+ copy this exactly): static `import` declarations
// hoist above ordinary statements, so a phaser-importing test file CANNOT
// rely on declaration order to sequence "install stub, then import phaser":
//
//   import { installPhaserCanvasStub } from "./_phaserEnv"; // hoisted
//   import Phaser from "phaser";                            // hoisted — runs
//                                                             // BEFORE the
//                                                             // line below
//   installPhaserCanvasStub(); // too late, phaser already threw
//
// Instead: import `installPhaserCanvasStub` statically (it has no side
// effects of its own — safe to hoist), call it from `beforeAll` (an
// ordinary statement, not hoisted), and import `phaser` itself with a
// dynamic `await import("phaser")` — dynamic `import()` executes at its
// point in the control flow, not hoisted, so it is guaranteed to run after
// `beforeAll` has installed the stub:
//
//   // @vitest-environment jsdom
//   import { describe, it, beforeAll, expect } from "vitest";
//   import { installPhaserCanvasStub } from "./_phaserEnv";
//
//   beforeAll(() => installPhaserCanvasStub());
//
//   describe("...", () => {
//     it("...", async () => {
//       const Phaser = (await import("phaser")).default;
//       // ...assertions...
//     });
//   });
//
// Every phaser-importing test file under test/phaser/ follows this pattern.
// `// @vitest-environment jsdom` must still be line 1 of each such file.

interface FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function makeImageData(w: number, h: number): FakeImageData {
  return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h };
}

export function installPhaserCanvasStub(): void {
  const fake2d: Record<string, unknown> = {
    fillStyle: "",
    globalCompositeOperation: "source-over",
    fillRect() {},
    drawImage() {},
    clearRect() {},
    save() {},
    restore() {},
    setTransform() {},
    getImageData(_x: number, _y: number, w: number, h: number) {
      return makeImageData(w, h);
    },
    createImageData(w: number, h: number) {
      return makeImageData(w, h);
    },
    putImageData() {},
    measureText() {
      return { width: 0 };
    },
    scale() {},
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    rect() {},
    clip() {},
    fill() {},
    stroke() {},
  };

  const orig = HTMLCanvasElement.prototype.getContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function (type: string, ...rest: unknown[]) {
    if (type === "2d") {
      (fake2d as { canvas?: unknown }).canvas = this;
      return fake2d;
    }
    return orig ? orig.call(this, type as never, ...(rest as never[])) : null;
  };
}
