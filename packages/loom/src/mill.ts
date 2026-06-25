import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parsePattern } from "@weft/schema";
import type { CliId, Index, IndexEntry, SpoolRef } from "@weft/schema";
import { buildHarness } from "./build";
import { pathToFileURL } from "node:url";

export interface BuildMillResult {
  index: Index;
  notes: string[];
}

/**
 * Build every pattern in `<millDir>/patterns/*.yaml` into spools under `<millDir>/spools/`
 * and (re)generate `<millDir>/index.json`. Spool URLs are `file://` for local hosting.
 */
export async function buildMill(opts: {
  millDir: string;
  generatedAt: string;
}): Promise<BuildMillResult> {
  const patternsDir = join(opts.millDir, "patterns");
  const patternFiles = readdirSync(patternsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const entries: IndexEntry[] = [];
  const notes: string[] = [];

  for (const file of patternFiles) {
    const pattern = parsePattern(parseYaml(readFileSync(join(patternsDir, file), "utf8")));
    const result = await buildHarness(pattern, { outDir: opts.millDir });
    notes.push(...result.notes.map((n) => `[${pattern.id}] ${n}`));

    const spools: SpoolRef[] = result.spools.map((s) => ({
      cli: s.cli,
      scope: s.scope,
      url: pathToFileURL(s.tgzPath).href,
      spoolSha: s.spoolSha,
      spoolJsonSha: s.spoolJsonSha,
    }));

    entries.push({
      id: pattern.id,
      displayName: pattern.displayName,
      description: pattern.description,
      homepage: pattern.homepage,
      keywords: pattern.keywords ?? [],
      latest: result.version,
      clis: Object.keys(pattern.targets) as CliId[],
      versions: [{ version: result.version, spools }],
    });
  }

  const index: Index = { schema: 1, generatedAt: opts.generatedAt, entries };
  writeFileSync(join(opts.millDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return { index, notes };
}
