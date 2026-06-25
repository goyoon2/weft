import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256OfBytes, sha256OfFile, sha256OfValue, substitutePlaceholders } from "@weft/schema";
import type {
  AppliedFragment,
  MergeFragment,
  PayloadEntry,
  PlacedFile,
  PlacedPayload,
  Receipt,
  Sha256,
} from "@weft/schema";
import type { CliAdapter } from "@weft/adapters";
import { Transaction } from "./tx";
import { resolveCtx, stateDirs } from "./paths";
import type { WeftEnv } from "./paths";
import { substituteDeep } from "./subst";
import type { ExecutionPlan, PlannedFile } from "./plan";

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
    mkdirSync(dirname(pf.shadow.backupPath), { recursive: true });
    writeFileSync(pf.shadow.backupPath, readFileSync(pf.destAbs));
    shadowed = pf.shadow;
  }
  const sha = writePlaced(tx, pf.srcAbs, pf.destAbs, pf.expectedSrcSha, pf.rewriteContent, vars);
  return { slot: pf.artifact.slot, absPath: pf.destAbs, sha, shadowed, renamedFrom: pf.renamedFrom };
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

function pruneEmptyDirs(dirs: Iterable<string>, env: WeftEnv): void {
  const boundaries = new Set([env.home, resolveCtx(env).projectRoot, "/"]);
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
      entries: pp.files.map((f) => ({
        rel: f.rel,
        sha: writePlaced(tx, f.srcAbs, f.destAbs, f.expectedSrcSha, undefined, vars),
      })),
    }));

    const appliedFragments: AppliedFragment[] = [];
    for (const [targetAbs, frags] of groupBy(plan.fragments, (f) => f.targetAbs)) {
      const cfg = adapter.readConfig(targetAbs);
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
          tx.removeFile(abs);
          toPrune.add(dirname(abs));
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
        tx.writeFileAtomic(targetAbs, adapter.serializeConfig(cfg));
      }
    }

    tx.removeFile(receiptPath(env, receipt.receiptId));
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  pruneEmptyDirs(toPrune, env);
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
      placedFiles.push(placePlannedFile(tx, pf, vars));
    }

    // Payloads: same delta, per entry.
    const newPayloadAbs = new Set(newPlan.payloads.flatMap((pp) => pp.files.map((f) => f.destAbs)));
    for (const pp of oldReceipt.placedPayloads) {
      for (const entry of pp.entries) {
        const abs = join(pp.baseAbs, entry.rel);
        if (newPayloadAbs.has(abs) || !existsSync(abs)) continue;
        if ((await sha256OfFile(abs)) === entry.sha) {
          tx.removeFile(abs);
          toPrune.add(dirname(abs));
        } else {
          conflicts.push(abs);
        }
      }
      toPrune.add(pp.baseAbs);
    }
    const placedPayloads: PlacedPayload[] = newPlan.payloads.map((pp) => ({
      id: pp.id,
      baseAbs: pp.baseAbs,
      entries: pp.files.map<PayloadEntry>((f) => ({
        rel: f.rel,
        sha: writePlaced(tx, f.srcAbs, f.destAbs, f.expectedSrcSha, undefined, vars),
      })),
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
    pruneEmptyDirs(toPrune, env);
    return { receipt, warnings, conflicts };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
