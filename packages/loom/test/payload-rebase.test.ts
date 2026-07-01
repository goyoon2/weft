import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePattern } from "@weft/schema";
import type { HarnessPattern, Spool } from "@weft/schema";
import { buildHarness } from "../src/index";

// `rebase` strips a leading source-path prefix from each payload entry's stored rel, so a payload can
// be rooted at a sub-path of the source — the unlock for runtimes that resolve siblings via
// `__dirname/../<x>` and therefore need a specific on-disk layout (e.g. caveman's hooks/ + skills/).

function globalSpool(spools: { scope: string; spool: Spool }[]): Spool {
  const s = spools.find((x) => x.scope === "global");
  if (!s) throw new Error("no global spool");
  return s.spool;
}

function makeSrc(): string {
  const src = mkdtempSync(join(tmpdir(), "weft-rebase-src-"));
  mkdirSync(join(src, "src", "hooks"), { recursive: true });
  mkdirSync(join(src, "skills", "x"), { recursive: true });
  writeFileSync(join(src, "src", "hooks", "activate.js"), "console.log(1)\n");
  writeFileSync(join(src, "src", "hooks", "config.js"), "module.exports={}\n");
  writeFileSync(join(src, "skills", "x", "SKILL.md"), "---\nname: x\n---\nX\n");
  return src;
}

describe("loom payload rebase", () => {
  it("strips the rebase prefix from stored entry rels (src/hooks → hooks), leaving non-rebased rules intact", async () => {
    const pattern: HarnessPattern = parsePattern({
      schema: 1,
      id: "rb",
      displayName: "RB",
      description: "",
      source: { type: "git", url: "https://example.com/rb" },
      versioning: { strategy: "semver", track: "latest" },
      targets: {
        "claude-code": {
          strategy: "declarative",
          map: [
            { kind: "payload", from: "src/hooks/**", as: "payload:rb", rebase: "src" },
            { kind: "payload", from: "skills/x/**", as: "payload:rb" },
          ],
        },
      },
    });
    const out = mkdtempSync(join(tmpdir(), "weft-rebase-out-"));
    const result = await buildHarness(pattern, { outDir: out, sourceDir: makeSrc(), version: "1.0.0" });
    const spool = globalSpool(result.spools);
    expect(spool.payloads).toHaveLength(1);
    const rels = spool.payloads[0]!.entries.map((e) => e.rel).sort();
    // `src/` stripped from the hooks rule; the skills rule (no rebase) keeps its path → the two land
    // as siblings under the payload root, which is exactly what a `__dirname/../skills` runtime needs.
    expect(rels).toEqual(["hooks/activate.js", "hooks/config.js", "skills/x/SKILL.md"]);
  });
});
