import { distance } from "fastest-levenshtein";
import type { Index, IndexEntry } from "@weft/schema";

export interface SearchHit {
  entry: IndexEntry;
  score: number; // 0 = exact/substring; higher = more distant
}

/** Common CLI-name typos so `weft search cluade` still finds Claude harnesses. */
const ALIASES: Record<string, string> = {
  cluade: "claude",
  clade: "claude",
  caude: "claude",
  coddex: "codex",
  gemeni: "gemini",
  curser: "cursor",
};

const THRESHOLD = 0.34;

function tokensOf(entry: IndexEntry): string[] {
  const raw = [
    entry.id,
    ...entry.id.split(/[-_]/),
    ...entry.displayName.toLowerCase().split(/\s+/),
    ...entry.keywords,
    ...entry.clis,
  ];
  return [...new Set(raw.map((s) => s.toLowerCase()).filter(Boolean))];
}

/** Typo-tolerant search over the catalog. Returns hits sorted best-first. */
export function searchHarnesses(index: Index, queryRaw: string): SearchHit[] {
  const q0 = queryRaw.toLowerCase().trim();
  const query = ALIASES[q0] ?? q0;
  if (!query) return [];

  const hits: SearchHit[] = [];
  for (const entry of index.entries) {
    let best = 1;
    for (const token of tokensOf(entry)) {
      if (token.includes(query) || query.includes(token)) {
        best = 0;
        break;
      }
      const norm = distance(query, token) / Math.max(query.length, token.length, 1);
      if (norm < best) best = norm;
    }
    if (best <= THRESHOLD) hits.push({ entry, score: best });
  }
  hits.sort((a, b) => a.score - b.score || a.entry.id.localeCompare(b.entry.id));
  return hits;
}
