import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getAdapter } from "@weft/adapters";
import { sha256OfValue } from "@weft/schema";
import type { CliId, MergeFragment, Scope, Sha256 } from "@weft/schema";
import { installPlan, resolveCtx, uninstallReceipt } from "../src/index";
import type { ExecutionPlan, WeftEnv } from "../src/index";

// statusLine is a SINGLE-VALUE settings key (one object), unlike the hooks/mcpServers collections:
//  • absent           → weft sets it
//  • user already set → weft does NOT overwrite (warns), and uninstall leaves it
//  • weft's own       → removed on uninstall (verify-by-hash), coexisting hooks/keys preserved

const DUMMY_SHA = `sha256:${"0".repeat(64)}` as Sha256;
const cleanup: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), p));
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
function slFrag(id: string, value: unknown): MergeFragment {
  return { id, mergeInto: "statusLine", op: { type: "statusLine", value }, valueSha: sha256OfValue(value) };
}
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
const slTarget = (env: WeftEnv, cli: CliId, scope: Scope): string =>
  getAdapter(cli).configFilePath("statusLine", scope, resolveCtx(env));

const WEFT_SL = { type: "command", command: "bash /x/caveman-statusline.sh", padding: 0 };
const USER_SL = { type: "command", command: "my-own-statusline.sh" };

describe("status-line merge into claude-code settings.json", () => {
  it("sets statusLine when absent and round-trips to nothing on uninstall", async () => {
    const env = makeEnv(tmp("sl-home-"), tmp("sl-cwd-"));
    const settings = slTarget(env, "claude-code", "global");
    const { receipt } = await install(env, "claude-code", "global", "rid-sl-1", [slFrag("s1", WEFT_SL)]);
    expect(JSON.parse(readFileSync(settings, "utf8")).statusLine).toEqual(WEFT_SL);

    await uninstallReceipt(env, getAdapter("claude-code"), receipt);
    expect(existsSync(settings)).toBe(false); // sole owner → file removed
  });

  it("never overwrites a user's existing statusLine and leaves it byte-identical on uninstall", async () => {
    const env = makeEnv(tmp("sl-home-"), tmp("sl-cwd-"));
    const settings = slTarget(env, "claude-code", "global");
    seed(settings, `${JSON.stringify({ statusLine: USER_SL }, null, 2)}\n`);
    const before = readFileSync(settings, "utf8");

    const res = await install(env, "claude-code", "global", "rid-sl-2", [slFrag("s1", WEFT_SL)]);
    expect(res.warnings.some((w) => w.includes("statusLine already set"))).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8")).statusLine).toEqual(USER_SL); // user's kept

    await uninstallReceipt(env, getAdapter("claude-code"), res.receipt);
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  it("coexists with a user's hooks in settings.json; uninstall removes only statusLine", async () => {
    const env = makeEnv(tmp("sl-home-"), tmp("sl-cwd-"));
    const settings = slTarget(env, "claude-code", "global");
    seed(
      settings,
      `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "user-hook" }] }] } }, null, 2)}\n`,
    );

    const { receipt } = await install(env, "claude-code", "global", "rid-sl-3", [slFrag("s1", WEFT_SL)]);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.statusLine).toEqual(WEFT_SL);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe("user-hook");

    await uninstallReceipt(env, getAdapter("claude-code"), receipt);
    const final = JSON.parse(readFileSync(settings, "utf8"));
    expect(final.statusLine).toBeUndefined(); // weft's removed
    expect(final.hooks.SessionStart[0].hooks[0].command).toBe("user-hook"); // user's hook preserved
  });
});
