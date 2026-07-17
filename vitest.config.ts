import { defineConfig, configDefaults } from "vitest/config";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

// Package-local vitest config, scoped to @particlr/runtime's own test/ dir.
//
// WHY THIS FILE EXISTS — dual-context: the monorepo ROOT vitest.config.ts owns
// the projects split for the whole workspace, but that root config does NOT
// travel with the `git subtree split --prefix=packages/runtime` that produces
// the public standalone mirror (github.com/brac/particlr-runtime). Without a
// config in the package, the mirror's `npm test` runs vitest with NO config:
// the pixi7 suite then runs in the default resolution and `import "pixi.js"`
// inside src/pixi7/* resolves to the installed v8 monolith, failing the
// resolution-proof test. This file lives under packages/runtime/ so it rides
// the split and gives the mirror the same two-project shape.
//
// The monorepo ROOT config remains the AUTHORITY for root `npm test` (it also
// carries the editor suite + @particlr aliases + the license-key env). This
// config is the nearest one to packages/runtime, so vitest ALSO picks it up for
// `npm test -w @particlr/runtime` in the monorepo — which is fine: the runtime's
// own suites (default + pixi7) resolve identically under either config. Runtime
// tests import via relative paths, so no @particlr aliases are needed here; the
// pixi7 resolution-proof does not depend on the license key, so no env either.
//
// The pixi7 project aliases `pixi.js` to the pixi7 (pixi.js@7.4.3) package via
// NODE resolution rather than a hard-coded path, so it finds the alias whether
// npm hoisted it to the monorepo root node_modules or installed it locally in
// the standalone mirror.
//
// NOTE: pixi.js@7.4.3's `exports` map only declares ".", so the "./package.json"
// subpath is NOT exported (require.resolve("pixi7/package.json") throws
// ERR_PACKAGE_PATH_NOT_EXPORTED). We therefore resolve the package's main entry
// (the "." export IS allowed) and walk up to the package root — still pure Node
// resolution, so it works from the monorepo root hoist or the mirror's local
// node_modules. The alias target is the package DIRECTORY (matching the root
// config), letting vite resolve pixi7's own exports to its ESM build.
const require = createRequire(import.meta.url);
function packageRoot(entry: string): string {
  let dir = dirname(entry);
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${entry}`);
    dir = parent;
  }
  return dir;
}
const pixi7Dir = packageRoot(require.resolve("pixi7"));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "default",
          environment: "node",
          include: ["test/**/*.test.ts"],
          // Keep vitest's built-in excludes (node_modules, dist, …) and add the
          // pixi7 suite, which the pixi7 project owns.
          exclude: [...configDefaults.exclude, "test/pixi7/**"],
        },
      },
      {
        resolve: {
          // Redirect the bare `pixi.js` specifier to the real v7 major so both
          // the tests and src/pixi7/* exercise pixi.js@7.4.3 at runtime.
          alias: { "pixi.js": pixi7Dir },
        },
        test: {
          name: "pixi7",
          environment: "node",
          include: ["test/pixi7/**/*.test.ts"],
        },
      },
    ],
  },
});
