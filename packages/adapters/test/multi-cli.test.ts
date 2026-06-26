import { describe, expect, it } from "vitest";
import { sha256OfValue } from "@weft/schema";
import type { AppliedFragment, MergeFragment } from "@weft/schema";
import {
  codexAdapter,
  cursorAdapter,
  geminiAdapter,
  getAdapter,
  opencodeAdapter,
  supportedClis,
} from "../src/index";
import type { ParsedConfig, ResolveCtx } from "../src/index";

const ctx: ResolveCtx = { home: "/home/u", projectRoot: "/proj" };

describe("registry", () => {
  it("ships all 5 CLI adapters", () => {
    expect(supportedClis().sort()).toEqual(["claude-code", "codex", "cursor", "gemini", "opencode"]);
    for (const cli of supportedClis()) expect(getAdapter(cli).id).toBe(cli);
  });
});

describe("path resolution per CLI", () => {
  it("codex: skills asymmetric, prompts global-only, agents unsupported", () => {
    expect(codexAdapter.slotRoot("skill", "global", ctx)).toBe("/home/u/.codex/skills");
    expect(codexAdapter.slotRoot("skill", "local", ctx)).toBe("/proj/.agents/skills");
    expect(codexAdapter.slotRoot("command", "global", ctx)).toBe("/home/u/.codex/prompts");
    expect(() => codexAdapter.slotRoot("command", "local", ctx)).toThrow();
    expect(() => codexAdapter.slotRoot("agent", "global", ctx)).toThrow();
    expect(codexAdapter.configFilePath("hooks", "global", ctx)).toBe("/home/u/.codex/hooks.json");
    expect(codexAdapter.configFilePath("mcpServers", "global", ctx)).toBe("/home/u/.codex/config.toml");
  });

  it("gemini: agents/skills md, commands unsupported (TOML), config in settings.json", () => {
    expect(geminiAdapter.slotRoot("agent", "global", ctx)).toBe("/home/u/.gemini/agents");
    expect(geminiAdapter.slotRoot("skill", "local", ctx)).toBe("/proj/.gemini/skills");
    expect(() => geminiAdapter.slotRoot("command", "global", ctx)).toThrow();
    expect(geminiAdapter.configFilePath("mcpServers", "global", ctx)).toBe("/home/u/.gemini/settings.json");
    expect(geminiAdapter.configFilePath("hooks", "local", ctx)).toBe("/proj/.gemini/settings.json");
  });

  it("opencode: XDG global dir, project .opencode, config at project root", () => {
    expect(opencodeAdapter.slotRoot("agent", "global", ctx)).toBe("/home/u/.config/opencode/agents");
    expect(opencodeAdapter.slotRoot("command", "local", ctx)).toBe("/proj/.opencode/commands");
    expect(opencodeAdapter.slotRoot("skill", "global", ctx)).toBe("/home/u/.config/opencode/skills");
    expect(opencodeAdapter.configFilePath("mcpServers", "global", ctx)).toBe(
      "/home/u/.config/opencode/opencode.json",
    );
    expect(opencodeAdapter.configFilePath("mcpServers", "local", ctx)).toBe("/proj/opencode.json");
    expect(() => opencodeAdapter.configFilePath("hooks", "global", ctx)).toThrow();
  });

  it("cursor: agents/skills md, mcp.json, hooks deferred", () => {
    expect(cursorAdapter.slotRoot("agent", "local", ctx)).toBe("/proj/.cursor/agents");
    expect(cursorAdapter.slotRoot("skill", "global", ctx)).toBe("/home/u/.cursor/skills");
    expect(cursorAdapter.configFilePath("mcpServers", "local", ctx)).toBe("/proj/.cursor/mcp.json");
    expect(() => cursorAdapter.configFilePath("hooks", "global", ctx)).toThrow();
  });
});

describe("mcp merge per config format", () => {
  const server = { command: "npx", args: ["-y", "@x/mcp"] };
  const mcpFrag: MergeFragment = {
    id: "m1",
    mergeInto: "mcpServers",
    op: { type: "mcpServer", name: "ctx7", value: server },
    valueSha: sha256OfValue(server),
  };
  const applied = (locator: AppliedFragment["locator"]): AppliedFragment => ({
    id: "m1",
    targetAbs: "/x",
    mergeInto: "mcpServers",
    locator,
    valueSha: mcpFrag.valueSha,
  });

  it("codex serializes mcp as a TOML [mcp_servers.*] table and round-trips", () => {
    const cfg: ParsedConfig = { path: "/x/config.toml", data: {}, existed: false, unparsable: false };
    const res = codexAdapter.mergeFragment(cfg, mcpFrag);
    expect(res.applied).toBe(true);
    const toml = codexAdapter.serializeConfig(cfg);
    expect(toml).toContain("[mcp_servers.ctx7]");
    expect(toml).toContain('command = "npx"');
    // un-merge removes exactly it
    expect(codexAdapter.unmergeFragment(cfg, applied(res.locator)).removed).toBe(true);
    expect(cfg.data).toEqual({});
  });

  it("opencode merges under the `mcp` key", () => {
    const cfg: ParsedConfig = { path: "/x/opencode.json", data: {}, existed: false, unparsable: false };
    opencodeAdapter.mergeFragment(cfg, mcpFrag);
    expect((cfg.data.mcp as Record<string, unknown>).ctx7).toEqual(server);
    expect(cfg.data.mcpServers).toBeUndefined();
  });

  it("cursor merges under the `mcpServers` key", () => {
    const cfg: ParsedConfig = { path: "/x/mcp.json", data: {}, existed: false, unparsable: false };
    cursorAdapter.mergeFragment(cfg, mcpFrag);
    expect((cfg.data.mcpServers as Record<string, unknown>).ctx7).toEqual(server);
  });
});
