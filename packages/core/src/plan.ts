import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256OfFile } from "@weft/schema";
import type { CliId, FileArtifact, MergeFragment, Scope, Sha256, Spool } from "@weft/schema";
import type { CliAdapter, ResolveCtx } from "@weft/adapters";
import { readAllReceipts } from "./receipts";
import { stateDirs } from "./paths";
import type { WeftEnv } from "./paths";

export interface ShadowPlan {
  backupPath: string;
  originalSha: Sha256;
}

export interface PlannedFile {
  artifact: FileArtifact;
  srcAbs: string;
  destAbs: string;
  expectedSrcSha: Sha256;
  rewriteContent?: (content: string) => string;
  renamedFrom?: string;
  shadow?: ShadowPlan;
}

export interface PlannedPayloadFile {
  rel: string;
  srcAbs: string;
  destAbs: string;
  expectedSrcSha: Sha256;
  shadow?: ShadowPlan;
}

export interface PlannedPayload {
  id: string;
  baseAbs: string;
  files: PlannedPayloadFile[];
}

export interface PlannedFragment {
  fragment: MergeFragment;
  targetAbs: string;
}

/** A `delegated` spool's recipe with every install-time token resolved, ready to run. */
export interface ResolvedDelegate {
  installCmd: string;
  uninstallCmd: string;
  upgradeCmd?: string;
  dir: string;
  requires: string[];
  summary?: string;
}

export interface ExecutionPlan {
  harness: string;
  version: string;
  cli: CliId;
  scope: Scope;
  scopeKey: string;
  projectPath?: string;
  receiptId: string;
  spoolSha: Sha256;
  resolvedPlaceholders: Record<string, string>;
  files: PlannedFile[];
  payloads: PlannedPayload[];
  fragments: PlannedFragment[];
  configTargets: string[];
  /** Present only for `delegated` (cask) installs: the resolved installer commands to run. */
  delegate?: ResolvedDelegate;
  notes: string[];
}

/** Substitute `{token}` placeholders; unknown tokens are left verbatim. */
function fillTokens(s: string, tok: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in tok ? (tok[k] ?? m) : m));
}

export interface BuildPlanArgs {
  env: WeftEnv;
  ctx: ResolveCtx;
  scope: Scope;
  scopeKey: string;
  projectPath?: string;
  adapter: CliAdapter;
  spool: Spool;
  spoolSha: Sha256;
  fetchedDir: string;
  receiptId: string;
}

function resolvePlaceholders(spool: Spool, adapter: CliAdapter, scope: Scope, ctx: ResolveCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of spool.placeholders) {
    if (name === "WEFT_PAYLOAD_DIR") {
      const payload = spool.payloads[0];
      if (!payload) throw new Error(`weft: spool declares {{WEFT_PAYLOAD_DIR}} but ships no payload`);
      out[name] = join(adapter.payloadBase(scope, ctx), payload.baseRel);
    } else {
      throw new Error(`weft: unsupported spool placeholder {{${name}}}`);
    }
  }
  return out;
}

/** Compute a complete install plan from a fetched spool — pure analysis, no disk mutation. */
export async function buildPlan(args: BuildPlanArgs): Promise<ExecutionPlan> {
  const { env, ctx, scope, scopeKey, adapter, spool, fetchedDir, receiptId } = args;
  const notes: string[] = [];
  const backupsRoot = join(stateDirs(env).backups, receiptId);

  // Classify existing paths at this (cli, scope): files OTHER harnesses own (→ collide/namespace)
  // vs. files THIS harness already owns (→ ours to replace on upgrade, never a foreign shadow).
  const managedByOther = new Map<string, string>();
  const managedBySelf = new Set<string>();
  for (const r of readAllReceipts(env)) {
    if (r.cli !== spool.cli || r.scopeKey !== scopeKey) continue;
    const claim = (abs: string): void => {
      if (r.harness === spool.harness) managedBySelf.add(abs);
      else managedByOther.set(abs, r.harness);
    };
    for (const pf of r.placedFiles) claim(pf.absPath);
    for (const pp of r.placedPayloads) for (const e of pp.entries) claim(join(pp.baseAbs, e.rel));
  }

  const resolvedPlaceholders = resolvePlaceholders(spool, adapter, scope, ctx);

  // A foreign file (exists, not ours, not another harness's tracked file) gets backed up & restored
  // on uninstall. Our own prior-version files are overwritten in place (no shadow).
  const shadowFor = async (destAbs: string, sub: string): Promise<ShadowPlan | undefined> => {
    if (!existsSync(destAbs) || managedByOther.has(destAbs) || managedBySelf.has(destAbs)) return undefined;
    return { backupPath: join(backupsRoot, sub), originalSha: await sha256OfFile(destAbs) };
  };

  const files: PlannedFile[] = [];
  let collisions = 0;
  for (const original of spool.files) {
    let artifact = original;
    let rewriteContent: ((c: string) => string) | undefined;
    let renamedFrom: string | undefined;

    let destAbs = join(adapter.slotRoot(artifact.slot, scope, ctx), artifact.destRel);
    const owner = managedByOther.get(destAbs);
    if (owner) {
      const ns = adapter.applyNamespace(artifact, spool.harness);
      artifact = ns.artifact;
      rewriteContent = ns.rewriteContent;
      renamedFrom = ns.renamedFrom;
      destAbs = join(adapter.slotRoot(artifact.slot, scope, ctx), artifact.destRel);
      collisions++;
      notes.push(`namespaced ${renamedFrom} → ${artifact.destRel} (collides with ${owner})`);
    }

    files.push({
      artifact,
      srcAbs: join(fetchedDir, original.archivePath),
      destAbs,
      expectedSrcSha: original.sha,
      rewriteContent,
      renamedFrom,
      shadow: await shadowFor(destAbs, join("files", artifact.destRel)),
    });
  }

  const payloads: PlannedPayload[] = [];
  for (const pa of spool.payloads) {
    const baseAbs = join(adapter.payloadBase(scope, ctx), pa.baseRel);
    const planned: PlannedPayloadFile[] = [];
    for (const entry of pa.entries) {
      const destAbs = join(baseAbs, entry.rel);
      planned.push({
        rel: entry.rel,
        srcAbs: join(fetchedDir, pa.archiveDir, entry.rel),
        destAbs,
        expectedSrcSha: entry.sha,
        shadow: await shadowFor(destAbs, join("payloads", pa.id, entry.rel)),
      });
    }
    payloads.push({ id: pa.id, baseAbs, files: planned });
  }

  const fragments: PlannedFragment[] = spool.fragments.map((fragment) => ({
    fragment,
    targetAbs: adapter.configFilePath(fragment.mergeInto, scope, ctx),
  }));
  const configTargets = [...new Set(fragments.map((f) => f.targetAbs))];

  if (spool.files.some((f) => f.slot === "command")) {
    notes.push(
      "commands install as /<name>; any in-body references using the upstream ':' namespace won't auto-resolve",
    );
  }

  // Delegated (cask) spools carry no files — resolve their installer recipe's install-time tokens
  // ({dir}/{home}/{scopeFlag}) here, where the client knows the user's home and the chosen scope.
  let delegate: ResolvedDelegate | undefined;
  if (spool.delegate) {
    const home = env.home;
    const scopeFlag = scope === "global" ? "--global" : "--local";
    const dir = fillTokens(spool.delegate.dir, { home });
    const tok = { home, dir, scopeFlag, ref: spool.delegate.ref, version: spool.delegate.version };
    delegate = {
      installCmd: fillTokens(spool.delegate.installCmd, tok),
      uninstallCmd: fillTokens(spool.delegate.uninstallCmd, tok),
      upgradeCmd: spool.delegate.upgradeCmd ? fillTokens(spool.delegate.upgradeCmd, tok) : undefined,
      dir,
      requires: spool.delegate.requires,
      summary: spool.delegate.summary,
    };
  }

  return {
    harness: spool.harness,
    version: spool.version,
    cli: spool.cli,
    scope,
    scopeKey,
    projectPath: args.projectPath,
    receiptId,
    spoolSha: args.spoolSha,
    resolvedPlaceholders,
    files,
    payloads,
    fragments,
    configTargets,
    delegate,
    notes,
  };
}
