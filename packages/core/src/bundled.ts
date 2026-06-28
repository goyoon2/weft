import { parseIndex } from "@weft/schema";
import type { Index } from "@weft/schema";
// The catalog snapshot shipped in the npm package. Imported (not read from disk) so the bundler
// inlines it into the single-file build — a fresh `npm install -g @goyoon/weft` then shows
// `weft catalog` instantly and offline, before any `weft update`. Refreshed at publish time by
// scripts/refresh-snapshot.mjs. Spool urls stay RELATIVE here; callers absolutize them against the
// live mill index url.
import snapshot from "../snapshot/index.json" with { type: "json" };

/** The bundled catalog snapshot, or `undefined` if it is absent/empty. */
export function bundledIndexSnapshot(): Index | undefined {
  const entries = (snapshot as { entries?: unknown[] }).entries;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  return parseIndex(snapshot);
}
