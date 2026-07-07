// Copies the committed JSON Schema into dist so it ships with the package
// (exports "./particle.schema.json"). Run as part of `npm run build`.
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, "../src/format/particle.schema.json");
const destDir = resolve(__dirname, "../dist");
mkdirSync(destDir, { recursive: true });
copyFileSync(src, resolve(destDir, "particle.schema.json"));
