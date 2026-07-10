// Preset fixtures live at the MONOREPO root (presets/), which the public
// runtime mirror does not ship. Preset-dependent suites gate on `hasPresets`
// via `describe.skipIf(!hasPresets)` so `npm test` runs green standalone in
// the mirror, while the monorepo (where presets exist) keeps full coverage —
// nothing skips there.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const presetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../presets");
export const hasPresets = existsSync(presetsDir);
