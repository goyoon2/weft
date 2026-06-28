import { defineConfig } from "tsup";

// Bundle the CLI + all of its workspace and npm dependencies into ONE self-contained ESM file with
// a node shebang. The published package then has zero runtime deps (`@weft/*`, commander, clack, zod
// are all inlined), so `npm install -g @symploke-ai/weft` is a single fast download that just works. The
// catalog snapshot (core/snapshot/index.json) is imported as JSON and inlined here too.
export default defineConfig({
  entry: { weft: "bin/weft.ts" },
  // CJS output: the dependency graph includes CommonJS packages (commander) whose `require()` of
  // node builtins can't be shimmed inside an ESM bundle. CJS keeps native require and "just works".
  format: ["cjs"],
  target: "node22",
  platform: "node",
  bundle: true,
  noExternal: [/.*/], // inline everything; only node builtins stay external
  // No `banner` shebang: bin/weft.ts already starts with one and tsup preserves it.
  outDir: "dist",
  clean: true,
  treeshake: true,
  sourcemap: false,
  dts: false,
});
