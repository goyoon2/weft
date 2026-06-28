import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { AppliedFragment, FileArtifact, MergeFragment, MergeInto, Scope, SlotKind } from "@weft/schema";
import { readJsonConfig, serializeJsonConfig } from "./json-config";
import {
  applyNamespace,
  artifactIdentity,
  decomposeGroupedHooks,
  decomposeMcpUnder,
  mergeGroupedHook,
  mergeMcpUnder,
  unmergeGroupedHook,
  unmergeMcpUnder,
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

function codexRoot(scope: Scope, ctx: ResolveCtx): string {
  return scope === "global" ? join(ctx.home, ".codex") : join(ctx.projectRoot, ".codex");
}

/** A `#` comment outside string literals. smol-toml drops these on reserialize (it isn't
 *  comment-preserving), so weft flags the file lossy and warns before normalizing the user's config.toml. */
function tomlHasComments(text: string): boolean {
  return text.split("\n").some((line) => {
    const stripped = line.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
    return stripped.includes("#");
  });
}

function readTomlConfig(absPath: string): ParsedConfig {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: absPath, data: {}, existed: false, unparsable: false };
    }
    throw err;
  }
  try {
    return {
      path: absPath,
      data: parseToml(text) as Record<string, unknown>,
      existed: true,
      unparsable: false,
      lossyReserialize: tomlHasComments(text),
    };
  } catch {
    return { path: absPath, data: {}, existed: true, unparsable: true };
  }
}

/**
 * Codex stores hooks in `hooks.json` (JSON, Claude-shaped) but MCP servers in `config.toml`
 * under `[mcp_servers.<name>]`. Read/serialize dispatch on the file's extension; the merge
 * logic operates on the parsed object either way.
 */
export const codexAdapter: CliAdapter = {
  id: "codex",

  slotRoot(slot: SlotKind, scope: Scope, ctx: ResolveCtx): string {
    switch (slot) {
      case "skill":
        // Codex reads project skills from `.agents/skills`, global from `~/.codex/skills`.
        return scope === "global" ? join(ctx.home, ".codex", "skills") : join(ctx.projectRoot, ".agents", "skills");
      case "command":
        if (scope !== "global") throw new Error("codex: project-scope prompts are unsupported");
        return join(ctx.home, ".codex", "prompts");
      default:
        throw new Error(`codex: slot "${slot}" is unsupported`);
    }
  },

  configFilePath(mergeInto: MergeInto, scope: Scope, ctx: ResolveCtx): string {
    return mergeInto === "hooks"
      ? join(codexRoot(scope, ctx), "hooks.json")
      : join(codexRoot(scope, ctx), "config.toml");
  },

  payloadBase(scope: Scope, ctx: ResolveCtx): string {
    return codexRoot(scope, ctx);
  },

  readConfig(absPath: string): ParsedConfig {
    return absPath.endsWith(".toml") ? readTomlConfig(absPath) : readJsonConfig(absPath);
  },
  serializeConfig(cfg: ParsedConfig): string {
    return cfg.path.endsWith(".toml") ? `${stringifyToml(cfg.data)}\n` : serializeJsonConfig(cfg);
  },

  mergeFragment(cfg: ParsedConfig, frag: MergeFragment): MergeResult {
    return frag.op.type === "mcpServer" ? mergeMcpUnder(cfg, frag, "mcp_servers") : mergeGroupedHook(cfg, frag);
  },
  unmergeFragment(cfg: ParsedConfig, applied: AppliedFragment): UnmergeResult {
    return applied.locator.kind === "mcpServer"
      ? unmergeMcpUnder(cfg, applied, "mcp_servers")
      : unmergeGroupedHook(cfg, applied);
  },
  decomposeConfig(data: Record<string, unknown>, mergeInto: MergeInto): DecomposedConfig {
    return mergeInto === "hooks" ? decomposeGroupedHooks(data) : decomposeMcpUnder(data, "mcp_servers");
  },

  artifactIdentity(art: FileArtifact): string {
    return artifactIdentity(art);
  },
  applyNamespace(art: FileArtifact, prefix: string): NamespacedArtifact {
    return applyNamespace(art, prefix);
  },
};
