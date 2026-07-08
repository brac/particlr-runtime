import { describe, it, expect } from "vitest";
import { decodeBase64 } from "../../src/format/base64.js";

// A reference encoder so tests can round-trip arbitrary byte arrays without
// depending on `Buffer`/`btoa` semantics leaking into the assertions.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : ALPHABET[b2 & 63];
  }
  return out;
}
const arr = (u: Uint8Array | null): number[] | null => (u === null ? null : Array.from(u));

describe("decodeBase64 — valid inputs", () => {
  it("decodes the 1×1 opaque default mask", () => {
    expect(arr(decodeBase64("/w=="))).toEqual([255]);
  });

  it("decodes a 3×3 alpha mask (2 pad, 1 pad, 0 pad groups)", () => {
    // /4AAQMgQ/1oH == [255,128,0,64,200,16,255,90,7]
    expect(arr(decodeBase64("/4AAQMgQ/1oH"))).toEqual([255, 128, 0, 64, 200, 16, 255, 90, 7]);
  });

  it("decodes with no padding", () => {
    expect(arr(decodeBase64("AQID"))).toEqual([1, 2, 3]);
  });

  it("decodes with one '=' (two output bytes)", () => {
    expect(arr(decodeBase64(encode([10, 20])))).toEqual([10, 20]);
  });

  it("decodes an empty string to zero bytes", () => {
    expect(arr(decodeBase64(""))).toEqual([]);
  });

  it("round-trips arbitrary byte arrays for every remainder length", () => {
    for (const n of [1, 2, 3, 4, 5, 16, 128, 255]) {
      const bytes = Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(arr(decodeBase64(encode(bytes)))).toEqual(bytes);
    }
  });
});

describe("decodeBase64 — invalid inputs (null, never throws)", () => {
  it("rejects a length that is not a multiple of 4", () => {
    expect(decodeBase64("ABC")).toBeNull();
    expect(decodeBase64("A")).toBeNull();
  });

  it("rejects characters outside the base64 alphabet", () => {
    expect(decodeBase64("@@@@")).toBeNull();
    expect(decodeBase64("AB C")).toBeNull(); // space
    expect(decodeBase64("A-_A")).toBeNull(); // url-safe chars are not accepted
  });

  it("rejects misplaced or excess padding", () => {
    expect(decodeBase64("A=AA")).toBeNull(); // '=' not at the end
    expect(decodeBase64("====")).toBeNull(); // all padding
    expect(decodeBase64("A===")).toBeNull(); // three '='
    expect(decodeBase64("AB=A")).toBeNull(); // pad char mid-group
  });
});
