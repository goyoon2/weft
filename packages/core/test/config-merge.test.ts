import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getAdapter } from "@weft/adapters";
import { sha256OfValue } from "@weft/schema";
import type { CliId, MergeFragment, Scope, Sha256 } from "@weft/schema";
import { installPlan, resolveCtx, uninstallReceipt } from "../src/index";
import type { ExecutionPlan, WeftEnv } from "../src/index";

// End-to-end proof of the merge contract a host CLI's shared config must honor:
//  • absent file        → created on install
//  • pre-existing file  → merged into, never overwritten (foreign keys survive)
//  • uninstall          → removes ONLY weft's own entries (verified by value hash)
//  • file emptied        → deleted; file with surviving foreign content → kept
// The adapter unit tests prove this in memory; here we drive the real installPlan/uninstallReceipt
// transaction against on-disk files, for a JSON CLI (claude-code) and a TOML CLI (codex).

const DUMMY_SHA = `sha256:${"0".repeat(64)}` as Sha256;

const cleanup: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function makeEnv(home: string, cwd: string): WeftEnv {
  return { home, weftDir: join(home, ".weft"), cwd, millIndexSource: "unused", weftVersion: "test" };
}

function seed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function hookFrag(id: string, event: string, matcher: string | undefined, command: unknown): MergeFragment {
  return { id, mergeInto: "hooks", op: { type: "hook", event, matcher, command }, valueSha: sha256OfValue(command) };
}
function mcpFrag(id: string, name: string, value: unknown): MergeFragment {
  return { id, mergeInto: "mcpServers", op: { type: "mcpServer", name, value }, valueSha: sha256OfValue(value) };
}

/** Build a fragments-only plan (no placed files/payloads) and apply it through the real transaction. */
async function install(env: WeftEnv, cli: CliId, scope: Scope, receiptId: string, frags: MergeFragment[]) {
  const adapter = getAdapter(cli);
  const ctx = resolveCtx(env);
  const fragments = frags.map((fragment) => ({
    fragment,
    targetAbs: adapter.configFilePath(fragment.mergeInto, scope, ctx),
  }));
  const plan: ExecutionPlan = {
    harness: "wefttest",
    version: "1.0.0",
    cli,
    scope,
    scopeKey: scope === "global" ? "global" : "local:test",
    receiptId,
    spoolSha: DUMMY_SHA,
    resolvedPlaceholders: {},
    files: [],
    payloads: [],
    fragments,
    configTargets: [...new Set(fragments.map((f) => f.targetAbs))],
    notes: [],
  };
  return installPlan(env, adapter, plan);
}

const target = (env: WeftEnv, cli: CliId, scope: Scope, into: "hooks" | "mcpServers"): string =>
  getAdapter(cli).configFilePath(into, scope, resolveCtx(env));

// ───────────────────────────── JSON CLI (claude-code) ─────────────────────────────

describe("claude-code: hooks merge into a pre-existing settings.json", () => {
  const weftCmd = { type: "command", command: "node /weft/guard.js", timeout: 5 };
  const userCmd = { type: "command", command: "echo user-owned" };

  it("preserves an unrelated top-level key AND a foreign hook group, then reverses to exactly the original", async () => {
    const env = makeEnv(tmp("cfg-home-"), tmp("cfg-proj-"));
    const settings = target(env, "claude-code", "local", "hooks");
    // The user already has settings.json with NON-hook config + their own hook in the same event.
    const original = {
      model: "opus",
      permissions: { allow: ["Bash"] },
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [userCmd] }] },
    };
    seed(settings, `${JSON.stringify(original, null, 2)}\n`);

    const { receipt } = await install(env, "claude-code", "local", "rid-cc-hooks", [
      hookFrag("h1", "PreToolUse", "Write|Edit", weftCmd),
    ]);

    const merged = JSON.parse(readFileSync(settings, "utf8"));
    expect(merged.model).toBe("opus"); // untouched
    expect(merged.permissions).toEqual({ allow: ["Bash"] }); // untouched
    expect(merged.hooks.PreToolUse).toHaveLength(2); // user's "Read" group + weft's "Write|Edit" group
    expect(merged.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === "Read").hooks).toEqual([userCmd]);

    await uninstallReceipt(env, getAdapter("claude-code"), receipt);

    // Exact reverse: byte-for-byte back to what the user had (weft's group gone, everything else intact).
    expect(existsSync(settings)).toBe(true); // NOT deleted — foreign content remains
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(original);
  });

  it("appends into the user's SAME matcher group and removes only its own command on uninstall", async () => {
    const env = makeEnv(tmp("cfg-home-"), tmp("cfg-proj-"));
    const settings = target(env, "claude-code", "local", "hooks");
    seed(settings, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [userCmd] }] } }, null, 2)}\n`);

    const { receipt } = await install(env, "claude-code", "local", "rid-cc-same", [
      hookFrag("h1", "PreToolUse", "Write", weftCmd),
    ]);
    const group = JSON.parse(readFileSync(settings, "utf8")).hooks.PreToolUse[0];
    expect(group.hooks).toEqual([userCmd, weftCmd]); // appended into the existing group, user's command first

    await uninstallReceipt(env, getAdapter("claude-code"), receipt);
    expect(JSON.parse(readFileSync(settings, "utf8")).hooks.PreToolUse[0].hooks).toEqual([userCmd]); // only weft's removed
  });
});

describe("claude-code: mcp merge into a pre-existing .mcp.json", () => {
  const weftServer = { command: "npx", args: ["-y", "@weft/mcp"] };
  const userServer = { command: "node", args: ["user-mcp.js"] };

  it("adds alongside a foreign server and removes only its own on uninstall", async () => {
    const env = makeEnv(tmp("cfg-home-"), tmp("cfg-proj-"));
    const mcp = target(env, "claude-code", "local", "mcpServers");
    seed(mcp, `${JSON.stringify({ mcpServers: { userctx: userServer } }, null, 2)}\n`);

    const { receipt } = await install(env, "claude-code", "local", "rid-cc-mcp", [
      mcpFrag("m1", "weftctx", weftServer),
    ]);
    expect(JSON.parse(readFileSync(mcp, "utf8")).mcpServers).toEqual({ userctx: userServer, weftctx: weftServer });

    await uninstallReceipt(env, getAdapter("claude-code"), receipt);
    expect(existsSync(mcp)).toBe(true); // kept — userctx still there
    expect(JSON.parse(readFileSync(mcp, "utf8"))).toEqual({ mcpServers: { userctx: userServer } });
  });
});

describe("claude-code: absent files are created, then deleted when weft is the only owner", () => {
  it("creates settings.json + .mcp.json on install and removes both on uninstall (round-trips to nothing)", async () => {
    const env = makeEnv(tmp("cfg-home-"), tmp("cfg-proj-"));
    const settings = target(env, "claude-code", "local", "hooks");
    const mcp = target(env, "claude-code", "local", "mcpServers");
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(mcp)).toBe(false);

    const { receipt } = await install(env, "claude-code", "local", "rid-cc-fresh", [
      hookFrag("h1", "PostToolUse", undefined, { type: "command", command: "node /weft/x.js" }),
      mcpFrag("m1", "weftctx", { command: "npx", args: ["@weft/mcp"] }),
    ]);
    expect(existsSync(settings)).toBe(true); // created
    expect(existsSync(mcp)).toBe(true); // created

    await uninstallReceipt(env, getAdapter("claude-code"), receipt);
    expect(existsSync(settings)).toBe(false); // weft was the sole content → file deleted
    expect(existsSync(mcp)).toBe(false);
  });
});

// ───────────────────────────── TOML CLI (codex) ─────────────────────────────

describe("codex: mcp merge into a pre-existing config.toml", () => {
  const weftServer = { command: "npx", args: ["-y", "@weft/mcp"] };

  it("preserves other settings + a foreign [mcp_servers.*] table and removes only its own", async () => {
    const env = makeEnv(tmp("cfg-home-"), tmp("cfg-cwd-"));
    const cfg = target(env, "codex", "global", "mcpServers"); // ~/.codex/config.toml
    seed(
      cfg,
      [
        "# user-authored codex config",
        'model = "gpt-5"',
        'approval_policy = "untrusted"',
        "",
        "[mcp_servers.userctx]",
        'command = "node"',
        'args = ["user-mcp.js"]',
        "",
      ].join("\n"),
    );

    const res = await install(env, "codex", "global", "rid-codex-mcp", [mcpFrag("m1", "weftctx", weftServer)]);
    const { receipt } = res;
    // The seeded config.toml has a comment smol-toml can't round-trip → weft warns, never silent.
    expect(res.warnings.some((w) => w.includes("normalized on write"))).toBe(true);

    const after = readFileSync(cfg, "utf8");
    expect(after).toContain('model = "gpt-5"'); // sibling settings preserved
    expect(after).toContain('approval_policy = "untrusted"');
    expect(after).toContain("[mcp_servers.userctx]"); // foreign server preserved
    expect(after).toContain("[mcp_servers.weftctx]"); // weft's server added

    await uninstallReceipt(env, getAdapter("codex"), receipt);
    const reverted = readFileSync(cfg, "utf8");
    expect(existsSync(cfg)).toBe(true); // kept — model + userctx remain
    expect(reverted).toContain('model = "gpt-5"');
    expect(reverted).toContain("[mcp_servers.userctx]");
    expect(reverted).not.toContain("weftctx"); // only weft's table removed

    // KNOWN LIMITATION (smol-toml is not comment-preserving): the whole config.toml is reparsed and
    // reserialized, so TOML comments do NOT survive a weft merge. Settings/tables are preserved; the
    // `# user-authored codex config` line is not. If comment-preserving TOML editing lands, flip this.
    expect(reverted).not.toContain("# user-authored codex config");
  });
});
