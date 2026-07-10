// Bundles the runtime entry (format + core; pixi excluded by construction)
// and asserts the gzipped size is within the CLAUDE.md budget of 25 KB
// (raised from 15 at TIER2 M0 and from 20 at RIBBON_INHERIT M2, both with
// Ben's sign-off — the core now carries trails, sub-emitters, attractors,
// dissolve, host params, and connect ribbons; the format layer hosts need at
// load time is the other ~half).
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "../src/index.ts");
const BUDGET_BYTES = 25 * 1024;

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  minify: true,
  write: false,
  external: ["pixi.js"],
});

const js = result.outputFiles[0].contents;
const gzipped = gzipSync(js).length;
const kb = (gzipped / 1024).toFixed(2);

const budgetKb = (BUDGET_BYTES / 1024).toFixed(2);
console.log(`@particlr/runtime core: ${kb} KB gzipped (budget ${budgetKb} KB)`);

if (gzipped > BUDGET_BYTES) {
  console.error(`FAIL: core exceeds ${budgetKb} KB gzipped budget (${kb} KB).`);
  process.exit(1);
}
