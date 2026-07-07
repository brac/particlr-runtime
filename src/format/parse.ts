// parseParticle: the front door for reading a .prt document.
//   string|object -> JSON.parse (throws only on non-JSON) -> migrate to current
//   (E11 refuses newer) -> validate. Unknown fields ride along on the returned
//   object untouched (plan §2.10) so serializeParticle re-emits them.

import { migrateToCurrent } from "./migrate.js";
import { validateParticle, type ValidationIssue } from "./validate.js";
import type { ParticleDoc } from "./types.js";

export interface ParseResult {
  ok: boolean;
  doc: ParticleDoc | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function parseParticle(input: string | object): ParseResult {
  const raw: unknown = typeof input === "string" ? JSON.parse(input) : input;

  const migrated = migrateToCurrent(raw);
  if (!migrated.ok) {
    return { ok: false, doc: null, errors: [migrated.issue], warnings: [] };
  }

  const result = validateParticle(migrated.doc);
  if (!result.ok) {
    return { ok: false, doc: null, errors: result.errors, warnings: result.warnings };
  }
  return { ok: true, doc: result.doc, errors: [], warnings: result.warnings };
}
