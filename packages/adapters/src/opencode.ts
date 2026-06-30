import { join } from "node:path";
import type { AppliedFragment, FileArtifact, MergeFragment, MergeInto, Scope, SlotKind } from "@weft/schema";
import { readJsonConfig, serializeJsonConfig } from "./json-config";
import { applyNamespace, artifactIdentity, decomposeMcpUnder, mergeMcpUnder, unmergeMcpUnder } from "./shared";
import type {
  CliAdapter,
  DecomposedConfig,
  MergeResult,
  NamespacedArtifact,
  ParsedConfig,
  ResolveCtx,
  UnmergeResult,
} from "./types";

// File-slot root: ~/.config/opencode (global) or <projectRoot>/.opencode (project).
function opencodeDir(scope: Scope, ctx: ResolveCtx): string {
  return scope === "global" ? join(ctx.home, ".config", "opencode") : join(ctx.projectRoot, ".opencode");
}

// Config file (opencode.json): global lives in the config dir; project lives at the project ROOT.
function opencodeConfig(scope: Scope, ctx: ResolveCtx): string {
  return scope === "global"
    ? join(ctx.home, ".config", "opencode", "opencode.json")
    : join(ctx.projectRoot, "opencode.json");
}

/**
 * OpenCode: agents/skills/commands are Claude-compatible markdown (it even reads `.claude/`
 * as a fallback). MCP servers live in `opencode.json` under the `mcp` key. Hooks are JS
 * plugins, not a mergeable config — that slot is unsupported.
 */
export const opencodeAdapter: CliAdapter = {
  id: "opencode",

  slotRoot(slot: SlotKind, scope: Scope, ctx: ResolveCtx): string {
    const root = opencodeDir(scope, ctx);
    switch (slot) {
      case "skill":
        return join(root, "skills");
      case "agent":
        return join(root, "agents");
      case "command":
        return join(root, "commands");
      default:
        throw new Error(`opencode: slot "${slot}" is unsupported`);
    }
  },

  configFilePath(mergeInto: MergeInto, scope: Scope, ctx: ResolveCtx): string {
    if (mergeInto === "hooks") throw new Error("opencode: hooks are JS plugins, not a mergeable config");
    if (mergeInto === "statusLine") throw new Error("opencode: statusLine is unsupported (claude-code only)");
    return opencodeConfig(scope, ctx);
  },

  payloadBase(scope: Scope, ctx: ResolveCtx): string {
    return opencodeDir(scope, ctx);
  },

  readConfig(absPath: string): ParsedConfig {
    return readJsonConfig(absPath);
  },
  serializeConfig(cfg: ParsedConfig): string {
    return serializeJsonConfig(cfg);
  },

  mergeFragment(cfg: ParsedConfig, frag: MergeFragment): MergeResult {
    if (frag.op.type !== "mcpServer") throw new Error("opencode: only mcp fragments are supported");
    return mergeMcpUnder(cfg, frag, "mcp");
  },
  unmergeFragment(cfg: ParsedConfig, applied: AppliedFragment): UnmergeResult {
    return unmergeMcpUnder(cfg, applied, "mcp");
  },
  decomposeConfig(data: Record<string, unknown>, mergeInto: MergeInto): DecomposedConfig {
    // OpenCode hooks are JS plugins, not mergeable config; only opencode.json's `mcp` map decomposes.
    return mergeInto === "mcpServers" ? decomposeMcpUnder(data, "mcp") : { ops: [], consumedKeys: [] };
  },

  artifactIdentity(art: FileArtifact): string {
    return artifactIdentity(art);
  },
  applyNamespace(art: FileArtifact, prefix: string): NamespacedArtifact {
    return applyNamespace(art, prefix);
  },
};
