import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { getAdapter, isCliSupported, supportedClis } from "@weft/adapters";
import type { CliId, IndexEntry, Receipt, Scope, SpoolRef } from "@weft/schema";
import { ensureIndex, loadCachedIndex, pullIndex } from "./index-store";
import type { Index } from "@weft/schema";
import { fetchSpool } from "./spool-fetch";
import { buildPlan } from "./plan";
import type { ExecutionPlan } from "./plan";
import { installDelegated, installPlan, uninstallReceipt, upgradeApply, upgradeDelegated } from "./apply";
import { findReceipts, isInstalled, readAllReceipts } from "./receipts";
import { resolveCtx, scopeKeyFor, stateDirs } from "./paths";
import type { WeftEnv } from "./paths";
import { searchHarnesses } from "./search";
import type { SearchHit } from "./search";

/**
 * What weft is about to run on the user's machine for a `delegated` (cask) install/uninstall. The CLI
 * turns this into the consent prompt (`--trust` bypasses it; otherwise an interactive y/N).
 */
export interface DelegateConsentInfo {
  action: "install" | "uninstall";
  harness: string;
  cli: CliId;
  scope: Scope;
  /** The exact, fully-resolved command weft will execute. */
  cmd: string;
  /** The install dir on the user's machine. */
  dir: string;
  /** Executables the command needs on PATH. */
  requires: string[];
  summary?: string;
}

/** Caller-supplied gate for running an upstream installer. Returns `true` to proceed. */
export type DelegateConsent = (info: DelegateConsentInfo) => Promise<boolean>;

export type InstallResult =
  | { status: "installed"; receipt: Receipt; warnings: string[] }
  | { status: "already-installed"; cli: CliId; scope: Scope }
  | { status: "planned"; plan: ExecutionPlan }
  | { status: "declined"; reason: string };

export type UninstallResult =
  | { status: "uninstalled"; receipt: Receipt; warnings: string[]; conflicts: string[] }
  | { status: "not-installed"; elsewhere: Receipt[] }
  | { status: "ambiguous"; candidates: Receipt[] }
  | { status: "declined"; reason: string };

export type UpgradeResult =
  | { status: "upgraded"; from: string; to: string; receipt: Receipt; warnings: string[]; conflicts: string[] }
  | { status: "up-to-date"; version: string }
  | { status: "not-installed"; elsewhere: Receipt[] }
  | { status: "ambiguous"; candidates: Receipt[] };

/** The fate of one install when upgrading across every location. */
export type UpgradeOutcome =
  | { status: "upgraded"; from: string; to: string; receipt: Receipt; warnings: string[]; conflicts: string[] }
  | { status: "up-to-date"; version: string; receipt: Receipt }
  | { status: "skipped"; reason: string; receipt: Receipt };

export interface UpgradeAllResult {
  /** One outcome per matched install, across all projects (empty if the harness isn't installed). */
  outcomes: UpgradeOutcome[];
}

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
    const available = ver.spools.map((s) => `${s.cli}/${s.scope}`).join(", ") || "(none)";
    throw new Error(`weft: ${entry.id}@${v} has no spool for ${cli}/${scope} — available: ${available}`);
  }
  return ref;
}

/** CLIs the harness declares AND weft has an adapter for. */
function installableClis(entry: IndexEntry): CliId[] {
  return entry.clis.filter((c) => isCliSupported(c));
}

/**
 * The `(cli, scope)` combos that ACTUALLY have a built spool at the entry's latest version (and that
 * weft has an adapter for). A harness need not build every scope — a `delegated` global-only tool
 * (e.g. gstack) ships no `local` spool — so install offers/prompts must be derived from this, not from
 * a hardcoded global×local grid.
 */
function availableTargets(entry: IndexEntry): { cli: CliId; scope: Scope }[] {
  const ver = entry.versions.find((v) => v.version === entry.latest);
  if (!ver) return [];
  return ver.spools.filter((s) => isCliSupported(s.cli)).map((s) => ({ cli: s.cli, scope: s.scope }));
}

/** A harness that appeared in, or disappeared from, the catalog — id, name, and its latest version. */
export interface CatalogEntryRef {
  id: string;
  displayName: string;
  version: string;
  clis: CliId[];
}

/** A harness whose latest version moved between two catalog pulls. */
export interface CatalogVersionChange {
  id: string;
  displayName: string;
  from: string;
  to: string;
}

/** What changed between the previously cached catalog and the one `weft update` just pulled. */
export interface CatalogDiff {
  /** No catalog was cached before — the first `weft update` (everything is implicitly "new"). */
  firstRun: boolean;
  /** Total harnesses in the freshly pulled catalog. */
  total: number;
  /** Harnesses new to the catalog, sorted by id. */
  added: CatalogEntryRef[];
  /** Harnesses whose latest version moved, sorted by id. */
  updated: CatalogVersionChange[];
  /** Harnesses that disappeared from the catalog, sorted by id. */
  removed: CatalogEntryRef[];
  /** Harnesses present in both pulls with an unchanged latest version. */
  unchanged: number;
}

const refOf = (e: IndexEntry): CatalogEntryRef => ({
  id: e.id,
  displayName: e.displayName,
  version: e.latest,
  clis: e.clis,
});

/** Compare the catalog as it was (cached) with the one just pulled, keyed by harness id + latest version. */
function diffCatalog(before: Index | undefined, after: Index): CatalogDiff {
  const total = after.entries.length;
  if (!before) return { firstRun: true, total, added: [], updated: [], removed: [], unchanged: 0 };

  const prevById = new Map(before.entries.map((e) => [e.id, e]));
  const nextIds = new Set(after.entries.map((e) => e.id));
  const added: CatalogEntryRef[] = [];
  const updated: CatalogVersionChange[] = [];
  let unchanged = 0;
  for (const e of after.entries) {
    const prev = prevById.get(e.id);
    if (!prev) added.push(refOf(e));
    else if (prev.latest !== e.latest) {
      updated.push({ id: e.id, displayName: e.displayName, from: prev.latest, to: e.latest });
    } else unchanged++;
  }
  const removed = before.entries.filter((e) => !nextIds.has(e.id)).map(refOf);

  const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);
  added.sort(byId);
  updated.sort(byId);
  removed.sort(byId);
  return { firstRun: false, total, added, updated, removed, unchanged };
}

/**
 * Pull the catalog from the mill and report what changed since the last pull. The cached catalog is
 * read BEFORE pulling (the pull overwrites it), then diffed against the fresh one. A missing or
 * unreadable cache is treated as a first run rather than failing the update.
 */
export async function updateIndex(env: WeftEnv): Promise<{ entries: number; diff: CatalogDiff }> {
  let before: Index | undefined;
  try {
    before = loadCachedIndex(env);
  } catch {
    before = undefined; // a corrupt cache must not block an update — pull fresh and treat as first run
  }
  const after = await pullIndex(env);
  return { entries: after.entries.length, diff: diffCatalog(before, after) };
}

export interface CatalogItem {
  entry: IndexEntry;
  /** Every install of this harness across all projects + global (empty if not installed anywhere). */
  installs: Receipt[];
}

/** Every harness available in the catalog (the mill index), sorted by id, with install state. */
export function listCatalog(env: WeftEnv): CatalogItem[] {
  const receipts = readAllReceipts(env);
  return ensureIndex(env)
    .entries.map((entry) => ({ entry, installs: receipts.filter((r) => r.harness === entry.id) }))
    .sort((a, b) => a.entry.id.localeCompare(b.entry.id));
}

export function installMatrix(env: WeftEnv, harness: string): CellState[] {
  const entry = getEntry(env, harness);
  const ctx = resolveCtx(env);
  return availableTargets(entry).map(({ cli, scope }) => ({
    cli,
    scope,
    installed: isInstalled(env, harness, cli, scopeKeyFor(scope, ctx)),
  }));
}

export async function installHarness(
  env: WeftEnv,
  opts: {
    harness: string;
    cli: CliId;
    scope: Scope;
    version?: string;
    dryRun?: boolean;
    /** Consent gate for `delegated` (cask) installs that run an upstream installer on this machine. */
    onDelegate?: DelegateConsent;
  },
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
  try {
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

    // Delegated (cask): weft runs the upstream installer on this machine — gate on explicit consent.
    if (plan.delegate) {
      const granted = opts.onDelegate
        ? await opts.onDelegate({
            action: "install",
            harness,
            cli,
            scope,
            cmd: plan.delegate.installCmd,
            dir: plan.delegate.dir,
            requires: plan.delegate.requires,
            summary: plan.delegate.summary,
          })
        : false;
      if (!granted) {
        return { status: "declined", reason: "running the upstream installer was not approved" };
      }
      const result = await installDelegated(env, plan);
      return { status: "installed", receipt: result.receipt, warnings: result.warnings };
    }

    const result = await installPlan(env, adapter, plan);
    return { status: "installed", receipt: result.receipt, warnings: result.warnings };
  } finally {
    // The extracted spool tree was consumed by buildPlan/installPlan; don't leak it in the cache.
    rmSync(fetched.dir, { recursive: true, force: true });
  }
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
  opts: { harness: string; cli?: CliId; scope?: Scope; onDelegate?: DelegateConsent },
): Promise<UninstallResult> {
  const { matches, all } = matchReceipts(env, opts.harness, opts.cli, opts.scope);
  if (matches.length === 0) return { status: "not-installed", elsewhere: all };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches };
  const receipt = matches[0]!;

  // Delegated (cask): removal runs the tool's own uninstaller — gate on consent, like install.
  if (receipt.delegation) {
    const granted = opts.onDelegate
      ? await opts.onDelegate({
          action: "uninstall",
          harness: receipt.harness,
          cli: receipt.cli,
          scope: receipt.scope,
          cmd: receipt.delegation.uninstallCmd,
          dir: receipt.delegation.dir,
          requires: [],
        })
      : false;
    if (!granted) {
      return { status: "declined", reason: "running the upstream uninstaller was not approved" };
    }
  }

  const res = await uninstallReceipt(env, getAdapter(receipt.cli), receipt);
  return { status: "uninstalled", receipt, warnings: res.warnings, conflicts: res.conflicts };
}

/**
 * Path context for a receipt. A LOCAL install resolves against ITS OWN project dir (the receipt's
 * `projectPath`), not the current cwd — so an install in another folder upgrades in place rather
 * than being rewritten under wherever `weft` happens to run.
 */
function ctxForReceipt(env: WeftEnv, receipt: Receipt): ReturnType<typeof resolveCtx> {
  if (receipt.scope === "local" && receipt.projectPath) {
    return { home: env.home, projectRoot: receipt.projectPath };
  }
  return resolveCtx(env);
}

/** Upgrade one already-installed receipt to the catalog's latest, in its own location. */
async function upgradeOneReceipt(
  env: WeftEnv,
  oldReceipt: Receipt,
  onDelegate?: DelegateConsent,
): Promise<UpgradeOutcome> {
  const entry = getEntry(env, oldReceipt.harness);
  if (entry.latest === oldReceipt.version) {
    return { status: "up-to-date", version: entry.latest, receipt: oldReceipt };
  }
  // Don't recreate the install tree of a local project whose folder is gone.
  if (oldReceipt.scope === "local" && oldReceipt.projectPath && !existsSync(oldReceipt.projectPath)) {
    return { status: "skipped", reason: "project folder no longer exists", receipt: oldReceipt };
  }

  const ref = resolveSpoolRef(entry, oldReceipt.cli, oldReceipt.scope);
  const fetched = await fetchSpool(ref, stateDirs(env).spools);
  try {
    const adapter = getAdapter(oldReceipt.cli);
    const newPlan = await buildPlan({
      env,
      ctx: ctxForReceipt(env, oldReceipt),
      scope: oldReceipt.scope,
      scopeKey: oldReceipt.scopeKey,
      projectPath: oldReceipt.projectPath,
      adapter,
      spool: fetched.spool,
      spoolSha: ref.spoolSha,
      fetchedDir: fetched.dir,
      receiptId: randomUUID(),
    });

    // Delegated (cask): upgrade re-runs the upstream tool's installer — gate on consent, like install.
    if (newPlan.delegate) {
      const granted = onDelegate
        ? await onDelegate({
            action: "install",
            harness: oldReceipt.harness,
            cli: oldReceipt.cli,
            scope: oldReceipt.scope,
            cmd: newPlan.delegate.upgradeCmd ?? newPlan.delegate.installCmd,
            dir: newPlan.delegate.dir,
            requires: newPlan.delegate.requires,
            summary: newPlan.delegate.summary,
          })
        : false;
      if (!granted) {
        return { status: "skipped", reason: "upgrade runs the upstream installer; not approved (pass --trust)", receipt: oldReceipt };
      }
      const result = await upgradeDelegated(env, oldReceipt, newPlan);
      return {
        status: "upgraded",
        from: oldReceipt.version,
        to: newPlan.version,
        receipt: result.receipt,
        warnings: result.warnings,
        conflicts: result.conflicts,
      };
    }

    const result = await upgradeApply(env, adapter, oldReceipt, newPlan);
    return {
      status: "upgraded",
      from: oldReceipt.version,
      to: newPlan.version,
      receipt: result.receipt,
      warnings: result.warnings,
      conflicts: result.conflicts,
    };
  } finally {
    rmSync(fetched.dir, { recursive: true, force: true });
  }
}

export async function upgradeHarness(
  env: WeftEnv,
  opts: { harness: string; cli?: CliId; scope?: Scope; onDelegate?: DelegateConsent },
): Promise<UpgradeResult> {
  const { matches, all } = matchReceipts(env, opts.harness, opts.cli, opts.scope);
  if (matches.length === 0) return { status: "not-installed", elsewhere: all };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches };

  const outcome = await upgradeOneReceipt(env, matches[0]!, opts.onDelegate);
  if (outcome.status === "up-to-date") return { status: "up-to-date", version: outcome.version };
  if (outcome.status === "skipped") return { status: "not-installed", elsewhere: all };
  return {
    status: "upgraded",
    from: outcome.from,
    to: outcome.to,
    receipt: outcome.receipt,
    warnings: outcome.warnings,
    conflicts: outcome.conflicts,
  };
}

/**
 * Upgrade EVERY install of a harness, across all projects (and global), not just the current cwd.
 * `--cli`/`--scope` narrow the set. Each install is upgraded in its own location; one failing or
 * missing folder is isolated to its own `skipped` outcome and never blocks the others.
 */
export async function upgradeAll(
  env: WeftEnv,
  opts: { harness: string; cli?: CliId; scope?: Scope; onDelegate?: DelegateConsent },
): Promise<UpgradeAllResult> {
  let receipts = findReceipts(env, { harness: opts.harness, cli: opts.cli });
  if (opts.scope) receipts = receipts.filter((r) => r.scope === opts.scope);
  receipts.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      (a.projectPath ?? "").localeCompare(b.projectPath ?? "") ||
      a.cli.localeCompare(b.cli),
  );

  const outcomes: UpgradeOutcome[] = [];
  for (const r of receipts) {
    try {
      outcomes.push(await upgradeOneReceipt(env, r, opts.onDelegate));
    } catch (err) {
      outcomes.push({ status: "skipped", reason: (err as Error).message, receipt: r });
    }
  }
  return { outcomes };
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
