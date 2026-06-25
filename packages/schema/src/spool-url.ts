import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Index, IndexEntry, SpoolRef } from "./types";

// A spool `url` is portable across machines in the committed mill catalog by being stored RELATIVE
// to the mill dir (e.g. `spools/gsd-core/1.6.0/claude-code.global.spool.tgz`), then resolved back to
// an absolute `file://` against the local mill on load. These two functions are inverses; keeping
// them together guarantees they stay in sync. Hosted (`http(s)://`) urls pass through untouched.

/** True if `s` carries a URL scheme like `file://` or `https://` — i.e. it is already absolute. */
function hasScheme(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
}

/**
 * Make a spool `url` portable for committing to the mill repo: a path RELATIVE to `millDir` with
 * forward slashes. A `file://` url is converted; an already-relative path or a hosted `http(s)://`
 * url is returned unchanged.
 */
export function relativizeSpoolUrl(url: string, millDir: string): string {
  if (url.startsWith("file://")) {
    return relative(millDir, fileURLToPath(url)).split(sep).join("/");
  }
  return url; // already relative, or hosted — nothing local to relativize
}

/**
 * Inverse of {@link relativizeSpoolUrl}: resolve a committed relative spool path back to an absolute
 * `file://` url against the local `millDir`. Already-absolute urls (`file://`, `http(s)://`) pass
 * through untouched, so this is safe to run over any index — relative or legacy-absolute.
 */
export function absolutizeSpoolUrl(url: string, millDir: string): string {
  if (hasScheme(url)) return url;
  return pathToFileURL(resolve(millDir, url)).href;
}

function mapEntrySpools(entry: IndexEntry, fn: (url: string) => string): IndexEntry {
  return {
    ...entry,
    versions: entry.versions.map((v) => ({
      ...v,
      spools: v.spools.map((s): SpoolRef => ({ ...s, url: fn(s.url) })),
    })),
  };
}

/** Relativize every spool url in one entry (for committing `entry.json` / `index.json`). */
export function relativizeEntrySpools(entry: IndexEntry, millDir: string): IndexEntry {
  return mapEntrySpools(entry, (u) => relativizeSpoolUrl(u, millDir));
}

/** Absolutize every spool url in an index against `millDir` (for loading a committed catalog). */
export function absolutizeIndexSpools(index: Index, millDir: string): Index {
  return { ...index, entries: index.entries.map((e) => mapEntrySpools(e, (u) => absolutizeSpoolUrl(u, millDir))) };
}

/**
 * Absolutize a relative spool url against the INDEX's own url — the hosted (http(s)) analogue of
 * {@link absolutizeSpoolUrl}. A committed catalog stores spool urls relative to index.json, so
 * `spools/x.tgz` next to `https://host/path/index.json` resolves to `https://host/path/spools/x.tgz`.
 * Already-absolute urls pass through untouched.
 */
export function absolutizeSpoolUrlAgainstIndex(url: string, indexUrl: string): string {
  return hasScheme(url) ? url : new URL(url, indexUrl).href;
}

/** Absolutize every spool url in an index against the index's own (hosted) url. */
export function absolutizeIndexSpoolsAgainstUrl(index: Index, indexUrl: string): Index {
  return {
    ...index,
    entries: index.entries.map((e) => mapEntrySpools(e, (u) => absolutizeSpoolUrlAgainstIndex(u, indexUrl))),
  };
}
