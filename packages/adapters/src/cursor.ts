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

function cursorRoot(scope: Scope, ctx: ResolveCtx): string {
  return scope === "global" ? join(ctx.home, ".cursor") : join(ctx.projectRoot, ".cursor");
}

/**
 * Cursor: agents/skills are Claude-style markdown (it reads `.claude/agents` etc. as a
 * fallback). MCP servers live in `mcp.json` under `mcpServers`. Custom commands are
 * project-only; hooks use a different flat shape — both deferred (slots throw).
 */
export const cursorAdapter: CliAdapter = {
  id: "cursor",

  slotRoot(slot: SlotKind, scope: Scope, ctx: ResolveCtx): string {
    const root = cursorRoot(scope, ctx);
    switch (slot) {
      case "skill":
        return join(root, "skills");
      case "agent":
        return join(root, "agents");
      case "command":
        if (scope !== "global") return join(root, "commands");
        throw new Error("cursor: global commands are UI-managed, not droppable");
      default:
        throw new Error(`cursor: slot "${slot}" is unsupported`);
    }
  },

  configFilePath(mergeInto: MergeInto, scope: Scope, ctx: ResolveCtx): string {
    if (mergeInto === "hooks") throw new Error("cursor: hooks (flat shape) not implemented in this build");
    if (mergeInto === "statusLine") throw new Error("cursor: statusLine is unsupported (claude-code only)");
    return join(cursorRoot(scope, ctx), "mcp.json");
  },

  payloadBase(scope: Scope, ctx: ResolveCtx): string {
    return cursorRoot(scope, ctx);
  },

  readConfig(absPath: string): ParsedConfig {
    return readJsonConfig(absPath);
  },
  serializeConfig(cfg: ParsedConfig): string {
    return serializeJsonConfig(cfg);
  },

  mergeFragment(cfg: ParsedConfig, frag: MergeFragment): MergeResult {
    if (frag.op.type !== "mcpServer") throw new Error("cursor: only mcp fragments are supported in this build");
    return mergeMcpUnder(cfg, frag, "mcpServers");
  },
  unmergeFragment(cfg: ParsedConfig, applied: AppliedFragment): UnmergeResult {
    return unmergeMcpUnder(cfg, applied, "mcpServers");
  },
  decomposeConfig(data: Record<string, unknown>, mergeInto: MergeInto): DecomposedConfig {
    // Cursor hooks use a different flat shape weft doesn't merge; only mcp.json decomposes.
    return mergeInto === "mcpServers" ? decomposeMcpUnder(data, "mcpServers") : { ops: [], consumedKeys: [] };
  },

  artifactIdentity(art: FileArtifact): string {
    return artifactIdentity(art);
  },
  applyNamespace(art: FileArtifact, prefix: string): NamespacedArtifact {
    return applyNamespace(art, prefix);
  },
};
