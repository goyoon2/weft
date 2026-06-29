import * as p from "@clack/prompts";
import type { CellState, DelegateConsentInfo } from "@weft/core";
import type { CliId, Receipt, Scope } from "@weft/schema";
import { homeRelative } from "./render";

export interface InstallTarget {
  cli: CliId;
  scope: Scope;
}

/**
 * Two-step install prompt: first pick the CLI(s) (multi-select), then a single scope. The chosen
 * `(cli, scope)` targets apply to EVERY harness in the request (`label` names them — one id, or
 * "N harnesses"). `cells` is the union of what those harnesses can build; `installed` is true only
 * where every requested harness already has it. Whether a given harness actually has a build for a
 * target — and whether it's already installed — is reported per-harness at install time, so this
 * returns every `(cli, chosenScope)` the union can build and never silently drops one. Null on cancel.
 */
export async function promptInstallTargets(label: string, cells: CellState[]): Promise<InstallTarget[] | null> {
  const clis = [...new Set(cells.map((c) => c.cli))];

  // ── Step 1: which CLI(s) ──
  const cliChoice = await p.multiselect<CliId>({
    message: `Install ${label} for which CLI(s)?`,
    options: clis.map((cli) => {
      const installedScopes = cells.filter((c) => c.cli === cli && c.installed).map((c) => c.scope);
      return {
        value: cli,
        label: cli,
        hint: installedScopes.length ? `installed: ${installedScopes.join(", ")}` : undefined,
      };
    }),
    required: true,
  });
  if (p.isCancel(cliChoice)) return null;

  // ── Step 2: which scope ── only the scopes that actually have a spool for the chosen CLI(s).
  // A harness need not build both scopes (a delegated global-only tool ships no `local` spool), so we
  // never offer a scope that can't be installed. When only one is possible, auto-pick it.
  const selected = new Set<CliId>(cliChoice);
  const hint: Record<Scope, string> = {
    local: "this project only (./.<cli>)",
    global: "all projects (home)",
  };
  const scopeOptions = (["local", "global"] as Scope[]).filter((s) =>
    cells.some((c) => selected.has(c.cli) && c.scope === s),
  );

  let scopeChoice: Scope;
  if (scopeOptions.length === 0) {
    return []; // nothing buildable for the chosen CLIs (shouldn't happen — clis came from cells)
  } else if (scopeOptions.length === 1) {
    scopeChoice = scopeOptions[0]!;
    p.note(`Only ${scopeChoice} is available for ${[...selected].join(", ")} — installing there.`);
  } else {
    const chosen = await p.select<Scope>({
      message: "Install where?",
      options: scopeOptions.map((s) => ({ value: s, label: s, hint: hint[s] })),
    });
    if (p.isCancel(chosen)) return null;
    scopeChoice = chosen;
  }

  // Every (cli, chosenScope) the union can build. Per-harness availability / already-installed is the
  // install step's job to report — so multiple harnesses with differing support each get a clear line.
  return cliChoice
    .filter((cli) => cells.some((c) => c.cli === cli && c.scope === scopeChoice))
    .map((cli) => ({ cli, scope: scopeChoice }));
}

/**
 * The consent gate for a `delegated` (cask) install/uninstall: weft is about to run the upstream
 * tool's OWN installer on the user's machine. Show the exact command (plus what it needs and where it
 * lands), then ask y/N. `--trust` skips this entirely; a non-TTY without `--trust` never reaches here.
 */
export async function promptDelegateConsent(info: DelegateConsentInfo): Promise<boolean> {
  const verb = info.action === "install" ? "install" : "uninstall";
  const lines = [
    `weft will ${verb} ${info.harness} by running its OWN installer on your machine.`,
    "This runs upstream code locally — only proceed if you trust it.",
    "",
    "  $ " + info.cmd,
    "",
  ];
  if (info.summary) lines.push(info.summary, "");
  if (info.requires.length) lines.push(`needs on PATH: ${info.requires.join(", ")}`);
  lines.push(`install dir:  ${info.dir}`);
  p.note(lines.join("\n"), `${verb} ${info.harness} — delegated (cask)`);

  const ok = await p.confirm({ message: `Run this ${verb} command now?`, initialValue: false });
  if (p.isCancel(ok)) return false;
  return ok === true;
}

/** Where an install lives, for the uninstall prompts: "global (all projects)" or its project dir. */
function installLocation(r: Receipt, home: string): string {
  return r.scope === "global" ? "global (all projects)" : homeRelative(r.projectPath ?? "this project", home);
}

/**
 * Single-install uninstall: show exactly where it lives and ask y/N before removing. Returns false on
 * cancel or "no" — the caller only proceeds on an explicit yes.
 */
export async function promptConfirmUninstall(harness: string, r: Receipt, home: string): Promise<boolean> {
  const ok = await p.confirm({
    message: `Uninstall ${harness} (${r.cli}) from ${installLocation(r, home)}?`,
    initialValue: false,
  });
  if (p.isCancel(ok)) return false;
  return ok === true;
}

/**
 * When a harness is installed in several places (across projects + global), let the user multi-select
 * which install(s) to remove, labelled by LOCATION so picking "which directory" is the point. Keyed
 * by the unique `receiptId` (two local installs in different dirs share a cli/scope, so that can't be
 * the key). Returns the chosen receipts; null on cancel; empty if nothing was picked.
 */
export async function promptUninstallTargets(
  harness: string,
  candidates: Receipt[],
  home: string,
): Promise<Receipt[] | null> {
  const byId = new Map(candidates.map((r) => [r.receiptId, r]));
  const choice = await p.multiselect<string>({
    message: `Uninstall ${harness} from which install(s)?`,
    options: candidates.map((r) => ({
      value: r.receiptId,
      label: installLocation(r, home),
      hint: `${r.cli} · v${r.version}`,
    })),
    required: true,
  });
  if (p.isCancel(choice)) return null;
  return choice.map((id) => byId.get(id)).filter((r): r is Receipt => r !== undefined);
}
