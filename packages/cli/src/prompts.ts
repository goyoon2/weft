import * as p from "@clack/prompts";
import type { CellState, DelegateConsentInfo } from "@weft/core";
import type { CliId, Receipt, Scope } from "@weft/schema";

export interface InstallTarget {
  cli: CliId;
  scope: Scope;
}

/**
 * Two-step install prompt: first pick the CLI(s) (multi-select), then the scope.
 * Already-installed `(cli, scope)` combinations are dropped from the result with a note.
 * Returns null if the user cancels.
 */
export async function promptInstallTargets(harness: string, cells: CellState[]): Promise<InstallTarget[] | null> {
  const clis = [...new Set(cells.map((c) => c.cli))];

  // ── Step 1: which CLI(s) ──
  const cliChoice = await p.multiselect<CliId>({
    message: `Install ${harness} for which CLI(s)?`,
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

  const targets: InstallTarget[] = [];
  for (const cli of cliChoice) {
    const cell = cells.find((c) => c.cli === cli && c.scope === scopeChoice);
    if (!cell) {
      p.note(`${cli} / ${scopeChoice} isn't available — skipping`);
    } else if (cell.installed) {
      p.note(`${cli} / ${scopeChoice} is already installed — skipping`);
    } else {
      targets.push({ cli, scope: scopeChoice });
    }
  }
  return targets;
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

const targetKey = (r: { cli: CliId; scope: Scope }): string => `${r.cli}/${r.scope}`;

/**
 * When an uninstall matches several installs in the current context, let the user multi-select
 * which (cli, scope) install(s) to remove — the symmetric counterpart to the install prompt.
 * (cli, scope) is unique among the candidates, so it doubles as the option key. Returns null on
 * cancel; an empty array if nothing was picked.
 */
export async function promptUninstallTargets(harness: string, candidates: Receipt[]): Promise<InstallTarget[] | null> {
  const choice = await p.multiselect<string>({
    message: `Uninstall ${harness} from which install(s)?`,
    options: candidates.map((r) => ({
      value: targetKey(r),
      label: `${r.cli} / ${r.scope}`,
      hint: r.scope === "global" ? "all projects" : (r.projectPath ?? "this project"),
    })),
    required: true,
  });
  if (p.isCancel(choice)) return null;
  return candidates.filter((r) => choice.includes(targetKey(r))).map((r) => ({ cli: r.cli, scope: r.scope }));
}
