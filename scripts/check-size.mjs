// Bundles the runtime core entry (format + core; pixi excluded by construction)
// and asserts the gzipped size is within the CLAUDE.md budget of 15 KB.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "../src/index.ts");
const BUDGET_BYTES = 15 * 1024;

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

console.log(`@sparkr/runtime core: ${kb} KB gzipped (budget 15.00 KB)`);

if (gzipped > BUDGET_BYTES) {
  console.error(`FAIL: core exceeds 15 KB gzipped budget (${kb} KB).`);
  process.exit(1);
}
