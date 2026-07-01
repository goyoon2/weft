import { join } from "node:path";
import type { AppliedFragment, FileArtifact, MergeFragment, MergeInto, Scope, SlotKind } from "@weft/schema";
import { readJsonConfig, serializeJsonConfig } from "./json-config";
import {
  applyNamespace,
  artifactIdentity,
  decomposeGroupedHooks,
  decomposeMcpUnder,
  decomposeStatusLine,
  mergeGroupedHook,
  mergeMcpUnder,
  mergeStatusLine,
  unmergeGroupedHook,
  unmergeMcpUnder,
  unmergeStatusLine,
} from "./shared";
import type {
  CliAdapter,
  DecomposedConfig,
  MergeResult,
  NamespacedArtifact,
  ParsedConfig,
  ResolveCtx,
  UnmergeResult,
} from "./types";

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
    // hooks AND statusLine both live in settings.json.
    if (mergeInto === "hooks" || mergeInto === "statusLine") return join(claudeRoot(scope, ctx), "settings.json");
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
    if (frag.op.type === "mcpServer") return mergeMcpUnder(cfg, frag, "mcpServers");
    if (frag.op.type === "statusLine") return mergeStatusLine(cfg, frag, "statusLine");
    return mergeGroupedHook(cfg, frag);
  },
  unmergeFragment(cfg: ParsedConfig, applied: AppliedFragment): UnmergeResult {
    if (applied.locator.kind === "mcpServer") return unmergeMcpUnder(cfg, applied, "mcpServers");
    if (applied.locator.kind === "statusLine") return unmergeStatusLine(cfg, applied, "statusLine");
    return unmergeGroupedHook(cfg, applied);
  },
  decomposeConfig(data: Record<string, unknown>, mergeInto: MergeInto): DecomposedConfig {
    if (mergeInto === "hooks") return decomposeGroupedHooks(data);
    if (mergeInto === "statusLine") return decomposeStatusLine(data, "statusLine");
    return decomposeMcpUnder(data, "mcpServers");
  },

  artifactIdentity(art: FileArtifact): string {
    return artifactIdentity(art);
  },
  applyNamespace(art: FileArtifact, prefix: string): NamespacedArtifact {
    return applyNamespace(art, prefix);
  },
};
