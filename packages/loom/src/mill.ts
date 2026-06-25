import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { parsePattern } from "@weft/schema";
import type { CliId, HarnessPattern, Index, IndexEntry, SpoolRef } from "@weft/schema";
import { buildHarness } from "./build";

export interface BuildMillResult {
  index: Index;
  notes: string[];
}

export interface BuildEntryResult {
  entry: IndexEntry;
  notes: string[];
}

/** List the pattern files (basenames) in `<millDir>/patterns/`, sorted. */
export function listPatternFiles(millDir: string): string[] {
  return readdirSync(join(millDir, "patterns"))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

/** Parse one pattern file into a validated `HarnessPattern`. */
export function parsePatternFile(absPath: string): HarnessPattern {
  return parsePattern(parseYaml(readFileSync(absPath, "utf8")));
}

/**
 * Build ONE pattern into spools under `<outDir>/spools/<id>/` and return its index entry. This is
 * the unit of work shared by the all-at-once `buildMill` and the per-pattern (parallel/incremental)
 * mill build orchestrator — so a single pattern can be (re)built in isolation without touching the
 * others' spools or the global index.
 */
export async function buildIndexEntry(pattern: HarnessPattern, opts: { outDir: string }): Promise<BuildEntryResult> {
  const result = await buildHarness(pattern, { outDir: opts.outDir });
  const notes = result.notes.map((n) => `[${pattern.id}] ${n}`);

  const spools: SpoolRef[] = result.spools.map((s) => ({
    cli: s.cli,
    scope: s.scope,
    url: pathToFileURL(s.tgzPath).href,
    spoolSha: s.spoolSha,
    spoolJsonSha: s.spoolJsonSha,
  }));

  const entry: IndexEntry = {
    id: pattern.id,
    displayName: pattern.displayName,
    description: pattern.description,
    homepage: pattern.homepage,
    keywords: pattern.keywords ?? [],
    latest: result.version,
    clis: Object.keys(pattern.targets) as CliId[],
    versions: [{ version: result.version, spools }],
  };

  return { entry, notes };
}

/**
 * Build every pattern in `<millDir>/patterns/*.yaml` into spools under `<millDir>/spools/`
 * and (re)generate `<millDir>/index.json`. Spool URLs are `file://` for local hosting.
 */
export async function buildMill(opts: { millDir: string; generatedAt: string }): Promise<BuildMillResult> {
  const entries: IndexEntry[] = [];
  const notes: string[] = [];

  for (const file of listPatternFiles(opts.millDir)) {
    const pattern = parsePatternFile(join(opts.millDir, "patterns", file));
    const { entry, notes: n } = await buildIndexEntry(pattern, { outDir: opts.millDir });
    entries.push(entry);
    notes.push(...n);
  }

  const index: Index = { schema: 1, generatedAt: opts.generatedAt, entries };
  writeFileSync(join(opts.millDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return { index, notes };
}
