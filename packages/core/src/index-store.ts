import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIndex } from "@weft/schema";
import type { Index } from "@weft/schema";
import { stateDirs } from "./paths";
import type { WeftEnv } from "./paths";

function toLocalPath(source: string): string | undefined {
  if (source.startsWith("file://")) return fileURLToPath(source);
  if (source.startsWith("http://") || source.startsWith("https://")) return undefined;
  return source;
}

/** The cached catalog, or undefined if `weft update` hasn't run. */
export function loadCachedIndex(env: WeftEnv): Index | undefined {
  const path = stateDirs(env).indexCache;
  if (!existsSync(path)) return undefined;
  return parseIndex(JSON.parse(readFileSync(path, "utf8")));
}

/** Pull the catalog from the mill source into the local cache. Returns the parsed index. */
export function pullIndex(env: WeftEnv): Index {
  const localPath = toLocalPath(env.millIndexSource);
  if (localPath === undefined) {
    throw new Error(
      `weft update: remote index (${env.millIndexSource}) is not supported in this build; use a local mill (WEFT_MILL_DIR)`,
    );
  }
  if (!existsSync(localPath)) {
    throw new Error(
      `weft update: mill index not found at ${localPath}. Set WEFT_MILL_DIR to your weft-mill checkout and run its build.`,
    );
  }
  const text = readFileSync(localPath, "utf8");
  const index = parseIndex(JSON.parse(text)); // validate before caching
  const cachePath = stateDirs(env).indexCache;
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, text);
  return index;
}

/** Cached index, pulling once if absent. */
export function ensureIndex(env: WeftEnv): Index {
  return loadCachedIndex(env) ?? pullIndex(env);
}
