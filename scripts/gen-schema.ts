// Generates spark.schema.json from the TypeScript types (SparkDoc) and writes
// it next to the types. Committed to the repo and shipped in the package; CI
// regenerates and diffs to catch schema drift.
import { createGenerator } from "ts-json-schema-generator";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const typesPath = resolve(__dirname, "../src/format/types.ts");
const outPath = resolve(__dirname, "../src/format/spark.schema.json");

const schema = createGenerator({
  path: typesPath,
  tsconfig: resolve(__dirname, "../tsconfig.build.json"),
  type: "SparkDoc",
  expose: "export",
  topRef: true,
  additionalProperties: true, // unknown fields are preserved (plan §2.10)
}).createSchema("SparkDoc");

// 2-space indent + trailing newline to match repo canonical formatting.
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${outPath}`);
