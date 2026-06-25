import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract as tarExtract } from "tar";
import { parseSpool, sha256OfBytes, sha256OfFile } from "@weft/schema";
import type { Spool, SpoolRef } from "@weft/schema";
import { ghHeaders } from "./http";

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

/** Resolve a spool ref to a local `.tgz` path: a `file://`/local path as-is, or download an http one. */
async function resolveArchivePath(ref: SpoolRef, cacheDir: string): Promise<string> {
  const local = toLocalPath(ref.url);
  if (local !== undefined) {
    if (!existsSync(local)) throw new Error(`weft: spool archive not found at ${local}`);
    return local;
  }
  // Hosted spool: download to a temp file, then the same hash-verify + extract path runs over it.
  const res = await fetch(ref.url, { headers: ghHeaders(ref.url) });
  if (!res.ok) throw new Error(`weft: GET ${ref.url} → ${res.status} ${res.statusText}`);
  mkdirSync(cacheDir, { recursive: true });
  const dl = join(mkdtempSync(join(cacheDir, "dl-")), "spool.tgz");
  writeFileSync(dl, Buffer.from(await res.arrayBuffer()));
  return dl;
}

/**
 * Resolve (download for http, or read a local `file://`), integrity-check, and extract a spool.
 * Verifies the archive hash and the embedded spool.json hash against the index ref.
 */
export async function fetchSpool(ref: SpoolRef, cacheDir: string): Promise<FetchedSpool> {
  const srcPath = await resolveArchivePath(ref, cacheDir);

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
