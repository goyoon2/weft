import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract as tarExtract } from "tar";
import { parseSpool, sha256OfBytes, sha256OfFile } from "@weft/schema";
import type { Spool, SpoolRef } from "@weft/schema";

export interface FetchedSpool {
  spool: Spool;
  /** Extraction root containing `spool.json`, `files/`, and `payloads/`. */
  dir: string;
}

function toLocalPath(url: string): string | undefined {
  if (url.startsWith("file://")) return fileURLToPath(url);
  if (url.startsWith("http://") || url.startsWith("https://")) return undefined;
  return url;
}

/**
 * Download (here: resolve a local `file://`), integrity-check, and extract a spool.
 * Verifies the archive hash and the embedded spool.json hash against the index ref.
 */
export async function fetchSpool(ref: SpoolRef, cacheDir: string): Promise<FetchedSpool> {
  const srcPath = toLocalPath(ref.url);
  if (srcPath === undefined) {
    throw new Error(`weft: remote spools are not supported in this build (${ref.url})`);
  }
  if (!existsSync(srcPath)) {
    throw new Error(`weft: spool archive not found at ${srcPath}`);
  }

  const archiveSha = await sha256OfFile(srcPath);
  if (archiveSha !== ref.spoolSha) {
    throw new Error(`weft: spool hash mismatch for ${ref.url}\n  expected ${ref.spoolSha}\n  got      ${archiveSha}`);
  }

  mkdirSync(cacheDir, { recursive: true });
  const dir = mkdtempSync(join(cacheDir, "spool-"));
  await tarExtract({ file: srcPath, cwd: dir });

  const spoolJsonPath = join(dir, "spool.json");
  if (!existsSync(spoolJsonPath)) {
    throw new Error(`weft: spool archive ${ref.url} is missing spool.json`);
  }
  const raw = readFileSync(spoolJsonPath);
  if (sha256OfBytes(raw) !== ref.spoolJsonSha) {
    throw new Error(`weft: spool.json hash mismatch for ${ref.url}`);
  }
  return { spool: parseSpool(JSON.parse(raw.toString("utf8"))), dir };
}
