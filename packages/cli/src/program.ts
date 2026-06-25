import { Command } from "commander";
import { isCliSupported, supportedClis } from "@weft/adapters";
import type { CliId, Scope } from "@weft/schema";
import {
  defaultEnv,
  infoHarness,
  installHarness,
  installMatrix,
  listInstalled,
  searchOp,
  uninstallHarness,
  updateIndex,
  upgradeHarness,
} from "@weft/core";
import type { InstallResult } from "@weft/core";
import { promptInstallTargets } from "./prompts";
import { renderInfo, renderList, renderPlan, renderSearch } from "./render";

const VERSION = "0.1.0";

function assertCli(cli: string): asserts cli is CliId {
  if (!isCliSupported(cli)) {
    throw new Error(`unknown CLI "${cli}" (supported: ${supportedClis().join(", ")})`);
  }
}

function assertScope(scope: string): asserts scope is Scope {
  if (scope !== "global" && scope !== "local") {
    throw new Error(`scope must be "global" or "local" (got "${scope}")`);
  }
}

function locationLabel(r: { scope: Scope; projectPath?: string }): string {
  return r.scope === "global" ? "" : ` ${r.projectPath ?? ""}`.trimEnd();
}

function reportInstall(harness: string, t: { cli: CliId; scope: Scope }, res: InstallResult, home: string): void {
  if (res.status === "installed") {
    console.log(`✓ installed ${res.receipt.harness} ${res.receipt.version} → ${t.cli}/${t.scope}`);
    for (const note of res.receipt.notes ?? []) console.log(`  note: ${note}`);
  } else if (res.status === "already-installed") {
    console.log(`• ${harness} already installed for ${t.cli}/${t.scope}`);
  } else {
    console.log(renderPlan(res.plan, home));
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("weft")
    .description("A Homebrew-style package manager for AI-tool harnesses.")
    .version(VERSION);

  program
    .command("search <query>")
    .description("find harnesses in the catalog (typo-tolerant)")
    .option("--json", "output JSON")
    .action((query: string, opts: { json?: boolean }) => {
      const env = defaultEnv({ weftVersion: VERSION });
      const hits = searchOp(env, query);
      if (opts.json) console.log(JSON.stringify(hits.map((h) => ({ id: h.entry.id, score: h.score })), null, 2));
      else console.log(renderSearch(hits));
    });

  program
    .command("info <harness>")
    .description("show details and install state for a harness")
    .option("--json", "output JSON")
    .action((harness: string, opts: { json?: boolean }) => {
      const env = defaultEnv({ weftVersion: VERSION });
      const { entry, installed } = infoHarness(env, harness);
      if (opts.json) console.log(JSON.stringify({ entry, installed }, null, 2));
      else console.log(renderInfo(entry, installed, env.home));
    });

  program
    .command("list")
    .description("list installed harnesses")
    .option("--all", "include installs from other projects")
    .option("--json", "output JSON")
    .action((opts: { all?: boolean; json?: boolean }) => {
      const env = defaultEnv({ weftVersion: VERSION });
      const receipts = listInstalled(env, { all: opts.all });
      if (opts.json) console.log(JSON.stringify(receipts, null, 2));
      else console.log(renderList(receipts, env.home));
    });

  program
    .command("update")
    .description("refresh the catalog from the mill")
    .action(() => {
      const env = defaultEnv({ weftVersion: VERSION });
      const { entries } = updateIndex(env);
      console.log(`✓ catalog updated — ${entries} harness(es) available.`);
    });

  program
    .command("install <harness>")
    .description("install a harness (asks which CLI + scope unless given)")
    .option("--cli <id>", "target CLI")
    .option("--scope <scope>", "global or local")
    .option("--version <version>", "specific version (defaults to latest)")
    .option("--dry-run", "show the plan without writing anything")
    .option("--yes", "non-interactive")
    .option("--json", "output JSON")
    .action(
      async (
        harness: string,
        opts: { cli?: string; scope?: string; version?: string; dryRun?: boolean; yes?: boolean; json?: boolean },
      ) => {
        const env = defaultEnv({ weftVersion: VERSION });
        let targets: { cli: CliId; scope: Scope }[];

        if (opts.cli && opts.scope) {
          assertCli(opts.cli);
          assertScope(opts.scope);
          targets = [{ cli: opts.cli, scope: opts.scope }];
        } else if (process.stdin.isTTY && !opts.yes) {
          const chosen = await promptInstallTargets(harness, installMatrix(env, harness));
          if (chosen === null) {
            console.log("cancelled.");
            return;
          }
          targets = chosen;
        } else {
          throw new Error("specify --cli <id> and --scope <global|local> (no interactive terminal)");
        }

        if (targets.length === 0) {
          if (!opts.json) console.log("nothing to do.");
          return;
        }

        const results: { cli: CliId; scope: Scope; result: InstallResult }[] = [];
        for (const t of targets) {
          const result = await installHarness(env, {
            harness,
            cli: t.cli,
            scope: t.scope,
            version: opts.version,
            dryRun: Boolean(opts.dryRun),
          });
          results.push({ ...t, result });
          if (!opts.json) reportInstall(harness, t, result, env.home);
        }
        if (opts.json) console.log(JSON.stringify(results, null, 2));
      },
    );

  program
    .command("uninstall <harness>")
    .description("remove a harness install")
    .option("--cli <id>", "target CLI")
    .option("--scope <scope>", "global or local")
    .action(async (harness: string, opts: { cli?: string; scope?: string }) => {
      if (opts.cli) assertCli(opts.cli);
      if (opts.scope) assertScope(opts.scope);
      const env = defaultEnv({ weftVersion: VERSION });
      const res = await uninstallHarness(env, {
        harness,
        cli: opts.cli as CliId | undefined,
        scope: opts.scope as Scope | undefined,
      });
      if (res.status === "uninstalled") {
        console.log(`✓ uninstalled ${harness} (${res.receipt.cli}/${res.receipt.scope})`);
        if (res.conflicts.length) console.log(`  left ${res.conflicts.length} modified item(s) in place`);
      } else if (res.status === "not-installed") {
        console.log(`${harness} is not installed here.`);
        for (const r of res.elsewhere) console.log(`  · also at ${r.cli}/${r.scope}${locationLabel(r)}`);
      } else {
        console.log(`${harness} is installed in multiple places — narrow with --cli/--scope:`);
        for (const r of res.candidates) console.log(`  · ${r.cli}/${r.scope}${locationLabel(r)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("upgrade <harness>")
    .description("upgrade an installed harness to the latest version")
    .option("--cli <id>", "target CLI")
    .option("--scope <scope>", "global or local")
    .action(async (harness: string, opts: { cli?: string; scope?: string }) => {
      if (opts.cli) assertCli(opts.cli);
      if (opts.scope) assertScope(opts.scope);
      const env = defaultEnv({ weftVersion: VERSION });
      const res = await upgradeHarness(env, {
        harness,
        cli: opts.cli as CliId | undefined,
        scope: opts.scope as Scope | undefined,
      });
      if (res.status === "upgraded") {
        console.log(`✓ upgraded ${harness} ${res.from} → ${res.to} (${res.receipt.cli}/${res.receipt.scope})`);
        if (res.conflicts.length) console.log(`  kept ${res.conflicts.length} item(s) you had modified`);
      } else if (res.status === "up-to-date") {
        console.log(`${harness} is already at the latest version (${res.version}).`);
      } else if (res.status === "not-installed") {
        console.log(`${harness} is not installed here.`);
      } else {
        console.log(`${harness} is installed in multiple places — narrow with --cli/--scope:`);
        for (const r of res.candidates) console.log(`  · ${r.cli}/${r.scope}${locationLabel(r)}`);
        process.exitCode = 1;
      }
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    console.error(`weft: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
