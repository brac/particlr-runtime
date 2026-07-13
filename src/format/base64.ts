// Pure base64 decoder (schemaVersion 4) — no `Buffer`, no `atob`, so it decodes
// identically in Node and the browser (determinism: the embedded mask bytes are
// the source of truth, never re-encoded). Standard base64 alphabet with required
// `=` padding to a multiple of 4 chars. Returns null on any malformed input (bad
// character, wrong length, or misplaced / wrong-count padding) so callers can
// degrade gracefully (E23) instead of throwing.

// The one legal shape for an embedded texture value (E44): a base64 image data
// URL. Capture group 1 is the MIME type. Shared by the validator (rejects
// anything else at parse time) and the Pixi adapter (decodes the payload with
// decodeBase64 instead of fetch(), so the runtime carries no network
// capability — a remote URL in a hand-crafted doc can never be loaded).
export const IMAGE_DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const EQ = 61; // "="

// charCode -> 6-bit value, or -1 for any non-alphabet character (incl. "=").
const DECODE: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

const sextet = (s: string, i: number): number => {
  const c = s.charCodeAt(i);
  return c < 128 ? DECODE[c]! : -1;
};

export function decodeBase64(s: string): Uint8Array | null {
  const len = s.length;
  if (len % 4 !== 0) return null;
  if (len === 0) return new Uint8Array(0);

  // Trailing padding (0, 1, or 2 "="). Padding elsewhere fails as a bad char.
  let pad = 0;
  if (s.charCodeAt(len - 1) === EQ) pad = s.charCodeAt(len - 2) === EQ ? 2 : 1;

  const out = new Uint8Array((len / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const last = i + 4 === len;
    const n0 = sextet(s, i);
    const n1 = sextet(s, i + 1);
    if (n0 < 0 || n1 < 0) return null;
    out[o++] = (n0 << 2) | (n1 >> 4);
    if (last && pad === 2) {
      if (s.charCodeAt(i + 2) !== EQ || s.charCodeAt(i + 3) !== EQ) return null;
      break;
    }
    const n2 = sextet(s, i + 2);
    if (n2 < 0) return null;
    out[o++] = ((n1 & 0xf) << 4) | (n2 >> 2);
    if (last && pad === 1) {
      if (s.charCodeAt(i + 3) !== EQ) return null;
      break;
    }
    const n3 = sextet(s, i + 3);
    if (n3 < 0) return null;
    out[o++] = ((n2 & 0x3) << 6) | n3;
  }
  return out;
}
