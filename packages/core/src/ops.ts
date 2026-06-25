import { randomUUID } from "node:crypto";
import { getAdapter, isCliSupported, supportedClis } from "@weft/adapters";
import type { CliId, IndexEntry, Receipt, Scope, SpoolRef } from "@weft/schema";
import { ensureIndex, pullIndex } from "./index-store";
import { fetchSpool } from "./spool-fetch";
import { buildPlan } from "./plan";
import type { ExecutionPlan } from "./plan";
import { installPlan, uninstallReceipt, upgradeApply } from "./apply";
import { findReceipts, isInstalled, readAllReceipts } from "./receipts";
import { resolveCtx, scopeKeyFor, stateDirs } from "./paths";
import type { WeftEnv } from "./paths";
import { searchHarnesses } from "./search";
import type { SearchHit } from "./search";

export type InstallResult =
  | { status: "installed"; receipt: Receipt; warnings: string[] }
  | { status: "already-installed"; cli: CliId; scope: Scope }
  | { status: "planned"; plan: ExecutionPlan };

export type UninstallResult =
  | { status: "uninstalled"; receipt: Receipt; warnings: string[]; conflicts: string[] }
  | { status: "not-installed"; elsewhere: Receipt[] }
  | { status: "ambiguous"; candidates: Receipt[] };

export type UpgradeResult =
  | { status: "upgraded"; from: string; to: string; receipt: Receipt; warnings: string[]; conflicts: string[] }
  | { status: "up-to-date"; version: string }
  | { status: "not-installed"; elsewhere: Receipt[] }
  | { status: "ambiguous"; candidates: Receipt[] };

export interface CellState {
  cli: CliId;
  scope: Scope;
  installed: boolean;
}

function getEntry(env: WeftEnv, harness: string): IndexEntry {
  const entry = ensureIndex(env).entries.find((e) => e.id === harness);
  if (!entry) throw new Error(`weft: no harness "${harness}" in the index (try \`weft search\`)`);
  return entry;
}

function resolveSpoolRef(entry: IndexEntry, cli: CliId, scope: Scope, version?: string): SpoolRef {
  const v = version ?? entry.latest;
  const ver = entry.versions.find((x) => x.version === v);
  if (!ver) throw new Error(`weft: ${entry.id} has no version ${v}`);
  const ref = ver.spools.find((s) => s.cli === cli && s.scope === scope);
  if (!ref) {
    throw new Error(
      `weft: ${entry.id}@${v} has no spool for ${cli}/${scope} (supported CLIs: ${entry.clis.join(", ")})`,
    );
  }
  return ref;
}

/** CLIs the harness declares AND weft has an adapter for. */
function installableClis(entry: IndexEntry): CliId[] {
  return entry.clis.filter((c) => isCliSupported(c));
}

export function updateIndex(env: WeftEnv): { entries: number } {
  return { entries: pullIndex(env).entries.length };
}

export function installMatrix(env: WeftEnv, harness: string): CellState[] {
  const entry = getEntry(env, harness);
  const ctx = resolveCtx(env);
  const cells: CellState[] = [];
  for (const cli of installableClis(entry)) {
    for (const scope of ["global", "local"] as Scope[]) {
      cells.push({ cli, scope, installed: isInstalled(env, harness, cli, scopeKeyFor(scope, ctx)) });
    }
  }
  return cells;
}

export async function installHarness(
  env: WeftEnv,
  opts: { harness: string; cli: CliId; scope: Scope; version?: string; dryRun?: boolean },
): Promise<InstallResult> {
  const { harness, cli, scope } = opts;
  const entry = getEntry(env, harness);
  const adapter = getAdapter(cli);
  const ctx = resolveCtx(env);
  const scopeKey = scopeKeyFor(scope, ctx);

  if (isInstalled(env, harness, cli, scopeKey)) {
    return { status: "already-installed", cli, scope };
  }

  const ref = resolveSpoolRef(entry, cli, scope, opts.version);
  const fetched = await fetchSpool(ref, stateDirs(env).spools);
  const plan = await buildPlan({
    env,
    ctx,
    scope,
    scopeKey,
    projectPath: scope === "local" ? ctx.projectRoot : undefined,
    adapter,
    spool: fetched.spool,
    spoolSha: ref.spoolSha,
    fetchedDir: fetched.dir,
    receiptId: randomUUID(),
  });

  if (opts.dryRun) return { status: "planned", plan };

  const result = await installPlan(env, adapter, plan);
  return { status: "installed", receipt: result.receipt, warnings: result.warnings };
}

function matchReceipts(
  env: WeftEnv,
  harness: string,
  cli?: CliId,
  scope?: Scope,
): { matches: Receipt[]; all: Receipt[] } {
  const all = findReceipts(env, { harness, cli });
  const localKey = scopeKeyFor("local", resolveCtx(env));
  let matches = all.filter((r) => r.scope === "global" || r.scopeKey === localKey);
  if (scope) matches = matches.filter((r) => r.scope === scope);
  return { matches, all };
}

export async function uninstallHarness(
  env: WeftEnv,
  opts: { harness: string; cli?: CliId; scope?: Scope },
): Promise<UninstallResult> {
  const { matches, all } = matchReceipts(env, opts.harness, opts.cli, opts.scope);
  if (matches.length === 0) return { status: "not-installed", elsewhere: all };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches };
  const receipt = matches[0]!;
  const res = await uninstallReceipt(env, getAdapter(receipt.cli), receipt);
  return { status: "uninstalled", receipt, warnings: res.warnings, conflicts: res.conflicts };
}

export async function upgradeHarness(
  env: WeftEnv,
  opts: { harness: string; cli?: CliId; scope?: Scope },
): Promise<UpgradeResult> {
  const { matches, all } = matchReceipts(env, opts.harness, opts.cli, opts.scope);
  if (matches.length === 0) return { status: "not-installed", elsewhere: all };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches };

  const oldReceipt = matches[0]!;
  const entry = getEntry(env, opts.harness);
  if (entry.latest === oldReceipt.version) return { status: "up-to-date", version: entry.latest };

  const ref = resolveSpoolRef(entry, oldReceipt.cli, oldReceipt.scope);
  const fetched = await fetchSpool(ref, stateDirs(env).spools);
  const adapter = getAdapter(oldReceipt.cli);
  const ctx = resolveCtx(env);
  const newPlan = await buildPlan({
    env,
    ctx,
    scope: oldReceipt.scope,
    scopeKey: oldReceipt.scopeKey,
    projectPath: oldReceipt.projectPath,
    adapter,
    spool: fetched.spool,
    spoolSha: ref.spoolSha,
    fetchedDir: fetched.dir,
    receiptId: randomUUID(),
  });
  const result = await upgradeApply(env, adapter, oldReceipt, newPlan);
  return {
    status: "upgraded",
    from: oldReceipt.version,
    to: newPlan.version,
    receipt: result.receipt,
    warnings: result.warnings,
    conflicts: result.conflicts,
  };
}

export function listInstalled(env: WeftEnv, opts: { all?: boolean } = {}): Receipt[] {
  const receipts = readAllReceipts(env);
  const localKey = scopeKeyFor("local", resolveCtx(env));
  const filtered = opts.all
    ? receipts
    : receipts.filter((r) => r.scope === "global" || r.scopeKey === localKey);
  return filtered.sort(
    (a, b) => a.harness.localeCompare(b.harness) || a.cli.localeCompare(b.cli) || a.scope.localeCompare(b.scope),
  );
}

export function infoHarness(env: WeftEnv, harness: string): { entry: IndexEntry; installed: Receipt[] } {
  return { entry: getEntry(env, harness), installed: findReceipts(env, { harness }) };
}

export function searchOp(env: WeftEnv, query: string): SearchHit[] {
  return searchHarnesses(ensureIndex(env), query);
}

export { supportedClis };
