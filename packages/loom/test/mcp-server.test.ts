import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePattern, sha256OfValue } from "@weft/schema";
import type { HarnessPattern, Spool } from "@weft/schema";
import { buildHarness } from "../src/index";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-src");

function globalSpool(spools: { scope: string; spool: Spool }[]): Spool {
  const s = spools.find((x) => x.scope === "global");
  if (!s) throw new Error("no global spool");
  return s.spool;
}

const CHROME_VALUE = { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] };

// An inline mcp-server rule registers a server launched by a published command, with no upstream
// config file — the canonical npx/uvx case (chrome-devtools-mcp, serena). The value is folded
// verbatim under mcpServers; the name comes from `as: "mcpServer:<name>"`.
describe("loom mcp-server slot — inline registration", () => {
  const pattern: HarnessPattern = parsePattern({
    schema: 1,
    id: "chrome-devtools-mcp",
    displayName: "Chrome DevTools MCP",
    description: "Register the Chrome DevTools MCP server.",
    source: { type: "git", url: "https://github.com/ChromeDevTools/chrome-devtools-mcp" },
    versioning: { strategy: "semver", track: "latest" },
    targets: {
      "claude-code": {
        strategy: "declarative",
        map: [{ kind: "mcp-server", as: "mcpServer:chrome-devtools", server: CHROME_VALUE }],
      },
      opencode: {
        strategy: "declarative",
        map: [
          {
            kind: "mcp-server",
            as: "mcpServer:chrome-devtools",
            // OpenCode's own shape: a launch array under `command`, plus `type`/`enabled`.
            server: { type: "local", command: ["npx", "-y", "chrome-devtools-mcp@latest"], enabled: true },
          },
        ],
      },
    },
  });

  it("emits one mcpServers fragment, name from `as`, value verbatim, no files", async () => {
    const out = mkdtempSync(join(tmpdir(), "weft-mcp-test-"));
    const result = await buildHarness(pattern, { outDir: out, sourceDir: fixtureDir, version: "1.0.0" });
    const spool = globalSpool(result.spools.filter((s) => s.cli === "claude-code"));
    expect(spool.files).toHaveLength(0);
    expect(spool.payloads).toHaveLength(0);
    expect(spool.fragments).toHaveLength(1);
    const frag = spool.fragments[0]!;
    expect(frag.mergeInto).toBe("mcpServers");
    expect(frag.op).toEqual({ type: "mcpServer", name: "chrome-devtools", value: CHROME_VALUE });
    expect(frag.valueSha).toBe(sha256OfValue(CHROME_VALUE));
  });

  it("keeps each CLI target's own server value shape (opencode launch array)", async () => {
    const out = mkdtempSync(join(tmpdir(), "weft-mcp-test-"));
    const result = await buildHarness(pattern, { outDir: out, sourceDir: fixtureDir, version: "1.0.0" });
    const spool = globalSpool(result.spools.filter((s) => s.cli === "opencode"));
    const frag = spool.fragments[0]!;
    expect(frag.op).toEqual({
      type: "mcpServer",
      name: "chrome-devtools",
      value: { type: "local", command: ["npx", "-y", "chrome-devtools-mcp@latest"], enabled: true },
    });
  });

  it("registers the fragment in both scopes", async () => {
    const out = mkdtempSync(join(tmpdir(), "weft-mcp-test-"));
    const result = await buildHarness(pattern, { outDir: out, sourceDir: fixtureDir, version: "1.0.0" });
    const claude = result.spools.filter((s) => s.cli === "claude-code");
    expect(claude.map((s) => s.scope).sort()).toEqual(["global", "local"]);
    for (const s of claude) expect(s.spool.fragments).toHaveLength(1);
  });
});

// A file-based mcp-server rule reads an upstream's shipped config and decomposes every server in it
// into an individually-mergeable fragment (the same shape the captured path produces).
describe("loom mcp-server slot — file-based decompose", () => {
  const pattern: HarnessPattern = parsePattern({
    schema: 1,
    id: "stitch-skills",
    displayName: "Stitch",
    description: "Register MCP servers from a shipped .mcp.json.",
    source: { type: "git", url: "https://github.com/google-labs-code/stitch-skills" },
    versioning: { strategy: "semver", track: "latest" },
    targets: {
      "claude-code": {
        strategy: "declarative",
        map: [{ kind: "mcp-server", from: ".mcp.json", as: "mcpServer:ignored-for-file" }],
      },
    },
  });

  it("decomposes every server in the file into its own fragment, named by its file key", async () => {
    const out = mkdtempSync(join(tmpdir(), "weft-mcp-test-"));
    const result = await buildHarness(pattern, { outDir: out, sourceDir: fixtureDir, version: "1.0.0" });
    const spool = globalSpool(result.spools);
    const names = spool.fragments
      .map((f) => (f.op.type === "mcpServer" ? f.op.name : ""))
      .sort();
    expect(names).toEqual(["stitch", "weather"]);
    const stitch = spool.fragments.find((f) => f.op.type === "mcpServer" && f.op.name === "stitch")!;
    expect(stitch.op).toEqual({
      type: "mcpServer",
      name: "stitch",
      value: { command: "npx", args: ["-y", "@google-labs/stitch-mcp@latest"] },
    });
  });
});

// Validator guards on the inline/file shape.
describe("mcp-server rule validation", () => {
  const base = {
    schema: 1,
    id: "x",
    displayName: "X",
    description: "",
    source: { type: "git", url: "https://example.com/x" },
    versioning: { strategy: "semver" },
  };
  const wrap = (rule: unknown) => ({
    ...base,
    targets: { "claude-code": { strategy: "declarative", map: [rule] } },
  });

  it("rejects an mcp-server rule with neither `server` nor `from`", () => {
    expect(() => parsePattern(wrap({ kind: "mcp-server", as: "mcpServer:a" }))).toThrow();
  });
  it("rejects an mcp-server rule with both `server` and `from`", () => {
    expect(() =>
      parsePattern(wrap({ kind: "mcp-server", as: "mcpServer:a", from: ".mcp.json", server: { command: "x" } })),
    ).toThrow();
  });
  it("rejects an inline mcp-server rule whose `as` carries no name", () => {
    expect(() => parsePattern(wrap({ kind: "mcp-server", as: "mcpServer:", server: { command: "x" } }))).toThrow();
  });
  it("rejects a non-mcp slot rule with no `from`", () => {
    expect(() => parsePattern(wrap({ kind: "agent", as: "agent:a" }))).toThrow();
  });
});
