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

function geminiRoot(scope: Scope, ctx: ResolveCtx): string {
  return scope === "global" ? join(ctx.home, ".gemini") : join(ctx.projectRoot, ".gemini");
}

/**
 * Gemini CLI: agents/skills are Claude-style markdown; MCP and hooks both live in
 * `settings.json` (mcp under `mcpServers`, hooks in the Claude-shaped `hooks` map).
 * Custom commands are TOML (incompatible with Claude markdown) — that slot is unsupported.
 */
export const geminiAdapter: CliAdapter = {
  id: "gemini",

  slotRoot(slot: SlotKind, scope: Scope, ctx: ResolveCtx): string {
    const root = geminiRoot(scope, ctx);
    switch (slot) {
      case "skill":
        return join(root, "skills");
      case "agent":
        return join(root, "agents");
      case "command":
        throw new Error("gemini: custom commands are TOML, not markdown — slot unsupported");
      default:
        throw new Error(`gemini: slot "${slot}" is unsupported`);
    }
  },

  configFilePath(_mergeInto: MergeInto, scope: Scope, ctx: ResolveCtx): string {
    // Both hooks and mcpServers live in settings.json.
    return join(geminiRoot(scope, ctx), "settings.json");
  },

  payloadBase(scope: Scope, ctx: ResolveCtx): string {
    return geminiRoot(scope, ctx);
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
