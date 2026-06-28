import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHarness } from "@weft/loom";
import type { Index } from "@weft/schema";
import { gsdFixtureDir, gsdPattern } from "../../loom/test/fixtures/gsd-pattern";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const binAbs = join(here, "..", "bin", "weft.ts");

const cleanup: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
};
afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

let millDir: string;
beforeAll(async () => {
  millDir = tmp("weft-e2e-mill-");
  const result = await buildHarness(gsdPattern, { outDir: millDir, sourceDir: gsdFixtureDir });
  const index: Index = {
    schema: 1,
    generatedAt: "2026-06-25T00:00:00.000Z",
    entries: [
      {
        id: gsdPattern.id,
        displayName: gsdPattern.displayName,
        description: gsdPattern.description,
        keywords: gsdPattern.keywords ?? [],
        latest: result.version,
        clis: ["claude-code"],
        versions: [
          {
            version: result.version,
            spools: result.spools.map((s) => ({
              cli: s.cli,
              scope: s.scope,
              url: pathToFileURL(s.tgzPath).href,
              spoolSha: s.spoolSha,
              spoolJsonSha: s.spoolJsonSha,
            })),
          },
        ],
      },
    ],
  };
  writeFileSync(join(millDir, "index.json"), JSON.stringify(index));
});

function weft(home: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(tsxBin, [binAbs, ...args], {
      encoding: "utf8",
      env: { ...process.env, WEFT_HOME_OVERRIDE: home, WEFT_MILL_DIR: millDir },
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

describe("weft CLI e2e (subprocess)", () => {
  it("update → install → list → uninstall leaves no trace", () => {
    const home = tmp("weft-e2e-home-");
    // First pull has no cache to diff against; a second identical pull reports no changes.
    expect(weft(home, ["update"]).out).toContain("Catalog fetched");
    expect(weft(home, ["update"]).out).toContain("nothing changed");

    const ins = weft(home, ["install", "gsd-core", "--cli", "claude-code", "--scope", "global", "--yes"]);
    expect(ins.code).toBe(0);
    expect(ins.out).toContain("installed gsd-core");

    const claude = join(home, ".claude");
    expect(existsSync(join(claude, "agents", "gsd-planner.md"))).toBe(true);
    expect(existsSync(join(claude, "commands", "gsd-plan.md"))).toBe(true);
    expect(existsSync(join(claude, "gsd-core", "hooks", "gsd-guard.js"))).toBe(true);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).not.toContain("${CLAUDE_PLUGIN_ROOT}");

    const list = weft(home, ["list"]);
    expect(list.out).toContain("gsd-core");
    // the two stacked views: what's active here, then everything on the machine
    expect(list.out).toContain("THIS DIRECTORY");
    expect(list.out).toContain("EVERYWHERE");

    // catalog lists every available harness and marks this one installed
    const cat = weft(home, ["catalog"]);
    expect(cat.out).toContain("gsd-core");
    expect(cat.out).toContain("installed");

    const un = weft(home, ["uninstall", "gsd-core", "--cli", "claude-code", "--scope", "global"]);
    expect(un.out).toContain("uninstalled");
    expect(existsSync(claude)).toBe(false);
  });

  it("installs several harnesses in one command, applying one CLI+scope to all and skipping unknown ids", () => {
    const home = tmp("weft-e2e-home-");
    weft(home, ["update"]);
    // Two positional ids (one a typo) + one CLI/scope for the whole batch.
    const ins = weft(home, ["install", "gsd-core", "no-such-harness", "--cli", "claude-code", "--scope", "global", "--yes"]);
    expect(ins.code).toBe(0); // a typo'd id doesn't fail the batch when a real one installs
    expect(ins.out).toContain("installed gsd-core");
    expect(ins.out).toContain("no-such-harness"); // reported as skipped, not silently dropped
    expect(existsSync(join(home, ".claude", "agents", "gsd-planner.md"))).toBe(true);

    // uninstall is variadic too: one real id + one not-installed id, narrowed to the single install.
    const un = weft(home, ["uninstall", "gsd-core", "no-such-harness", "--cli", "claude-code", "--scope", "global", "--yes"]);
    expect(un.out).toContain("uninstalled gsd-core");
    expect(un.out).toContain("not installed anywhere"); // for no-such-harness
    expect(existsSync(join(home, ".claude"))).toBe(false); // gsd-core fully removed
  });

  it("--dry-run writes nothing", () => {
    const home = tmp("weft-e2e-home-");
    const r = weft(home, ["install", "gsd-core", "--cli", "claude-code", "--scope", "global", "--dry-run", "--yes"]);
    expect(r.out).toContain("dry run");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("search tolerates typos and uninstall of a missing harness is graceful", () => {
    const home = tmp("weft-e2e-home-");
    weft(home, ["update"]);
    expect(weft(home, ["search", "gsd-cor"]).out).toContain("gsd-core");
    expect(weft(home, ["uninstall", "gsd-core", "--cli", "claude-code", "--scope", "global"]).out).toContain(
      "not installed",
    );
  });
});
