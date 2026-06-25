import { sha256OfValue } from "@weft/schema";
import type { AppliedFragment, FileArtifact, MergeFragment } from "@weft/schema";
import type { MergeResult, NamespacedArtifact, ParsedConfig, UnmergeResult } from "./types";

// ───────────────────────────── JSON object helpers ─────────────────────────────

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asObject(parent[key]);
  if (existing) return existing;
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

export function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  const existing = asArray(parent[key]);
  if (existing) return existing;
  const fresh: unknown[] = [];
  parent[key] = fresh;
  return fresh;
}

function normMatcher(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ───────────────────────────── MCP servers (JSON map) ─────────────────────────────
// Used by every JSON-config CLI; only the containing key differs
// (Claude/Gemini/Cursor: "mcpServers"; OpenCode: "mcp"; Codex via TOML: "mcp_servers").

export function mergeMcpUnder(cfg: ParsedConfig, frag: MergeFragment, mapKey: string): MergeResult {
  if (frag.op.type !== "mcpServer") throw new Error("mergeMcpUnder: not an mcpServer fragment");
  const warnings: string[] = [];
  const { name } = frag.op;
  const servers = ensureObject(cfg.data, mapKey);
  const existing = servers[name];
  if (existing !== undefined) {
    if (sha256OfValue(existing) === frag.valueSha) {
      return { applied: true, locator: { kind: "mcpServer", name }, warnings };
    }
    warnings.push(`mcp server "${name}" already exists with a different config; not overwritten`);
    return { applied: false, locator: { kind: "mcpServer", name }, warnings };
  }
  servers[name] = frag.op.value;
  return { applied: true, locator: { kind: "mcpServer", name }, warnings };
}

export function unmergeMcpUnder(cfg: ParsedConfig, applied: AppliedFragment, mapKey: string): UnmergeResult {
  const warnings: string[] = [];
  if (applied.locator.kind !== "mcpServer") return { removed: false, conflict: false, warnings };
  const { name } = applied.locator;
  const servers = asObject(cfg.data[mapKey]);
  if (!servers || !(name in servers)) return { removed: false, conflict: false, warnings };
  if (sha256OfValue(servers[name]) !== applied.valueSha) {
    warnings.push(`mcp server "${name}" was modified after install; left in place`);
    return { removed: false, conflict: true, warnings };
  }
  delete servers[name];
  if (Object.keys(servers).length === 0) delete cfg.data[mapKey];
  return { removed: true, conflict: false, warnings };
}

// ───────────────────────────── Grouped hooks ─────────────────────────────
// The Claude/Codex/Gemini shape: hooks.<Event> = [ { matcher?, hooks: [ <command> ] } ].
// Provenance is per-command (a group's matcher is not unique), so we remove by value hash.

export function mergeGroupedHook(cfg: ParsedConfig, frag: MergeFragment): MergeResult {
  if (frag.op.type !== "hook") throw new Error("mergeGroupedHook: not a hook fragment");
  const warnings: string[] = [];
  const { event } = frag.op;
  const matcher = normMatcher(frag.op.matcher);
  const hooks = ensureObject(cfg.data, "hooks");
  const eventArr = ensureArray(hooks, event);

  let group: Record<string, unknown> | undefined;
  for (const candidate of eventArr) {
    const obj = asObject(candidate);
    if (obj && normMatcher(obj.matcher) === matcher && asArray(obj.hooks)) {
      group = obj;
      break;
    }
  }
  if (!group) {
    group = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
    eventArr.push(group);
  }
  const commands = ensureArray(group, "hooks");
  if (!commands.some((cmd) => sha256OfValue(cmd) === frag.valueSha)) commands.push(frag.op.command);

  return { applied: true, locator: { kind: "hook", event, matcher }, warnings };
}

export function unmergeGroupedHook(cfg: ParsedConfig, applied: AppliedFragment): UnmergeResult {
  const warnings: string[] = [];
  if (applied.locator.kind !== "hook") return { removed: false, conflict: false, warnings };
  const { event } = applied.locator;
  const matcher = normMatcher(applied.locator.matcher);
  const hooks = asObject(cfg.data.hooks);
  const eventArr = hooks ? asArray(hooks[event]) : undefined;
  if (!hooks || !eventArr) return { removed: false, conflict: false, warnings };

  let removed = false;
  for (let gi = 0; gi < eventArr.length; gi++) {
    const group = asObject(eventArr[gi]);
    if (!group || normMatcher(group.matcher) !== matcher) continue;
    const commands = asArray(group.hooks);
    if (!commands) continue;
    const idx = commands.findIndex((cmd) => sha256OfValue(cmd) === applied.valueSha);
    if (idx >= 0) {
      commands.splice(idx, 1);
      if (commands.length === 0) eventArr.splice(gi, 1);
      removed = true;
      break;
    }
  }
  if (!removed) {
    warnings.push(`hook for "${event}" not found by hash; may have been edited — left in place`);
    return { removed: false, conflict: true, warnings };
  }
  if (eventArr.length === 0) delete hooks[event];
  if (Object.keys(hooks).length === 0) delete cfg.data.hooks;
  return { removed: true, conflict: false, warnings };
}

// ───────────────────────────── identity & namespacing ─────────────────────────────
// Shared across CLIs that use Claude-style markdown for agents/skills/commands.

function rewriteFrontmatterName(content: string, newName: string): string {
  const fm = /^---\n([\s\S]*?)\n---/;
  const match = content.match(fm);
  if (!match) return content;
  const body = match[1] ?? "";
  const replaced = body.replace(/^name:.*$/m, `name: ${newName}`);
  if (replaced === body) return content.replace(fm, `---\nname: ${newName}\n${body}\n---`);
  return content.replace(fm, `---\n${replaced}\n---`);
}

const basenameOf = (rel: string): string => rel.split("/").pop() ?? rel;

export function artifactIdentity(art: FileArtifact): string {
  switch (art.slot) {
    case "agent":
      return `agent:${art.frontmatterName ?? art.logicalName}`;
    case "skill":
    case "command":
      return `slash:${art.logicalName}`;
    default:
      return `${art.slot}:${art.logicalName}`;
  }
}

export function applyNamespace(art: FileArtifact, prefix: string): NamespacedArtifact {
  const renamedFrom = art.destRel;
  const logicalName = `${prefix}-${art.logicalName}`;

  if (art.slot === "skill") {
    const parts = art.destRel.split("/");
    parts[0] = `${prefix}-${parts[0] ?? ""}`;
    return { artifact: { ...art, destRel: parts.join("/"), logicalName }, renamedFrom };
  }

  const base = basenameOf(art.destRel);
  const dir = art.destRel.slice(0, art.destRel.length - base.length);
  const destRel = `${dir}${prefix}-${base}`;

  if (art.slot === "agent") {
    const frontmatterName = `${prefix}-${art.frontmatterName ?? art.logicalName}`;
    return {
      artifact: { ...art, destRel, logicalName, frontmatterName },
      renamedFrom,
      rewriteContent: (content) => rewriteFrontmatterName(content, frontmatterName),
    };
  }
  return { artifact: { ...art, destRel, logicalName }, renamedFrom };
}
