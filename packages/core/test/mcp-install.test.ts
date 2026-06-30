import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildHarness } from "@weft/loom";
import type { BuiltSpool } from "@weft/loom";
import { parsePattern } from "@weft/schema";
import type { HarnessPattern, Index, IndexVersion } from "@weft/schema";
import { installHarness, listInstalled, uninstallHarness } from "../src/index";
import type { WeftEnv } from "../src/index";

// End-to-end for Type G: a loom-BUILT inline mcp-server spool installed through the public ops API
// (not a hand-built fragment), then uninstalled — proving the new build branch wires through to the
// existing mcpServers merge + reversal. The merge/unmerge primitives themselves are covered in
// config-merge.test.ts; this asserts the whole pipeline (loom → plan → apply → uninstall).

const cleanup: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), p));
  cleanup.push(d);
  return d;
}
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

const SERVER = { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] };

const pattern = parsePattern({
  schema: 1,
  id: "chrome-devtools-mcp",
  displayName: "Chrome DevTools MCP",
  description: "Register the Chrome DevTools MCP server.",
  source: { type: "git", url: "https://github.com/ChromeDevTools/chrome-devtools-mcp" },
  versioning: { strategy: "semver", track: "latest" },
  targets: {
    "claude-code": {
      strategy: "declarative",
      map: [{ kind: "mcp-server", as: "mcpServer:chrome-devtools", server: SERVER }],
    },
  },
}) as HarnessPattern;

function versionRef(spools: BuiltSpool[], version: string): IndexVersion {
  return {
    version,
    spools: spools.map((s) => ({
      cli: s.cli,
      scope: s.scope,
      url: pathToFileURL(s.tgzPath).href,
      spoolSha: s.spoolSha,
      spoolJsonSha: s.spoolJsonSha,
    })),
  };
}
function makeEnv(home: string, cwd: string, indexSource: string): WeftEnv {
  return { home, weftDir: join(home, ".weft"), cwd, millIndexSource: indexSource, weftVersion: "test" };
}
async function makeMill(): Promise<string> {
  const mill = tmp("weft-mill-mcp-");
  const result = await buildHarness(pattern, { outDir: mill, sourceDir: tmp("weft-src-mcp-"), version: "1.0.0" });
  const index: Index = {
    schema: 1,
    entries: [
      {
        id: pattern.id,
        displayName: pattern.displayName,
        description: pattern.description,
        keywords: [],
        latest: "1.0.0",
        clis: ["claude-code"],
        versions: [versionRef(result.spools, "1.0.0")],
      },
    ],
  };
  const path = join(mill, "index.json");
  writeFileSync(path, JSON.stringify(index, null, 2));
  return pathToFileURL(path).href;
}

describe("Type G: mcp-server install/uninstall through ops (claude-code global → ~/.claude.json)", () => {
  it("registers alongside a user's own servers and fully reverses to the original file", async () => {
    const indexSource = await makeMill();
    const home = tmp("weft-home-mcp-");
    const env = makeEnv(home, tmp("weft-cwd-mcp-"), indexSource);

    // The user already has their own MCP server + unrelated keys in ~/.claude.json.
    const claudeJson = join(home, ".claude.json");
    const original = { mcpServers: { mine: { command: "node", args: ["my-server.js"] } }, numUserKey: 42 };
    writeFileSync(claudeJson, `${JSON.stringify(original, null, 2)}\n`);
    const before = readFileSync(claudeJson, "utf8");

    const res = await installHarness(env, { harness: "chrome-devtools-mcp", cli: "claude-code", scope: "global" });
    expect(res.status).toBe("installed");

    const after = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(after.mcpServers["chrome-devtools"]).toEqual(SERVER); // weft's server registered
    expect(after.mcpServers.mine).toEqual(original.mcpServers.mine); // user's untouched
    expect(after.numUserKey).toBe(42); // unrelated key untouched

    const un = await uninstallHarness(env, { harness: "chrome-devtools-mcp", cli: "claude-code", scope: "global" });
    expect(un.status).toBe("uninstalled");
    expect(readFileSync(claudeJson, "utf8")).toBe(before); // byte-identical reversal
    expect(listInstalled(env)).toHaveLength(0);
  });

  it("round-trips to no file when weft was the only owner", async () => {
    const indexSource = await makeMill();
    const home = tmp("weft-home-mcp2-");
    const env = makeEnv(home, tmp("weft-cwd-mcp2-"), indexSource);
    const claudeJson = join(home, ".claude.json");

    await installHarness(env, { harness: "chrome-devtools-mcp", cli: "claude-code", scope: "global" });
    expect(JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers["chrome-devtools"]).toEqual(SERVER);

    await uninstallHarness(env, { harness: "chrome-devtools-mcp", cli: "claude-code", scope: "global" });
    expect(existsSync(claudeJson)).toBe(false); // sole owner → file removed
  });
});
