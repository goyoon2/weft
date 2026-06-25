import { join } from "node:path";
import type { AppliedFragment, FileArtifact, MergeFragment, MergeInto, Scope, SlotKind } from "@weft/schema";
import { readJsonConfig, serializeJsonConfig } from "./json-config";
import {
  applyNamespace,
  artifactIdentity,
  mergeGroupedHook,
  mergeMcpUnder,
  unmergeGroupedHook,
  unmergeMcpUnder,
} from "./shared";
import type { CliAdapter, MergeResult, NamespacedArtifact, ParsedConfig, ResolveCtx, UnmergeResult } from "./types";

function claudeRoot(scope: Scope, ctx: ResolveCtx): string {
  return scope === "global" ? join(ctx.home, ".claude") : join(ctx.projectRoot, ".claude");
}

export const claudeCodeAdapter: CliAdapter = {
  id: "claude-code",

  slotRoot(slot: SlotKind, scope: Scope, ctx: ResolveCtx): string {
    const root = claudeRoot(scope, ctx);
    switch (slot) {
      case "skill":
        return join(root, "skills");
      case "agent":
        return join(root, "agents");
      case "command":
        return join(root, "commands");
      default:
        throw new Error(`claude-code: slot "${slot}" is not an independent-file slot`);
    }
  },

  configFilePath(mergeInto: MergeInto, scope: Scope, ctx: ResolveCtx): string {
    if (mergeInto === "hooks") return join(claudeRoot(scope, ctx), "settings.json");
    // mcpServers: global → ~/.claude.json (top-level); local → <projectRoot>/.mcp.json
    return scope === "global" ? join(ctx.home, ".claude.json") : join(ctx.projectRoot, ".mcp.json");
  },

  payloadBase(scope: Scope, ctx: ResolveCtx): string {
    return claudeRoot(scope, ctx);
  },

  readConfig(absPath: string): ParsedConfig {
    return readJsonConfig(absPath);
  },
  serializeConfig(cfg: ParsedConfig): string {
    return serializeJsonConfig(cfg);
  },

  mergeFragment(cfg: ParsedConfig, frag: MergeFragment): MergeResult {
    return frag.op.type === "mcpServer" ? mergeMcpUnder(cfg, frag, "mcpServers") : mergeGroupedHook(cfg, frag);
  },
  unmergeFragment(cfg: ParsedConfig, applied: AppliedFragment): UnmergeResult {
    return applied.locator.kind === "mcpServer"
      ? unmergeMcpUnder(cfg, applied, "mcpServers")
      : unmergeGroupedHook(cfg, applied);
  },

  artifactIdentity(art: FileArtifact): string {
    return artifactIdentity(art);
  },
  applyNamespace(art: FileArtifact, prefix: string): NamespacedArtifact {
    return applyNamespace(art, prefix);
  },
};
