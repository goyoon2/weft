import { describe, expect, it } from "vitest";
import { sha256OfValue } from "@weft/schema";
import type { AppliedFragment, FileArtifact, MergeFragment } from "@weft/schema";
import { claudeCodeAdapter as cc } from "../src/index";
import type { MergeResult, ParsedConfig, ResolveCtx } from "../src/index";

const ctx: ResolveCtx = { home: "/home/u", projectRoot: "/proj" };

function emptyConfig(path = "/x/settings.json"): ParsedConfig {
  return { path, data: {}, existed: false, unparsable: false };
}

function hookFrag(id: string, event: string, matcher: string | undefined, command: unknown): MergeFragment {
  return {
    id,
    target: "settings.json",
    mergeInto: "hooks",
    op: { type: "hook", event, matcher, command },
    valueSha: sha256OfValue(command),
  };
}

function mcpFrag(id: string, name: string, value: unknown): MergeFragment {
  return {
    id,
    target: "mcp.json",
    mergeInto: "mcpServers",
    op: { type: "mcpServer", name, value },
    valueSha: sha256OfValue(value),
  };
}

function applied(frag: MergeFragment, res: MergeResult): AppliedFragment {
  return {
    id: frag.id,
    targetAbs: "/x/settings.json",
    mergeInto: frag.mergeInto,
    locator: res.locator,
    valueSha: frag.valueSha,
  };
}

describe("path resolution", () => {
  it("resolves slot roots, config files and payload base per scope", () => {
    expect(cc.slotRoot("agent", "global", ctx)).toBe("/home/u/.claude/agents");
    expect(cc.slotRoot("skill", "local", ctx)).toBe("/proj/.claude/skills");
    expect(cc.slotRoot("command", "global", ctx)).toBe("/home/u/.claude/commands");

    expect(cc.configFilePath("hooks", "global", ctx)).toBe("/home/u/.claude/settings.json");
    expect(cc.configFilePath("hooks", "local", ctx)).toBe("/proj/.claude/settings.json");
    expect(cc.configFilePath("mcpServers", "global", ctx)).toBe("/home/u/.claude.json");
    expect(cc.configFilePath("mcpServers", "local", ctx)).toBe("/proj/.mcp.json");

    expect(cc.payloadBase("global", ctx)).toBe("/home/u/.claude");
    expect(cc.payloadBase("local", ctx)).toBe("/proj/.claude");
  });

  it("throws for non-file slots", () => {
    expect(() => cc.slotRoot("hook", "global", ctx)).toThrow();
    expect(() => cc.slotRoot("payload", "global", ctx)).toThrow();
  });
});

describe("hooks merge/un-merge", () => {
  const cmdA = { type: "command", command: 'node "/p/gsd-a.js"', timeout: 5 };
  const cmdB = { type: "command", command: 'node "/p/gsd-b.js"' };

  it("merges multiple commands and round-trips back to empty on full un-merge", () => {
    const cfg = emptyConfig();
    const f1 = hookFrag("h1", "PreToolUse", "Write|Edit", cmdA);
    const f2 = hookFrag("h2", "PreToolUse", "Write|Edit", cmdB);
    const f3 = hookFrag("h3", "PostToolUse", undefined, cmdA);
    const r1 = cc.mergeFragment(cfg, f1);
    const r2 = cc.mergeFragment(cfg, f2);
    const r3 = cc.mergeFragment(cfg, f3);

    const hooks = cfg.data.hooks as Record<string, unknown[]>;
    // both PreToolUse commands collapse into one matcher group; PostToolUse has no matcher
    expect(hooks.PreToolUse).toHaveLength(1);
    expect((hooks.PreToolUse?.[0] as { hooks: unknown[] }).hooks).toHaveLength(2);
    expect((hooks.PostToolUse?.[0] as { matcher?: string }).matcher).toBeUndefined();
    // serializes as strict JSON
    expect(() => JSON.parse(cc.serializeConfig(cfg))).not.toThrow();

    cc.unmergeFragment(cfg, applied(f1, r1));
    cc.unmergeFragment(cfg, applied(f2, r2));
    cc.unmergeFragment(cfg, applied(f3, r3));
    expect(cfg.data).toEqual({}); // hooks key pruned entirely
  });

  it("preserves a pre-existing user group on un-merge", () => {
    const userCmd = { type: "command", command: "echo user" };
    const cfg: ParsedConfig = {
      path: "/x/settings.json",
      existed: true,
      unparsable: false,
      data: { hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [userCmd] }] } },
    };
    const f1 = hookFrag("h1", "PreToolUse", "Write|Edit", cmdA);
    const r1 = cc.mergeFragment(cfg, f1);

    const group = (cfg.data.hooks as { PreToolUse: { hooks: unknown[] }[] }).PreToolUse[0]!;
    expect(group.hooks).toHaveLength(2); // appended into the user's group

    const res = cc.unmergeFragment(cfg, applied(f1, r1));
    expect(res.removed).toBe(true);
    // user's command + group remain intact
    expect(cfg.data).toEqual({
      hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [userCmd] }] },
    });
  });

  it("does not duplicate when the same command is merged twice", () => {
    const cfg = emptyConfig();
    const f = hookFrag("h", "PreToolUse", "Write", cmdA);
    cc.mergeFragment(cfg, f);
    cc.mergeFragment(cfg, f);
    const group = (cfg.data.hooks as { PreToolUse: { hooks: unknown[] }[] }).PreToolUse[0]!;
    expect(group.hooks).toHaveLength(1);
  });

  it("flags a conflict (and leaves the value) when a hook was hand-edited", () => {
    const cfg = emptyConfig();
    const f = hookFrag("h", "PreToolUse", "Write", cmdA);
    const r = cc.mergeFragment(cfg, f);
    // user edits our command in place
    (cfg.data.hooks as { PreToolUse: { hooks: { command: string }[] }[] }).PreToolUse[0]!.hooks[0]!.command =
      "node /p/HACKED.js";
    const res = cc.unmergeFragment(cfg, applied(f, r));
    expect(res.removed).toBe(false);
    expect(res.conflict).toBe(true);
    // the edited command is left untouched
    expect((cfg.data.hooks as { PreToolUse: { hooks: unknown[] }[] }).PreToolUse[0]!.hooks).toHaveLength(1);
  });

  it("hash is order-independent, so reordered command keys still un-merge", () => {
    const cfg = emptyConfig();
    const f = hookFrag("h", "PreToolUse", "Write", { type: "command", command: "x", timeout: 1 });
    const r = cc.mergeFragment(cfg, f);
    // simulate a re-serialized file with different key order
    (cfg.data.hooks as { PreToolUse: { hooks: unknown[] }[] }).PreToolUse[0]!.hooks[0] = {
      timeout: 1,
      command: "x",
      type: "command",
    };
    expect(cc.unmergeFragment(cfg, applied(f, r)).removed).toBe(true);
  });
});

describe("mcpServers merge/un-merge", () => {
  const server = { command: "npx", args: ["-y", "@x/mcp"] };

  it("adds, is idempotent, and round-trips to empty", () => {
    const cfg = emptyConfig("/x/.mcp.json");
    const f = mcpFrag("m1", "ctx7", server);
    const r1 = cc.mergeFragment(cfg, f);
    expect(r1.applied).toBe(true);
    expect((cfg.data.mcpServers as Record<string, unknown>).ctx7).toEqual(server);

    expect(cc.mergeFragment(cfg, f).applied).toBe(true); // idempotent, no dup
    expect(Object.keys(cfg.data.mcpServers as object)).toHaveLength(1);

    cc.unmergeFragment(cfg, applied(f, r1));
    expect(cfg.data).toEqual({}); // mcpServers key pruned
  });

  it("refuses to overwrite a foreign server of the same name", () => {
    const cfg: ParsedConfig = {
      path: "/x/.mcp.json",
      existed: true,
      unparsable: false,
      data: { mcpServers: { ctx7: { command: "other" } } },
    };
    const res = cc.mergeFragment(cfg, mcpFrag("m1", "ctx7", server));
    expect(res.applied).toBe(false);
    expect(res.warnings[0]).toMatch(/already exists/);
    expect((cfg.data.mcpServers as Record<string, unknown>).ctx7).toEqual({ command: "other" });
  });
});

describe("identity & namespacing", () => {
  const agent: FileArtifact = {
    slot: "agent",
    destRel: "reviewer.md",
    archivePath: "files/agents/reviewer.md",
    sha: sha256OfValue("x"),
    logicalName: "reviewer",
    frontmatterName: "reviewer",
  };

  it("skill and command share a slash namespace; agent is separate", () => {
    const skill: FileArtifact = { ...agent, slot: "skill", destRel: "reviewer/SKILL.md" };
    const command: FileArtifact = { ...agent, slot: "command", destRel: "reviewer.md", frontmatterName: undefined };
    expect(cc.artifactIdentity(skill)).toBe("slash:reviewer");
    expect(cc.artifactIdentity(command)).toBe("slash:reviewer");
    expect(cc.artifactIdentity(agent)).toBe("agent:reviewer");
  });

  it("namespaces an agent by renaming the file and rewriting frontmatter name", () => {
    const ns = cc.applyNamespace(agent, "gsd");
    expect(ns.artifact.destRel).toBe("gsd-reviewer.md");
    expect(ns.artifact.frontmatterName).toBe("gsd-reviewer");
    expect(ns.renamedFrom).toBe("reviewer.md");
    const rewritten = ns.rewriteContent?.("---\nname: reviewer\ndescription: x\n---\nbody");
    expect(rewritten).toContain("name: gsd-reviewer");
    expect(rewritten).toContain("description: x");
  });

  it("namespaces a skill by renaming its directory", () => {
    const skill: FileArtifact = { ...agent, slot: "skill", destRel: "reviewer/SKILL.md" };
    const ns = cc.applyNamespace(skill, "gsd");
    expect(ns.artifact.destRel).toBe("gsd-reviewer/SKILL.md");
    expect(ns.rewriteContent).toBeUndefined();
  });
});
