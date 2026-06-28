import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256OfBytes, sha256OfFile, sha256OfValue, substitutePlaceholders } from "@weft/schema";
import type {
  AppliedFragment,
  MergeFragment,
  PlacedFile,
  PlacedPayload,
  PlacedPayloadEntry,
  Receipt,
  Sha256,
  ShadowRecord,
} from "@weft/schema";
import type { CliAdapter } from "@weft/adapters";
import { Transaction } from "./tx";
import { resolveCtx, stateDirs } from "./paths";
import type { WeftEnv } from "./paths";
import { substituteDeep } from "./subst";
import type { ExecutionPlan, PlannedFile, PlannedPayloadFile } from "./plan";

export interface ApplyResult {
  receipt: Receipt;
  warnings: string[];
  conflicts: string[];
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const dedupe = (items: string[]): string[] => [...new Set(items)];

/** A note pushed when weft must rewrite a config its parser can't round-trip (TOML comments via
 *  smol-toml). JSON/JSONC preserves comments, so this only ever fires for Codex's config.toml. */
const lossyWarn = (path: string): string =>
  `note: ${path} has comments/formatting weft can't preserve; it was normalized on write`;

function transformForPlacement(
  content: Buffer,
  rewrite: ((c: string) => string) | undefined,
  vars: Record<string, string>,
): Buffer | string {
  if (content.includes(0)) return content; // binary: copy verbatim
  let text = content.toString("utf8");
  if (rewrite) text = rewrite(text);
  return substitutePlaceholders(text, vars);
}

function writePlaced(
  tx: Transaction,
  srcAbs: string,
  destAbs: string,
  expectedSrcSha: Sha256,
  rewrite: ((c: string) => string) | undefined,
  vars: Record<string, string>,
): Sha256 {
  const content = readFileSync(srcAbs);
  if (sha256OfBytes(content) !== expectedSrcSha) {
    throw new Error(`weft: integrity check failed for spool file ${srcAbs}`);
  }
  const data = transformForPlacement(content, rewrite, vars);
  tx.writeFileAtomic(destAbs, data);
  return sha256OfBytes(data);
}

function placePlannedFile(tx: Transaction, pf: PlannedFile, vars: Record<string, string>): PlacedFile {
  let shadowed: PlacedFile["shadowed"];
  if (pf.shadow) {
    // Back up the pre-existing foreign file THROUGH the tx so a rollback removes the backup too (and
    // a commit keeps it) — the backup is no longer an un-journaled write orphaned on failure.
    tx.writeFileAtomic(pf.shadow.backupPath, readFileSync(pf.destAbs));
    shadowed = pf.shadow;
  }
  const sha = writePlaced(tx, pf.srcAbs, pf.destAbs, pf.expectedSrcSha, pf.rewriteContent, vars);
  return { slot: pf.artifact.slot, absPath: pf.destAbs, sha, shadowed, renamedFrom: pf.renamedFrom };
}

/** Place one payload file, honoring its shadow exactly like {@link placePlannedFile} does for files. */
function placePayloadFile(
  tx: Transaction,
  f: PlannedPayloadFile,
  vars: Record<string, string>,
): PlacedPayloadEntry {
  let shadowed: ShadowRecord | undefined;
  if (f.shadow) {
    tx.writeFileAtomic(f.shadow.backupPath, readFileSync(f.destAbs));
    shadowed = f.shadow;
  }
  const sha = writePlaced(tx, f.srcAbs, f.destAbs, f.expectedSrcSha, undefined, vars);
  return { rel: f.rel, sha, shadowed };
}

function substituteFragment(frag: MergeFragment, vars: Record<string, string>): MergeFragment {
  if (frag.op.type === "mcpServer") {
    const value = substituteDeep(frag.op.value, vars);
    return { ...frag, op: { ...frag.op, value }, valueSha: sha256OfValue(value) };
  }
  const command = substituteDeep(frag.op.command, vars);
  return { ...frag, op: { ...frag.op, command }, valueSha: sha256OfValue(command) };
}

function assertConfigsWritable(adapter: CliAdapter, targets: string[]): void {
  for (const target of targets) {
    const cfg = adapter.readConfig(target);
    if (cfg.existed && cfg.unparsable) {
      throw new Error(
        `weft: ${target} is not strict JSON; weft won't risk rewriting it. Remove comments/fix syntax and retry.`,
      );
    }
  }
}

function pruneEmptyDirs(dirs: Iterable<string>, env: WeftEnv, projectRoot?: string): void {
  // Stop the upward walk at the install's OWN project root (the receipt's), not the current cwd —
  // an `upgrade --all` / uninstall run from a different folder must not prune another project's tree.
  const boundaries = new Set([env.home, projectRoot ?? resolveCtx(env).projectRoot, "/"]);
  // Expand to every ancestor up to a boundary, then remove empties deepest-first to a fixpoint
  // (a parent only becomes empty once all its now-removed children are gone).
  const candidates = new Set<string>();
  for (const start of dirs) {
    let dir = start;
    while (dir && !boundaries.has(dir) && !candidates.has(dir)) {
      candidates.add(dir);
      dir = dirname(dir);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const dir of [...candidates].sort((a, b) => b.length - a.length)) {
      if (!existsSync(dir)) {
        candidates.delete(dir);
        continue;
      }
      try {
        if (readdirSync(dir).length === 0) {
          rmdirSync(dir);
          candidates.delete(dir);
          changed = true;
        }
      } catch {
        candidates.delete(dir);
      }
    }
  }
}

const receiptPath = (env: WeftEnv, id: string): string => join(stateDirs(env).receipts, `${id}.json`);

// ───────────────────────────── delegated (cask) ─────────────────────────────

/** Is `bin` resolvable on PATH? Used to fail a delegated install early with a clear message. */
function hasOnPath(bin: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an upstream installer/uninstaller command on the USER'S machine (stdout/stderr streamed so the
 * user watches it). This is the deliberate, consent-gated exception to weft's "no code execution"
 * rule — only reached for `delegated` spools whose consent the caller already obtained. Returns the
 * process exit code (never throws on a non-zero exit).
 *
 * The child runs in (and sees `HOME` =) `env.home`, the same value weft resolved the recipe's
 * `{home}`/`{dir}` tokens against — so the install always lands where the plan said it would, even
 * under a `WEFT_HOME_OVERRIDE`. In normal use `env.home` is the real home, so nothing changes.
 */
function runShell(cmd: string, env: WeftEnv): number {
  try {
    execSync(cmd, { stdio: "inherit", cwd: env.home, env: { ...process.env, HOME: env.home } });
    return 0;
  } catch (err) {
    const code = (err as { status?: number }).status;
    return typeof code === "number" ? code : 1;
  }
}

/**
 * Apply a `delegated` install: verify required tools, run the upstream installer on the user's
 * machine, and record a receipt carrying the uninstall command (so removal delegates cleanly).
 *
 * Consent is the CALLER's responsibility — this only runs once the user has agreed (`--trust` or an
 * interactive y/N). There is no transaction: weft cannot roll back what the upstream installer did to
 * the host, so on a non-zero exit we record nothing and surface the failure.
 */
export async function installDelegated(env: WeftEnv, plan: ExecutionPlan): Promise<ApplyResult> {
  const d = plan.delegate;
  if (!d) throw new Error("weft: installDelegated called without a delegated plan");

  const missing = d.requires.filter((bin) => !hasOnPath(bin));
  if (missing.length) {
    throw new Error(
      `weft: ${plan.harness} needs ${missing.join(", ")} on PATH for its installer — install ${missing.length > 1 ? "them" : "it"} and retry.`,
    );
  }

  const exitCode = runShell(d.installCmd, env);
  if (exitCode !== 0) {
    throw new Error(`weft: the ${plan.harness} installer exited with code ${exitCode}; nothing was recorded.`);
  }

  const now = new Date().toISOString();
  const receipt: Receipt = {
    schema: 1,
    receiptId: plan.receiptId,
    harness: plan.harness,
    version: plan.version,
    cli: plan.cli,
    scope: plan.scope,
    scopeKey: plan.scopeKey,
    projectPath: plan.projectPath,
    installedAt: now,
    weftVersion: env.weftVersion,
    spoolSha: plan.spoolSha,
    status: "installed",
    placedFiles: [],
    placedPayloads: [],
    appliedFragments: [],
    resolvedPlaceholders: {},
    delegation: { installCmd: d.installCmd, uninstallCmd: d.uninstallCmd, dir: d.dir, exitCode, ranAt: now },
    notes: dedupe(plan.notes),
  };
  const rp = receiptPath(env, receipt.receiptId);
  mkdirSync(dirname(rp), { recursive: true });
  writeFileSync(rp, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, warnings: [], conflicts: [] };
}

/**
 * Upgrade a `delegated` install in place: run the recipe's `upgradeCmd` (falling back to `installCmd`)
 * on the user's machine, then rewrite the receipt at the new version. Consent is the caller's job.
 */
export async function upgradeDelegated(
  env: WeftEnv,
  oldReceipt: Receipt,
  newPlan: ExecutionPlan,
): Promise<ApplyResult> {
  const d = newPlan.delegate;
  if (!d) throw new Error("weft: upgradeDelegated called without a delegated plan");

  const missing = d.requires.filter((bin) => !hasOnPath(bin));
  if (missing.length) {
    throw new Error(`weft: ${newPlan.harness} needs ${missing.join(", ")} on PATH to upgrade — install and retry.`);
  }

  const cmd = d.upgradeCmd ?? d.installCmd;
  const exitCode = runShell(cmd, env);
  if (exitCode !== 0) {
    throw new Error(`weft: the ${newPlan.harness} upgrade command exited with code ${exitCode}; receipt left unchanged.`);
  }

  const now = new Date().toISOString();
  const receipt: Receipt = {
    schema: 1,
    receiptId: newPlan.receiptId,
    harness: newPlan.harness,
    version: newPlan.version,
    cli: newPlan.cli,
    scope: newPlan.scope,
    scopeKey: newPlan.scopeKey,
    projectPath: newPlan.projectPath,
    installedAt: now,
    weftVersion: env.weftVersion,
    spoolSha: newPlan.spoolSha,
    status: "installed",
    placedFiles: [],
    placedPayloads: [],
    appliedFragments: [],
    resolvedPlaceholders: {},
    delegation: { installCmd: d.installCmd, uninstallCmd: d.uninstallCmd, dir: d.dir, exitCode, ranAt: now },
    notes: dedupe(newPlan.notes),
  };
  const rp = receiptPath(env, receipt.receiptId);
  mkdirSync(dirname(rp), { recursive: true });
  writeFileSync(rp, `${JSON.stringify(receipt, null, 2)}\n`);
  if (oldReceipt.receiptId !== receipt.receiptId) rmSync(receiptPath(env, oldReceipt.receiptId), { force: true });
  return { receipt, warnings: [], conflicts: [] };
}

// ───────────────────────────── install ─────────────────────────────

export async function installPlan(env: WeftEnv, adapter: CliAdapter, plan: ExecutionPlan): Promise<ApplyResult> {
  assertConfigsWritable(adapter, plan.configTargets);

  const tx = new Transaction(env);
  await tx.begin();
  try {
    const vars = plan.resolvedPlaceholders;
    const warnings: string[] = [];

    const placedFiles = plan.files.map((pf) => placePlannedFile(tx, pf, vars));

    const placedPayloads: PlacedPayload[] = plan.payloads.map((pp) => ({
      id: pp.id,
      baseAbs: pp.baseAbs,
      entries: pp.files.map((f) => placePayloadFile(tx, f, vars)),
    }));

    const appliedFragments: AppliedFragment[] = [];
    for (const [targetAbs, frags] of groupBy(plan.fragments, (f) => f.targetAbs)) {
      const cfg = adapter.readConfig(targetAbs);
      if (cfg.lossyReserialize) warnings.push(lossyWarn(targetAbs));
      for (const { fragment } of frags) {
        const sub = substituteFragment(fragment, vars);
        const res = adapter.mergeFragment(cfg, sub);
        warnings.push(...res.warnings);
        if (res.applied) {
          appliedFragments.push({
            id: fragment.id,
            targetAbs,
            mergeInto: fragment.mergeInto,
            locator: res.locator,
            valueSha: sub.valueSha,
          });
        }
      }
      tx.writeFileAtomic(targetAbs, adapter.serializeConfig(cfg));
    }

    const receipt: Receipt = {
      schema: 1,
      receiptId: plan.receiptId,
      harness: plan.harness,
      version: plan.version,
      cli: plan.cli,
      scope: plan.scope,
      scopeKey: plan.scopeKey,
      projectPath: plan.projectPath,
      installedAt: new Date().toISOString(),
      weftVersion: env.weftVersion,
      spoolSha: plan.spoolSha,
      status: "installed",
      placedFiles,
      placedPayloads,
      appliedFragments,
      resolvedPlaceholders: vars,
      notes: dedupe([...plan.notes, ...warnings]),
    };
    tx.writeFileAtomic(receiptPath(env, receipt.receiptId), `${JSON.stringify(receipt, null, 2)}\n`);

    await tx.commit();
    return { receipt, warnings, conflicts: [] };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// ───────────────────────────── uninstall ─────────────────────────────

export async function uninstallReceipt(
  env: WeftEnv,
  adapter: CliAdapter,
  receipt: Receipt,
): Promise<{ warnings: string[]; conflicts: string[] }> {
  const warnings: string[] = [];
  const conflicts: string[] = [];

  // Delegated (cask) installs placed nothing weft tracks — hand removal to the tool's OWN uninstaller
  // (recorded at install), then drop the receipt. Consent is the caller's responsibility.
  if (receipt.delegation) {
    const exitCode = runShell(receipt.delegation.uninstallCmd, env);
    if (exitCode !== 0) {
      warnings.push(`${receipt.harness} uninstaller exited ${exitCode}; some files may remain in ${receipt.delegation.dir}`);
    }
    rmSync(receiptPath(env, receipt.receiptId), { force: true });
    return { warnings, conflicts };
  }

  const fragTargets = dedupe(receipt.appliedFragments.map((f) => f.targetAbs));
  const skip = new Set<string>();
  for (const target of fragTargets) {
    const cfg = adapter.readConfig(target);
    if (cfg.existed && cfg.unparsable) {
      skip.add(target);
      warnings.push(`${target} is not strict JSON; left its merged entries in place`);
    }
  }

  const tx = new Transaction(env);
  await tx.begin();
  const toPrune = new Set<string>();
  try {
    for (let i = receipt.placedFiles.length - 1; i >= 0; i--) {
      const pf = receipt.placedFiles[i];
      if (!pf || !existsSync(pf.absPath)) continue;
      if ((await sha256OfFile(pf.absPath)) !== pf.sha) {
        conflicts.push(pf.absPath);
        warnings.push(`left modified file ${pf.absPath}`);
        continue;
      }
      if (pf.shadowed && existsSync(pf.shadowed.backupPath)) {
        tx.writeFileAtomic(pf.absPath, readFileSync(pf.shadowed.backupPath));
      } else {
        tx.removeFile(pf.absPath);
        toPrune.add(dirname(pf.absPath));
      }
    }

    for (let i = receipt.placedPayloads.length - 1; i >= 0; i--) {
      const pp = receipt.placedPayloads[i];
      if (!pp) continue;
      for (let j = pp.entries.length - 1; j >= 0; j--) {
        const entry = pp.entries[j];
        if (!entry) continue;
        const abs = join(pp.baseAbs, entry.rel);
        if (!existsSync(abs)) continue;
        if ((await sha256OfFile(abs)) === entry.sha) {
          if (entry.shadowed && existsSync(entry.shadowed.backupPath)) {
            tx.writeFileAtomic(abs, readFileSync(entry.shadowed.backupPath));
          } else {
            tx.removeFile(abs);
            toPrune.add(dirname(abs));
          }
        } else {
          conflicts.push(abs);
          warnings.push(`left modified payload file ${abs}`);
        }
      }
      toPrune.add(pp.baseAbs);
    }

    for (const [targetAbs, applieds] of groupBy(receipt.appliedFragments, (f) => f.targetAbs)) {
      if (skip.has(targetAbs)) continue;
      const cfg = adapter.readConfig(targetAbs);
      if (!cfg.existed) continue;
      for (let i = applieds.length - 1; i >= 0; i--) {
        const applied = applieds[i];
        if (!applied) continue;
        const res = adapter.unmergeFragment(cfg, applied);
        warnings.push(...res.warnings);
        if (res.conflict) conflicts.push(`${targetAbs} (${applied.id})`);
      }
      if (Object.keys(cfg.data).length === 0) {
        tx.removeFile(targetAbs);
        toPrune.add(dirname(targetAbs));
      } else {
        if (cfg.lossyReserialize) warnings.push(lossyWarn(targetAbs));
        tx.writeFileAtomic(targetAbs, adapter.serializeConfig(cfg));
      }
    }

    tx.removeFile(receiptPath(env, receipt.receiptId));
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  pruneEmptyDirs(toPrune, env, receipt.projectPath);
  return { warnings, conflicts };
}

// ───────────────────────────── upgrade ─────────────────────────────

export async function upgradeApply(
  env: WeftEnv,
  adapter: CliAdapter,
  oldReceipt: Receipt,
  newPlan: ExecutionPlan,
): Promise<ApplyResult> {
  const allConfigTargets = dedupe([
    ...oldReceipt.appliedFragments.map((f) => f.targetAbs),
    ...newPlan.configTargets,
  ]);
  assertConfigsWritable(adapter, allConfigTargets);

  const tx = new Transaction(env);
  await tx.begin();
  const toPrune = new Set<string>();
  const warnings: string[] = [];
  const conflicts: string[] = [];
  try {
    const vars = newPlan.resolvedPlaceholders;

    // Config files: remove every old fragment we own (verified), then add every new one.
    const oldByTarget = groupBy(oldReceipt.appliedFragments, (f) => f.targetAbs);
    const newByTarget = groupBy(newPlan.fragments, (f) => f.targetAbs);
    const appliedFragments: AppliedFragment[] = [];
    for (const targetAbs of dedupe([...oldByTarget.keys(), ...newByTarget.keys()])) {
      const cfg = adapter.readConfig(targetAbs);
      for (const applied of (oldByTarget.get(targetAbs) ?? []).slice().reverse()) {
        const res = adapter.unmergeFragment(cfg, applied);
        warnings.push(...res.warnings);
      }
      for (const { fragment } of newByTarget.get(targetAbs) ?? []) {
        const sub = substituteFragment(fragment, vars);
        const res = adapter.mergeFragment(cfg, sub);
        warnings.push(...res.warnings);
        if (res.applied) {
          appliedFragments.push({
            id: fragment.id,
            targetAbs,
            mergeInto: fragment.mergeInto,
            locator: res.locator,
            valueSha: sub.valueSha,
          });
        }
      }
      if (Object.keys(cfg.data).length === 0) {
        tx.removeFile(targetAbs);
        toPrune.add(dirname(targetAbs));
      } else {
        if (cfg.lossyReserialize) warnings.push(lossyWarn(targetAbs));
        tx.writeFileAtomic(targetAbs, adapter.serializeConfig(cfg));
      }
    }

    // Files: remove old-not-in-new (verified), then place all new (skip user-edited).
    const newFileAbs = new Set(newPlan.files.map((f) => f.destAbs));
    for (const pf of oldReceipt.placedFiles) {
      if (newFileAbs.has(pf.absPath) || !existsSync(pf.absPath)) continue;
      if ((await sha256OfFile(pf.absPath)) === pf.sha) {
        if (pf.shadowed && existsSync(pf.shadowed.backupPath)) {
          tx.writeFileAtomic(pf.absPath, readFileSync(pf.shadowed.backupPath));
        } else {
          tx.removeFile(pf.absPath);
          toPrune.add(dirname(pf.absPath));
        }
      } else {
        conflicts.push(pf.absPath);
        warnings.push(`left modified file ${pf.absPath}`);
      }
    }
    const oldFileByAbs = new Map(oldReceipt.placedFiles.map((pf) => [pf.absPath, pf]));
    const placedFiles: PlacedFile[] = [];
    for (const pf of newPlan.files) {
      const prior = oldFileByAbs.get(pf.destAbs);
      if (prior && existsSync(pf.destAbs) && (await sha256OfFile(pf.destAbs)) !== prior.sha) {
        conflicts.push(pf.destAbs);
        warnings.push(`kept your edited ${pf.destAbs}; not overwritten by upgrade`);
        placedFiles.push(prior);
        continue;
      }
      const placed = placePlannedFile(tx, pf, vars);
      // The path is now ours (managedBySelf), so this version's plan computes no shadow — carry the
      // ORIGINAL backup pointer forward, or a later uninstall would delete the user's pre-existing
      // file instead of restoring it.
      if (!placed.shadowed && prior?.shadowed) placed.shadowed = prior.shadowed;
      placedFiles.push(placed);
    }

    // Payloads: same delta, per entry.
    const newPayloadAbs = new Set(newPlan.payloads.flatMap((pp) => pp.files.map((f) => f.destAbs)));
    const oldPayloadByAbs = new Map<string, PlacedPayloadEntry>();
    for (const pp of oldReceipt.placedPayloads) {
      for (const entry of pp.entries) oldPayloadByAbs.set(join(pp.baseAbs, entry.rel), entry);
    }
    for (const pp of oldReceipt.placedPayloads) {
      for (const entry of pp.entries) {
        const abs = join(pp.baseAbs, entry.rel);
        if (newPayloadAbs.has(abs) || !existsSync(abs)) continue;
        if ((await sha256OfFile(abs)) === entry.sha) {
          if (entry.shadowed && existsSync(entry.shadowed.backupPath)) {
            tx.writeFileAtomic(abs, readFileSync(entry.shadowed.backupPath));
          } else {
            tx.removeFile(abs);
            toPrune.add(dirname(abs));
          }
        } else {
          conflicts.push(abs);
        }
      }
      toPrune.add(pp.baseAbs);
    }
    const placedPayloads: PlacedPayload[] = newPlan.payloads.map((pp) => ({
      id: pp.id,
      baseAbs: pp.baseAbs,
      entries: pp.files.map<PlacedPayloadEntry>((f) => {
        const placed = placePayloadFile(tx, f, vars);
        // Carry forward a prior foreign-file backup pointer (same reasoning as files above).
        if (!placed.shadowed) {
          const prior = oldPayloadByAbs.get(f.destAbs);
          if (prior?.shadowed) placed.shadowed = prior.shadowed;
        }
        return placed;
      }),
    }));

    const receipt: Receipt = {
      schema: 1,
      receiptId: newPlan.receiptId,
      harness: newPlan.harness,
      version: newPlan.version,
      cli: newPlan.cli,
      scope: newPlan.scope,
      scopeKey: newPlan.scopeKey,
      projectPath: newPlan.projectPath,
      installedAt: new Date().toISOString(),
      weftVersion: env.weftVersion,
      spoolSha: newPlan.spoolSha,
      status: "installed",
      placedFiles,
      placedPayloads,
      appliedFragments,
      resolvedPlaceholders: vars,
      notes: dedupe([...newPlan.notes, ...warnings]),
    };
    if (oldReceipt.receiptId !== receipt.receiptId) {
      tx.removeFile(receiptPath(env, oldReceipt.receiptId));
    }
    tx.writeFileAtomic(receiptPath(env, receipt.receiptId), `${JSON.stringify(receipt, null, 2)}\n`);

    await tx.commit();
    pruneEmptyDirs(toPrune, env, oldReceipt.projectPath);
    return { receipt, warnings, conflicts };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
