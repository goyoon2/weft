import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { absolutizeIndexSpools, absolutizeIndexSpoolsAgainstUrl, parseIndex } from "@weft/schema";
import type { Index } from "@weft/schema";
import { ghHeaders } from "./http";
import { stateDirs } from "./paths";
import type { WeftEnv } from "./paths";

function isHttp(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

function toLocalPath(source: string): string | undefined {
  if (source.startsWith("file://")) return fileURLToPath(source);
  if (isHttp(source)) return undefined;
  return source;
}

function cacheIndex(env: WeftEnv, index: Index): Index {
  const cachePath = stateDirs(env).indexCache;
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

/** The cached catalog, or undefined if `weft update` hasn't run. */
export function loadCachedIndex(env: WeftEnv): Index | undefined {
  const path = stateDirs(env).indexCache;
  if (!existsSync(path)) return undefined;
  return parseIndex(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Read a LOCAL committed catalog (a path or `file://`) into the cache. The catalog stores spool urls
 * RELATIVE to the mill dir (portable across machines); we resolve them to absolute `file://` against
 * this checkout and cache that, so later reads need no knowledge of the mill location.
 */
function pullIndexLocal(env: WeftEnv): Index {
  const localPath = toLocalPath(env.millIndexSource);
  if (localPath === undefined) throw new Error("weft: pullIndexLocal called on a non-local source");
  if (!existsSync(localPath)) {
    throw new Error(
      `weft update: mill index not found at ${localPath}. Set WEFT_MILL_DIR to your weft-mill checkout and run its build.`,
    );
  }
  const index = absolutizeIndexSpools(parseIndex(JSON.parse(readFileSync(localPath, "utf8"))), dirname(localPath));
  return cacheIndex(env, index);
}

/**
 * Fetch a HOSTED catalog over HTTP into the cache. Spool urls (relative in the committed index) are
 * resolved against the index's own url, so they download from alongside it (e.g. the same repo via
 * raw.githubusercontent.com). Integrity is still enforced per-spool by `fetchSpool` (sha256).
 */
async function pullIndexRemote(env: WeftEnv): Promise<Index> {
  const url = env.millIndexSource;
  const res = await fetch(url, { headers: ghHeaders(url) });
  if (!res.ok) {
    throw new Error(`weft update: GET ${url} → ${res.status} ${res.statusText}`);
  }
  const index = absolutizeIndexSpoolsAgainstUrl(parseIndex(await res.json()), url);
  return cacheIndex(env, index);
}

/** Pull the catalog from the mill source into the local cache (network for `http(s)` sources). */
export async function pullIndex(env: WeftEnv): Promise<Index> {
  return isHttp(env.millIndexSource) ? pullIndexRemote(env) : pullIndexLocal(env);
}

/**
 * The cached index. A LOCAL source is pulled on demand (cheap file read); a REMOTE source must be
 * fetched first via `weft update` — read paths stay synchronous and never block on the network.
 */
export function ensureIndex(env: WeftEnv): Index {
  const cached = loadCachedIndex(env);
  if (cached) return cached;
  if (isHttp(env.millIndexSource)) {
    throw new Error("weft: no catalog cached yet — run `weft update` first.");
  }
  return pullIndexLocal(env);
}
