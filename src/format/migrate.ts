// Forward-only migrations (FORMAT_SPEC "Versioning & migration rules").
// Migrations are pure (docVn) => docVn+1, chained on import. v1 is the floor,
// so MIGRATIONS is currently empty; the runner exists so adding v2 later is a
// one-line change and E11 (refuse newer-than-current) is enforced in one place.

import { CURRENT_SCHEMA_VERSION } from "./types.js";
import type { ValidationIssue } from "./validate.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MIGRATIONS: Record<number, (doc: any) => any> = {
  // 1: (doc) => ({ ...doc, schemaVersion: 2, /* ... */ }),  // added when v2 lands
};

export type MigrateResult =
  | { ok: true; doc: unknown }
  | { ok: false; issue: ValidationIssue };

export function migrateToCurrent(raw: unknown): MigrateResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, issue: { path: "", message: "document must be an object" } };
  }
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return {
      ok: false,
      issue: { path: "schemaVersion", message: "schemaVersion must be a positive integer", code: "invalid-version" },
    };
  }
  if (v > CURRENT_SCHEMA_VERSION) {
    // E11: never best-effort parse a newer document forward.
    return {
      ok: false,
      issue: {
        path: "schemaVersion",
        message: `document schemaVersion ${v} is newer than supported (${CURRENT_SCHEMA_VERSION})`,
        code: "newer-version",
      },
    };
  }
  let cur: unknown = raw;
  for (let ver = v; ver < CURRENT_SCHEMA_VERSION; ver++) {
    const migrate = MIGRATIONS[ver];
    if (!migrate) {
      return {
        ok: false,
        issue: { path: "schemaVersion", message: `no migration registered from v${ver}`, code: "no-migration" },
      };
    }
    cur = migrate(cur);
  }
  return { ok: true, doc: cur };
}
