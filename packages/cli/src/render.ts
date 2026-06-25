import type { IndexEntry, Receipt } from "@weft/schema";
import type { CatalogDiff, CatalogItem, ExecutionPlan, SearchHit } from "@weft/core";
import { badge, c, sym } from "./theme";

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function homeRelative(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? path.replace(home, "~") : path;
}

const clis = (ids: readonly string[]): string => ids.map((x) => c.blue(x)).join(c.dim(", "));

export function renderSearch(hits: SearchHit[], query: string): string {
  if (hits.length === 0) {
    return [
      "",
      `  ${sym.err} No harnesses match ${c.bold(`"${query}"`)}.`,
      "",
      `  ${sym.arrow} ${c.dim("Browse everything available with")} ${c.cyan("weft catalog")}`,
      "",
    ].join("\n");
  }
  const noun = hits.length === 1 ? "harness" : "harnesses";
  const head = `  ${c.bold(`${hits.length} ${noun}`)} ${c.dim(`matching "${query}"`)}`;
  const blocks = hits.map((h) => {
    const e = h.entry;
    return [
      `  ${c.cyan(c.bold(e.id))}  ${sym.sep}  ${c.bold(e.displayName)}`,
      `    ${c.dim(truncate(e.description, 72))}`,
      `    ${clis(e.clis)}   ${c.yellow(`v${e.latest}`)}`,
    ].join("\n");
  });
  return [
    "",
    head,
    "",
    blocks.join("\n\n"),
    "",
    `  ${sym.arrow} ${c.dim("Details:")} ${c.cyan("weft info <id>")}   ${c.dim("Install:")} ${c.cyan("weft install <id>")}`,
    "",
  ].join("\n");
}

export function renderCatalog(items: CatalogItem[]): string {
  if (items.length === 0) {
    return [
      "",
      `  ${sym.warn} ${c.bold("The catalog is empty.")}`,
      "",
      `  ${sym.arrow} ${c.dim("Fetch it from the mill with")} ${c.cyan("weft update")}`,
      "",
    ].join("\n");
  }
  const idW = Math.max(...items.map((i) => i.entry.id.length));
  const installedCount = items.filter((i) => i.installs.length).length;
  const noun = items.length === 1 ? "harness" : "harnesses";
  const head =
    `  ${c.bold(`${items.length} ${noun} available`)}` +
    (installedCount ? c.dim(`   ·   ${installedCount} installed`) : "");
  const rows = items.map((it) => {
    const e = it.entry;
    const dot = it.installs.length ? sym.on : sym.off;
    const id = c.cyan(c.bold(e.id.padEnd(idW)));
    const desc = c.dim(truncate(e.description, 52));
    const ver = c.yellow(`v${e.latest}`);
    const inst = it.installs.length ? `  ${badge(`installed ×${it.installs.length}`, "green")}` : "";
    return `  ${dot} ${id}  ${desc}  ${clis(e.clis)}  ${ver}${inst}`;
  });
  return [
    "",
    head,
    "",
    rows.join("\n"),
    "",
    `  ${sym.arrow} ${c.dim("Install one with")} ${c.cyan("weft install <id>")}`,
    "",
  ].join("\n");
}

export function renderUpdate(diff: CatalogDiff): string {
  const noun = diff.total === 1 ? "harness" : "harnesses";
  const available = `${c.bold(`${diff.total} ${noun}`)} ${c.dim("available")}`;

  // First ever pull — there's no previous catalog to diff against, so don't pretend everything is new.
  if (diff.firstRun) {
    return [
      "",
      `  ${sym.ok} ${c.dim("Catalog fetched —")} ${available}`,
      "",
      `  ${sym.arrow} ${c.dim("Browse it with")} ${c.cyan("weft catalog")}`,
      "",
    ].join("\n");
  }

  const changed = diff.added.length + diff.updated.length + diff.removed.length;
  if (changed === 0) {
    return [
      "",
      `  ${sym.ok} ${c.dim("Catalog up to date —")} ${available}${c.dim(", nothing changed.")}`,
      "",
    ].join("\n");
  }

  // One id column width across every section so the three lists line up.
  const idW = Math.max(
    ...diff.added.map((e) => e.id.length),
    ...diff.updated.map((e) => e.id.length),
    ...diff.removed.map((e) => e.id.length),
  );
  const id = (s: string): string => c.cyan(c.bold(s.padEnd(idW)));
  const lines = ["", `  ${sym.ok} ${c.dim("Catalog updated —")} ${available}`];

  if (diff.added.length) {
    lines.push("", `  ${c.bold(c.green(`New (${diff.added.length})`))}`);
    for (const e of diff.added) {
      lines.push(`    ${c.green("+")} ${id(e.id)}  ${c.yellow(`v${e.version}`)}  ${clis(e.clis)}`);
    }
  }
  if (diff.updated.length) {
    lines.push("", `  ${c.bold(c.yellow(`Updated (${diff.updated.length})`))}`);
    for (const u of diff.updated) {
      lines.push(`    ${c.yellow("↑")} ${id(u.id)}  ${c.dim(`v${u.from}`)} ${c.dim("→")} ${c.yellow(`v${u.to}`)}`);
    }
  }
  if (diff.removed.length) {
    lines.push("", `  ${c.bold(c.red(`Removed (${diff.removed.length})`))}`);
    for (const e of diff.removed) {
      lines.push(`    ${c.red("-")} ${id(e.id)}  ${c.dim(`v${e.version}`)}`);
    }
  }

  // Only worth nudging to `upgrade` when a version actually moved under an install you might hold.
  if (diff.updated.length) {
    lines.push("", `  ${sym.arrow} ${c.dim("Pull updates into your installs with")} ${c.cyan("weft upgrade <id>")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderList(receipts: Receipt[], home: string): string {
  if (receipts.length === 0) {
    return [
      "",
      `  ${sym.bullet} ${c.bold("Nothing installed yet.")}`,
      "",
      `  ${sym.arrow} ${c.dim("See what's available with")} ${c.cyan("weft catalog")}`,
      "",
    ].join("\n");
  }
  const rows = receipts.map((r) => [
    r.harness,
    `v${r.version}`,
    r.cli,
    r.scope,
    r.scope === "global" ? "~" : homeRelative(r.projectPath ?? "(unknown)", home),
  ]);
  const headers = ["HARNESS", "VERSION", "CLI", "SCOPE", "LOCATION"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const headLine = "  " + headers.map((h, i) => c.dim(c.bold(h.padEnd(widths[i] ?? 0)))).join("  ");
  const paint = (val: string, i: number): string => {
    const padded = val.padEnd(widths[i] ?? 0);
    if (i === 0) return c.cyan(c.bold(padded));
    if (i === 1) return c.yellow(padded);
    if (i === 2) return c.blue(padded);
    if (i === 4) return c.dim(padded);
    return padded;
  };
  const body = rows.map((row) => "  " + row.map(paint).join("  "));
  return ["", headLine, ...body, ""].join("\n");
}

export function renderInfo(entry: IndexEntry, installed: Receipt[], home: string): string {
  const label = (s: string): string => c.dim(s.padEnd(10));
  const cont = " ".repeat(12); // aligns under the value column (2 indent + 10 label)
  const lines: string[] = [
    "",
    `  ${c.cyan(c.bold(entry.id))}   ${c.bold(entry.displayName)}`,
    `  ${c.dim(entry.description)}`,
    "",
  ];
  if (entry.homepage) lines.push(`  ${label("homepage")}${c.underline(c.blue(entry.homepage))}`);
  lines.push(`  ${label("CLIs")}${clis(entry.clis)}`);
  lines.push(
    `  ${label("versions")}${entry.versions
      .map((v) => (v.version === entry.latest ? `${c.yellow(v.version)} ${c.green("(latest)")}` : c.dim(v.version)))
      .join(c.dim(", "))}`,
  );
  if (installed.length === 0) {
    lines.push(`  ${label("installed")}${c.gray("no")}`);
  } else {
    lines.push(`  ${label("installed")}${c.green(`yes (${installed.length})`)}`);
    for (const r of installed) {
      const where = r.scope === "global" ? "~" : homeRelative(r.projectPath ?? "?", home);
      lines.push(
        `${cont}${sym.ok} ${c.blue(r.cli)}${c.dim("/")}${r.scope} ${c.dim("@")} ${c.yellow(r.version)}   ${c.dim(where)}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderPlan(plan: ExecutionPlan, home: string): string {
  const add = c.green("+");
  const merge = c.yellow("~");
  const lines: string[] = [
    "",
    `  ${badge("DRY RUN", "yellow")}  ${c.bold(plan.harness)} ${c.yellow(`v${plan.version}`)} ${c.dim("→")} ${c.blue(plan.cli)}${c.dim("/")}${plan.scope}`,
    "",
  ];
  for (const f of plan.files) {
    lines.push(
      `  ${add} ${c.dim("file   ")} ${homeRelative(f.destAbs, home)}${f.renamedFrom ? c.dim(`  (was ${f.renamedFrom})`) : ""}`,
    );
  }
  for (const p of plan.payloads) {
    lines.push(`  ${add} ${c.dim("payload")} ${homeRelative(p.baseAbs, home)}/  ${c.dim(`(${p.files.length} files)`)}`);
  }
  for (const fr of plan.fragments) {
    const op = fr.fragment.op;
    const label = op.type === "hook" ? `hook ${op.event}${op.matcher ? `[${op.matcher}]` : ""}` : `mcp ${op.name}`;
    lines.push(`  ${merge} ${c.dim("merge  ")} ${label} ${c.dim("→")} ${homeRelative(fr.targetAbs, home)}`);
  }
  if (plan.delegate) {
    lines.push(
      `  ${c.yellow("!")} ${c.dim("delegated")} runs upstream installer on your machine ${c.dim(`(needs --trust; ${homeRelative(plan.delegate.dir, home)})`)}`,
      `      ${c.dim("$")} ${plan.delegate.installCmd}`,
    );
  }
  for (const n of plan.notes) lines.push(`  ${sym.warn} ${c.dim(n)}`);
  lines.push("", `  ${c.dim("(dry run — nothing written)")}`, "");
  return lines.join("\n");
}
