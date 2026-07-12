// parseParticle: the front door for reading a .prt document.
//   string|object -> JSON.parse (throws only on non-JSON) -> migrate to current
//   (E11 refuses newer) -> validate. Unknown fields ride along on the returned
//   object untouched (plan §2.10) so serializeParticle re-emits them.

import { migrateToCurrent } from "./migrate.js";
import { normalizeNullables } from "./normalize.js";
import { validateParticle, type ValidationIssue } from "./validate.js";
import type { ParticleDoc } from "./types.js";

export interface ParseResult {
  ok: boolean;
  doc: ParticleDoc | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// structuredClone is a PLATFORM global present in BOTH of the runtime's declared
// environments — Node ≥17 (core must run in Node) and every evergreen browser —
// but it is not part of the ES2022 language library, and this package's
// Node-safe typecheck config (tsconfig.json) deliberately loads NO platform lib
// (`lib: ["ES2022"]`, `types: []`) so that browser-ONLY globals are compile
// errors. structuredClone is not browser-only, so this module-scoped ambient
// declaration admits it without widening the lib (the emit config's DOM lib
// declares it anyway; this local declaration merely shadows it there).
declare function structuredClone<T>(value: T): T;

export function parseParticle(input: string | object): ParseResult {
  // An OBJECT input is cloned before anything touches it. migrateToCurrent
  // passes a current-schemaVersion doc through BY REFERENCE (zero migration
  // steps), and normalizeNullables below mutates in place — without the clone
  // that would write null fields into the CALLER'S object (even behind a failed
  // parse). The clone buys the guarantee: parseParticle never mutates NOR
  // aliases its input; the returned doc is always parse-owned. A string input
  // needs no clone (JSON.parse yields a fresh object). structuredClone is
  // available in Node ≥17 and every evergreen browser — comfortably within the
  // runtime's declared environments (core runs in Node; the editor is
  // evergreen-only).
  const raw: unknown = typeof input === "string" ? JSON.parse(input) : structuredClone(input);

  const migrated = migrateToCurrent(raw);
  if (!migrated.ok) {
    return { ok: false, doc: null, errors: [migrated.issue], warnings: [] };
  }

  // R3 (C2/C4): canonicalize absent nullable fields to explicit `null` BEFORE
  // validation, so the sim's strict `!== null` guards and the validator both see
  // the documented explicit-null convention. Mutates the migrated doc in place
  // (parse owns it — see normalize.ts). A canonical doc is unchanged (R4).
  const normalized = normalizeNullables(migrated.doc);

  const result = validateParticle(normalized);
  if (!result.ok) {
    return { ok: false, doc: null, errors: result.errors, warnings: result.warnings };
  }
  return { ok: true, doc: result.doc, errors: [], warnings: result.warnings };
}
