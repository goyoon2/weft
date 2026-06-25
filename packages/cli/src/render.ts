import type { Receipt } from "@weft/schema";
import type { ExecutionPlan, SearchHit } from "@weft/core";

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function homeRelative(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? path.replace(home, "~") : path;
}

export function renderSearch(hits: SearchHit[]): string {
  if (hits.length === 0) return "No matching harnesses.";
  return hits
    .map((h) => `  ${h.entry.id}  ·  ${h.entry.displayName} — ${truncate(h.entry.description, 64)}  [${h.entry.clis.join(", ")}]  v${h.entry.latest}`)
    .join("\n");
}

export function renderList(receipts: Receipt[], home: string): string {
  if (receipts.length === 0) return "Nothing installed.";
  const rows = receipts.map((r) => [
    r.harness,
    r.version,
    r.cli,
    r.scope,
    r.scope === "global" ? "~" : homeRelative(r.projectPath ?? "(unknown)", home),
  ]);
  const headers = ["HARNESS", "VERSION", "CLI", "SCOPE", "LOCATION"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

export function renderInfo(entry: { id: string; displayName: string; description: string; homepage?: string; latest: string; clis: string[]; versions: { version: string }[] }, installed: Receipt[], home: string): string {
  const lines = [
    `${entry.id}  (${entry.displayName})`,
    `  ${entry.description}`,
  ];
  if (entry.homepage) lines.push(`  homepage: ${entry.homepage}`);
  lines.push(`  CLIs: ${entry.clis.join(", ")}`);
  lines.push(`  versions: ${entry.versions.map((v) => (v.version === entry.latest ? `${v.version} (latest)` : v.version)).join(", ")}`);
  if (installed.length === 0) {
    lines.push("  installed: no");
  } else {
    lines.push("  installed:");
    for (const r of installed) {
      const where = r.scope === "global" ? "~" : homeRelative(r.projectPath ?? "?", home);
      lines.push(`    - ${r.cli}/${r.scope} @ ${r.version}  ${where}`);
    }
  }
  return lines.join("\n");
}

export function renderPlan(plan: ExecutionPlan, home: string): string {
  const lines = [`plan: ${plan.harness} ${plan.version} → ${plan.cli}/${plan.scope}`];
  for (const f of plan.files) lines.push(`  file    ${homeRelative(f.destAbs, home)}${f.renamedFrom ? `  (was ${f.renamedFrom})` : ""}`);
  for (const p of plan.payloads) {
    lines.push(`  payload ${homeRelative(p.baseAbs, home)}/  (${p.files.length} files)`);
  }
  for (const fr of plan.fragments) {
    const op = fr.fragment.op;
    const label = op.type === "hook" ? `hook ${op.event}${op.matcher ? `[${op.matcher}]` : ""}` : `mcp ${op.name}`;
    lines.push(`  merge   ${label} → ${homeRelative(fr.targetAbs, home)}`);
  }
  for (const n of plan.notes) lines.push(`  note: ${n}`);
  lines.push("(dry run — nothing written)");
  return lines.join("\n");
}
