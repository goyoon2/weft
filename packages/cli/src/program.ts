import { Command } from "commander";
import { isCliSupported, supportedClis } from "@weft/adapters";
import type { CliId, Receipt, Scope } from "@weft/schema";
import {
  defaultEnv,
  infoHarness,
  installHarness,
  installMatrix,
  listCatalog,
  listInstalled,
  maybeAutoUpdate,
  resolveCtx,
  searchOp,
  uninstallByReceipt,
  uninstallCandidates,
  updateIndex,
  upgradeAll,
} from "@weft/core";
import type { CellState, DelegateConsent, DelegateConsentInfo, InstallResult, UninstallReceiptResult } from "@weft/core";
import { promptConfirmUninstall, promptDelegateConsent, promptInstallTargets, promptUninstallTargets } from "./prompts";
import { renderCatalog, renderInfo, renderList, renderPlan, renderSearch, renderUpdate } from "./render";
import { banner, c, sym } from "./theme";

const VERSION = "0.1.0";

function assertCli(cli: string): asserts cli is CliId {
  if (!isCliSupported(cli)) {
    throw new Error(`Unknown CLI "${cli}". Supported: ${supportedClis().join(", ")}.`);
  }
}

function assertScope(scope: string): asserts scope is Scope {
  if (scope !== "global" && scope !== "local") {
    throw new Error(`--scope must be "global" or "local" (you gave "${scope}").`);
  }
}

function locationLabel(r: { scope: Scope; projectPath?: string }): string {
  return r.scope === "global" ? "" : ` ${r.projectPath ?? ""}`.trimEnd();
}

/**
 * A friendly "you forgot an argument" block: what the command needs, how to call it, an example,
 * and a next step. Returns a type guard so the action can bail cleanly when the value is missing.
 */
function needArg(
  value: string | undefined,
  spec: { cmd: string; arg: string; what: string; example: string; hint: string },
): value is string {
  if (value) return true;
  const { cmd, arg, what, example, hint } = spec;
  console.error(
    [
      "",
      `  ${sym.err} ${c.bold(`weft ${cmd}`)} needs ${c.yellow(what)}.`,
      "",
      `  ${c.dim("Usage")}     ${c.bold(`weft ${cmd}`)} ${c.cyan(`<${arg}>`)}`,
      `  ${c.dim("Example")}   ${c.cyan(`weft ${example}`)}`,
      "",
      `  ${sym.arrow} ${hint}`,
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
  return false;
}

function reportInstall(harness: string, t: { cli: CliId; scope: Scope }, res: InstallResult, home: string): void {
  if (res.status === "installed") {
    const how = res.receipt.delegation ? c.dim(" (via its own installer)") : "";
    console.log(
      `${sym.ok} installed ${c.cyan(res.receipt.harness)} ${c.yellow(`v${res.receipt.version}`)} ${c.dim("→")} ${c.blue(t.cli)}${c.dim("/")}${t.scope}${how}`,
    );
    for (const note of res.receipt.notes ?? []) console.log(`  ${sym.warn} ${c.dim(note)}`);
  } else if (res.status === "already-installed") {
    console.log(`${sym.bullet} ${c.cyan(harness)} ${c.dim("is already installed for")} ${c.blue(t.cli)}${c.dim("/")}${t.scope}`);
  } else if (res.status === "declined") {
    console.log(`${sym.bullet} ${c.cyan(harness)} ${c.dim(`not installed — ${res.reason}`)}`);
  } else {
    console.log(renderPlan(res.plan, home));
  }
}

/**
 * The consent gate for `delegated` (cask) harnesses, shared by install and uninstall: `--trust` runs
 * the upstream command immediately; otherwise prompt y/N on a TTY; a non-TTY without `--trust` is
 * refused with guidance (we never run untrusted code unattended).
 */
function makeDelegateConsent(trust: boolean | undefined): DelegateConsent {
  return async (info: DelegateConsentInfo): Promise<boolean> => {
    if (trust) return true;
    if (!process.stdin.isTTY) {
      console.error(
        `  ${sym.err} ${c.cyan(info.harness)} ${c.dim(`is a delegated harness — it runs its own ${info.action}er on your machine. Re-run with`)} ${c.cyan("--trust")} ${c.dim("to allow it.")}`,
      );
      return false;
    }
    return promptDelegateConsent(info);
  };
}

function reportUninstall(harness: string, res: UninstallReceiptResult, receipt: Receipt): void {
  if (res.status === "uninstalled") {
    console.log(
      `${sym.ok} uninstalled ${c.cyan(harness)} ${c.dim(`(${receipt.cli}/${receipt.scope}${locationLabel(receipt)})`)}`,
    );
    if (res.conflicts.length) {
      console.log(`  ${sym.warn} ${c.dim(`left ${res.conflicts.length} modified item(s) in place`)}`);
    }
    for (const w of res.warnings) console.log(`  ${sym.warn} ${c.dim(w)}`);
  } else {
    console.log(`${sym.bullet} ${c.cyan(harness)} ${c.dim(`not uninstalled — ${res.reason}`)}`);
  }
}

/**
 * Merge per-harness install matrices into one offer for the shared CLI+scope prompt: a `(cli, scope)`
 * is offered if ANY requested harness can build it; `installed` is true only when EVERY requested
 * harness already has it there — so the "installed" hint never over-claims for a multi-harness install.
 */
function unionCells(matrices: CellState[][]): CellState[] {
  const agg = new Map<string, { cli: CliId; scope: Scope; installed: number }>();
  for (const cells of matrices) {
    for (const cell of cells) {
      const key = `${cell.cli}/${cell.scope}`;
      const a = agg.get(key) ?? { cli: cell.cli, scope: cell.scope, installed: 0 };
      if (cell.installed) a.installed++;
      agg.set(key, a);
    }
  }
  return [...agg.values()].map((a) => ({ cli: a.cli, scope: a.scope, installed: a.installed === matrices.length }));
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("weft")
    .description("A Homebrew-style package manager for AI-tool harnesses.")
    .version(VERSION, "-V, --version", "show the installed weft version")
    .showSuggestionAfterError(true);

  program.addHelpText(
    "before",
    () => `\n${banner()}\n\n  ${c.dim("A Homebrew-style package manager for AI-tool harnesses.")}\n`,
  );
  program.addHelpText("after", () =>
    [
      "",
      `  ${c.bold("Examples")}`,
      `    ${c.cyan("weft search planner")}      ${c.dim("find a harness in the catalog")}`,
      `    ${c.cyan("weft info gsd-core")}       ${c.dim("see details and install state")}`,
      `    ${c.cyan("weft install gsd-core")}    ${c.dim("install it (prompts for CLI + scope)")}`,
      `    ${c.cyan("weft list")}                ${c.dim("show what you have installed")}`,
      "",
    ].join("\n"),
  );

  program
    .command("search [query]")
    .description("find harnesses in the catalog (typo-tolerant)")
    .option("--json", "output JSON")
    .action(async (query: string | undefined, opts: { json?: boolean }) => {
      if (
        !needArg(query, {
          cmd: "search",
          arg: "query",
          what: "a search term",
          example: "search planner",
          hint: `${c.dim("Browse the full catalog with")} ${c.cyan("weft catalog")}`,
        })
      ) {
        return;
      }
      const env = defaultEnv({ weftVersion: VERSION });
      await maybeAutoUpdate(env);
      const hits = searchOp(env, query);
      if (opts.json) console.log(JSON.stringify(hits.map((h) => ({ id: h.entry.id, score: h.score })), null, 2));
      else console.log(renderSearch(hits, query));
    });

  program
    .command("info [harness]")
    .description("show details and install state for a harness")
    .option("--json", "output JSON")
    .action(async (harness: string | undefined, opts: { json?: boolean }) => {
      if (
        !needArg(harness, {
          cmd: "info",
          arg: "harness",
          what: "a harness id",
          example: "info gsd-core",
          hint: `${c.dim("See available ids with")} ${c.cyan("weft catalog")}`,
        })
      ) {
        return;
      }
      const env = defaultEnv({ weftVersion: VERSION });
      await maybeAutoUpdate(env);
      const { entry, installed } = infoHarness(env, harness);
      if (opts.json) console.log(JSON.stringify({ entry, installed }, null, 2));
      else console.log(renderInfo(entry, installed, env.home));
    });

  program
    .command("catalog")
    .alias("available")
    .description("list every harness available in the mill")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const env = defaultEnv({ weftVersion: VERSION });
      await maybeAutoUpdate(env);
      const items = listCatalog(env);
      if (opts.json) {
        console.log(
          JSON.stringify(
            items.map((i) => ({ ...i.entry, installs: i.installs.length })),
            null,
            2,
          ),
        );
      } else {
        console.log(renderCatalog(items));
      }
    });

  program
    .command("list")
    .description("list installed harnesses — this directory, then everywhere on this machine")
    .option("--all", "in --json output, include installs from other projects")
    .option("--json", "output JSON")
    .action((opts: { all?: boolean; json?: boolean }) => {
      const env = defaultEnv({ weftVersion: VERSION });
      const here = listInstalled(env); // global + this project's local installs
      const all = listInstalled(env, { all: true }); // every install across all projects
      if (opts.json) {
        console.log(JSON.stringify(opts.all ? all : here, null, 2));
      } else {
        console.log(renderList(here, all, env.home, resolveCtx(env).projectRoot));
      }
    });

  program
    .command("update")
    .description("refresh the catalog from the mill (shows what changed)")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const env = defaultEnv({ weftVersion: VERSION });
      const { diff } = await updateIndex(env);
      if (opts.json) console.log(JSON.stringify(diff, null, 2));
      else console.log(renderUpdate(diff));
    });

  program
    .command("install [harnesses...]")
    .description("install one or more harnesses (asks which CLI + scope, then applies it to all)")
    .option("--cli <id>", "target CLI")
    .option("--scope <scope>", "global or local")
    .option("--version <version>", "specific version (defaults to latest)")
    .option("--dry-run", "show the plan without writing anything")
    .option("--yes", "non-interactive")
    .option("--trust", "allow a delegated (cask) harness to run its own installer without prompting")
    .option("--json", "output JSON")
    .action(
      async (
        harnesses: string[],
        opts: {
          cli?: string;
          scope?: string;
          version?: string;
          dryRun?: boolean;
          yes?: boolean;
          trust?: boolean;
          json?: boolean;
        },
      ) => {
        if (
          !needArg(harnesses[0], {
            cmd: "install",
            arg: "harness...",
            what: "at least one harness id",
            example: "install gsd-core anthropic-skills",
            hint: `${c.dim("Find installable harnesses with")} ${c.cyan("weft catalog")}`,
          })
        ) {
          return;
        }
        const env = defaultEnv({ weftVersion: VERSION });
        await maybeAutoUpdate(env);

        // Resolve each id to its install matrix (what it can build, and where it's already installed).
        // An unknown id makes installMatrix throw — report it and skip rather than abort the batch.
        const matrices = new Map<string, CellState[]>();
        for (const h of harnesses) {
          if (matrices.has(h)) continue;
          try {
            matrices.set(h, installMatrix(env, h));
          } catch {
            if (!opts.json) console.log(`${sym.skip} ${c.dim(`no harness "${h}" in the catalog — skipped`)}`);
          }
        }
        const known = [...matrices.keys()];
        if (known.length === 0) {
          console.error(
            `\n  ${sym.err} ${c.bold("Nothing to install.")}\n\n  ${sym.arrow} ${c.dim("Browse the catalog with")} ${c.cyan("weft catalog")}\n`,
          );
          process.exitCode = 1;
          return;
        }

        // One CLI+scope decision, applied to every requested harness.
        let targets: { cli: CliId; scope: Scope }[];
        if (opts.cli && opts.scope) {
          assertCli(opts.cli);
          assertScope(opts.scope);
          targets = [{ cli: opts.cli, scope: opts.scope }];
        } else if (process.stdin.isTTY && !opts.yes) {
          const label = known.length === 1 ? known[0]! : `${known.length} harnesses`;
          const chosen = await promptInstallTargets(label, unionCells([...matrices.values()]));
          if (chosen === null) {
            console.log(`${sym.bullet} ${c.dim("Cancelled.")}`);
            return;
          }
          targets = chosen;
        } else {
          throw new Error(
            "No interactive terminal — pass both --cli <id> and --scope <global|local> to install non-interactively.",
          );
        }

        if (targets.length === 0) {
          if (!opts.json) console.log(`${sym.bullet} ${c.dim("Nothing to do.")}`);
          return;
        }

        const onDelegate = makeDelegateConsent(opts.trust);
        const results: { harness: string; cli: CliId; scope: Scope; result: InstallResult }[] = [];
        for (const harness of known) {
          const offered = matrices.get(harness)!;
          for (const t of targets) {
            // A harness in a multi-install needn't support every chosen CLI/scope — skip the ones it
            // can't build (clear note), so the others still go through.
            if (!offered.some((cell) => cell.cli === t.cli && cell.scope === t.scope)) {
              if (!opts.json) {
                console.log(`${sym.skip} ${c.cyan(harness)} ${c.dim(`has no ${t.cli}/${t.scope} build — skipped`)}`);
              }
              continue;
            }
            try {
              const result = await installHarness(env, {
                harness,
                cli: t.cli,
                scope: t.scope,
                version: opts.version,
                dryRun: Boolean(opts.dryRun),
                onDelegate,
              });
              results.push({ harness, cli: t.cli, scope: t.scope, result });
              if (!opts.json) reportInstall(harness, t, result, env.home);
            } catch (err) {
              // Isolate a single (harness, target) failure (e.g. a version that harness lacks) so the
              // rest of the batch still installs.
              if (!opts.json) {
                console.error(
                  `${sym.err} ${c.cyan(harness)} ${c.dim(`(${t.cli}/${t.scope}): ${(err as Error).message.replace(/^weft:\s*/, "")}`)}`,
                );
              }
              process.exitCode = 1;
            }
          }
        }
        if (opts.json) console.log(JSON.stringify(results, null, 2));
      },
    );

  program
    .command("uninstall [harnesses...]")
    .description("remove one or more installs — from this directory, another project, or global")
    .option("--cli <id>", "only this CLI")
    .option("--scope <scope>", "only global or local")
    .option("--yes", "skip the confirmation prompt")
    .option("--trust", "allow a delegated (cask) harness to run its own uninstaller without prompting")
    .action(
      async (harnesses: string[], opts: { cli?: string; scope?: string; yes?: boolean; trust?: boolean }) => {
        if (
          !needArg(harnesses[0], {
            cmd: "uninstall",
            arg: "harness...",
            what: "at least one harness id",
            example: "uninstall gsd-core anthropic-skills",
            hint: `${c.dim("See what's installed with")} ${c.cyan("weft list")}`,
          })
        ) {
          return;
        }
        if (opts.cli) assertCli(opts.cli);
        if (opts.scope) assertScope(opts.scope);
        const env = defaultEnv({ weftVersion: VERSION });
        const onDelegate = makeDelegateConsent(opts.trust);

        // Each harness is resolved independently — one may live in a single place (confirm), another in
        // several (pick which directory). One harness's outcome never aborts the rest of the batch.
        for (const harness of [...new Set(harnesses)]) {
          // Every install across the machine (all projects + global), narrowed by --cli/--scope — so an
          // install in another directory, or global, can be removed from wherever weft runs.
          const candidates = uninstallCandidates(env, {
            harness,
            cli: opts.cli as CliId | undefined,
            scope: opts.scope as Scope | undefined,
          });

          if (candidates.length === 0) {
            console.log(`${sym.bullet} ${c.cyan(harness)} ${c.dim("is not installed anywhere.")}`);
            continue;
          }

          let chosen: Receipt[];
          if (candidates.length === 1) {
            // One place: show exactly where, confirm y/N (skipped by --yes or a non-TTY), then remove.
            const only = candidates[0]!;
            if (process.stdin.isTTY && !opts.yes && !(await promptConfirmUninstall(harness, only, env.home))) {
              console.log(`${sym.bullet} ${c.cyan(harness)} ${c.dim("— cancelled.")}`);
              continue;
            }
            chosen = [only];
          } else if (process.stdin.isTTY && !opts.yes) {
            // Several places: let the user pick which director(ies) to remove from.
            const picked = await promptUninstallTargets(harness, candidates, env.home);
            if (picked === null || picked.length === 0) {
              console.log(`${sym.bullet} ${c.cyan(harness)} ${c.dim("— cancelled.")}`);
              continue;
            }
            chosen = picked;
          } else {
            // Ambiguous and non-interactive: list the places and ask the user to narrow it.
            console.log(
              `${sym.warn} ${c.cyan(harness)} ${c.dim("is installed in multiple places — narrow it with")} ${c.cyan("--cli")}${c.dim("/")}${c.cyan("--scope")}${c.dim(", or run interactively:")}`,
            );
            for (const r of candidates) {
              console.log(`    ${sym.sep} ${c.blue(r.cli)}${c.dim("/")}${r.scope}${c.dim(locationLabel(r))}`);
            }
            process.exitCode = 1;
            continue;
          }

          for (const r of chosen) {
            reportUninstall(harness, await uninstallByReceipt(env, r, onDelegate), r);
          }
        }
      },
    );

  program
    .command("upgrade [harness]")
    .description("upgrade every install of a harness to the latest version (all projects)")
    .option("--cli <id>", "only this CLI")
    .option("--scope <scope>", "only global or local")
    .option("--trust", "allow a delegated (cask) harness to re-run its own installer to upgrade")
    .action(async (harness: string | undefined, opts: { cli?: string; scope?: string; trust?: boolean }) => {
      if (
        !needArg(harness, {
          cmd: "upgrade",
          arg: "harness",
          what: "a harness id",
          example: "upgrade gsd-core",
          hint: `${c.dim("See what's installed with")} ${c.cyan("weft list")}`,
        })
      ) {
        return;
      }
      if (opts.cli) assertCli(opts.cli);
      if (opts.scope) assertScope(opts.scope);
      const env = defaultEnv({ weftVersion: VERSION });
      const { outcomes } = await upgradeAll(env, {
        harness,
        cli: opts.cli as CliId | undefined,
        scope: opts.scope as Scope | undefined,
        onDelegate: makeDelegateConsent(opts.trust),
      });
      if (outcomes.length === 0) {
        console.log(`${sym.bullet} ${c.cyan(harness)} ${c.dim("is not installed anywhere.")}`);
        return;
      }
      let upgraded = 0;
      let current = 0;
      for (const o of outcomes) {
        const loc = `${o.receipt.cli}/${o.receipt.scope}${locationLabel(o.receipt)}`;
        if (o.status === "upgraded") {
          upgraded++;
          console.log(
            `${sym.ok} upgraded ${c.cyan(harness)} ${c.yellow(o.from)} ${c.dim("→")} ${c.yellow(o.to)} ${c.dim(`(${loc})`)}`,
          );
          if (o.conflicts.length) console.log(`  ${sym.warn} ${c.dim(`kept ${o.conflicts.length} item(s) you had modified`)}`);
        } else if (o.status === "up-to-date") {
          current++;
          console.log(`${sym.bullet} ${c.dim("already latest")} ${c.yellow(o.version)} ${c.dim(`(${loc})`)}`);
        } else {
          console.log(`${sym.skip} ${c.dim(`skipped ${loc}: ${o.reason}`)}`);
        }
      }
      if (outcomes.length > 1) {
        const skipped = outcomes.length - upgraded - current;
        console.log(
          `\n${c.bold(`${upgraded} upgraded`)}${c.dim(", ")}${c.bold(`${current} already current`)}${skipped ? `${c.dim(", ")}${c.bold(`${skipped} skipped`)}` : ""}${c.dim(".")}`,
        );
      }
    });

  return program;
}

/**
 * Turn Commander's terse one-liners ("error: missing required argument 'query'") into a styled,
 * actionable message. Help/version are not errors — they print to stdout and we exit cleanly.
 */
function reportError(err: unknown): void {
  const ce = err as { code?: string; exitCode?: number; message?: string };
  if (ce.code === "commander.helpDisplayed" || ce.code === "commander.version" || ce.code === "commander.help") {
    return;
  }
  const raw = (ce.message ?? String(err)).replace(/^error:\s*/i, "").replace(/^weft:\s*/i, "");
  const [first, ...rest] = raw.split("\n");
  const lines = ["", `  ${sym.err} ${c.bold(first ?? raw)}`];
  for (const extra of rest) lines.push(`  ${c.dim(extra)}`);
  if (ce.code === "commander.unknownCommand") {
    lines.push("", `  ${sym.arrow} ${c.dim("See every command with")} ${c.cyan("weft --help")}`);
  } else if (ce.code === "commander.unknownOption") {
    lines.push("", `  ${sym.arrow} ${c.dim("List a command's options with")} ${c.cyan("weft <command> --help")}`);
  }
  lines.push("");
  console.error(lines.join("\n"));
  process.exitCode = ce.exitCode && ce.exitCode !== 0 ? ce.exitCode : 1;
}

export async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  // Throw on parse/help/version instead of calling process.exit, so we render errors ourselves and
  // suppress Commander's default stderr line (we print a friendlier one in reportError).
  program.exitOverride();
  program.configureOutput({ outputError: () => {} });
  for (const sub of program.commands) {
    sub.exitOverride();
    sub.configureOutput({ outputError: () => {} });
  }
  // Bare `weft` with no command: show the styled help rather than an error.
  if (argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(argv);
  } catch (err) {
    reportError(err);
  }
}
