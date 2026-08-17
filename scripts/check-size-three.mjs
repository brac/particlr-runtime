// Bundles the Three adapter entry and asserts the gzipped size is within
// the CLAUDE.md adapter budget of 8 KB, with `three` external (host-provided
// peer dependency, never bundled).
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "../src/three/index.ts");
const BUDGET_BYTES = 8 * 1024;

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  minify: true,
  write: false,
  external: ["three"],
});

const js = result.outputFiles[0].contents;
const gzipped = gzipSync(js).length;
const kb = (gzipped / 1024).toFixed(2);

const budgetKb = (BUDGET_BYTES / 1024).toFixed(2);
console.log(`@particlr/runtime/three adapter: ${kb} KB gzipped (budget ${budgetKb} KB)`);

if (gzipped > BUDGET_BYTES) {
  console.error(`FAIL: @particlr/runtime/three adapter exceeds ${budgetKb} KB gzipped budget (${kb} KB).`);
  process.exit(1);
}
