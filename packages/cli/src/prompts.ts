import * as p from "@clack/prompts";
import type { CellState } from "@weft/core";
import type { CliId, Scope } from "@weft/schema";

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

  // ── Step 2: which scope ──
  const scopeChoice = await p.select<Scope>({
    message: "Install where?",
    options: [
      { value: "local", label: "local", hint: "this project only (./.<cli>)" },
      { value: "global", label: "global", hint: "all projects (home)" },
    ],
  });
  if (p.isCancel(scopeChoice)) return null;

  const targets: InstallTarget[] = [];
  for (const cli of cliChoice) {
    if (cells.some((c) => c.cli === cli && c.scope === scopeChoice && c.installed)) {
      p.note(`${cli} / ${scopeChoice} is already installed — skipping`);
    } else {
      targets.push({ cli, scope: scopeChoice });
    }
  }
  return targets;
}
