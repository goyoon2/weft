import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { sha256OfFile } from "@weft/schema";
import type { Spool } from "@weft/schema";
import { buildHarness } from "../src/index";
import { gsdFixtureDir, gsdPattern } from "./fixtures/gsd-pattern";

const out = mkdtempSync(join(tmpdir(), "weft-mill-test-"));

const resultP = buildHarness(gsdPattern, { outDir: out, sourceDir: gsdFixtureDir });

function globalSpool(spools: { scope: string; spool: Spool }[]): Spool {
  const s = spools.find((x) => x.scope === "global");
  if (!s) throw new Error("no global spool");
  return s.spool;
}

describe("loom buildHarness (gsd-core fixture)", () => {
  it("builds one spool per scope at the fixture version", async () => {
    const result = await resultP;
    expect(result.version).toBe("1.5.0");
    expect(result.spools.map((s) => `${s.cli}.${s.scope}`).sort()).toEqual([
      "claude-code.global",
      "claude-code.local",
    ]);
  });

  it("maps agents and flattens commands to gsd-<name>", async () => {
    const spool = globalSpool((await resultP).spools);
    const agents = spool.files.filter((f) => f.slot === "agent").map((f) => f.destRel).sort();
    expect(agents).toEqual(["gsd-planner.md", "gsd-reviewer.md"]);

    const commands = spool.files.filter((f) => f.slot === "command").map((f) => f.destRel).sort();
    expect(commands).toEqual(["gsd-execute.md", "gsd-plan.md"]);

    const planner = spool.files.find((f) => f.destRel === "gsd-planner.md");
    expect(planner?.frontmatterName).toBe("gsd-planner");
  });

  it("collects the out-of-tree runtime + hook scripts into one payload", async () => {
    const spool = globalSpool((await resultP).spools);
    expect(spool.payloads).toHaveLength(1);
    const payload = spool.payloads[0]!;
    expect(payload.id).toBe("gsd-core");
    expect(payload.baseRel).toBe("gsd-core");
    const rels = payload.entries.map((e) => e.rel).sort();
    expect(rels).toEqual([
      "gsd-core/VERSION",
      "gsd-core/bin/gsd-run",
      "gsd-core/contexts/base.md",
      "hooks/gsd-context.js",
      "hooks/gsd-guard.js",
      "hooks/hooks.json",
    ]);
  });

  it("explodes hooks.json into one fragment per command, rewriting the plugin-root token", async () => {
    const spool = globalSpool((await resultP).spools);
    expect(spool.fragments).toHaveLength(3);

    const events = spool.fragments.map((f) => (f.op.type === "hook" ? f.op.event : "")).sort();
    expect(events).toEqual(["PostToolUse", "PreToolUse", "SessionStart"]);

    for (const frag of spool.fragments) {
      const cmd = frag.op.type === "hook" ? JSON.stringify(frag.op.command) : "";
      expect(cmd).not.toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(cmd).toContain("{{WEFT_PAYLOAD_DIR}}");
    }

    const pre = spool.fragments.find((f) => f.op.type === "hook" && f.op.event === "PreToolUse");
    expect(pre && pre.op.type === "hook" ? pre.op.matcher : undefined).toBe("Write|Edit");

    expect(spool.placeholders).toEqual(["WEFT_PAYLOAD_DIR"]);
  });

  it("writes a verifiable tar.gz spool whose hash matches the index ref", async () => {
    const result = await resultP;
    const built = result.spools.find((s) => s.scope === "global")!;
    expect(existsSync(built.tgzPath)).toBe(true);
    expect(await sha256OfFile(built.tgzPath)).toBe(built.spoolSha);
  });

  it("is content-deterministic (archiveSha stable across builds)", async () => {
    const out2 = mkdtempSync(join(tmpdir(), "weft-mill-test2-"));
    const again = await buildHarness(gsdPattern, { outDir: out2, sourceDir: gsdFixtureDir });
    expect(globalSpool(again.spools).archiveSha).toBe(globalSpool((await resultP).spools).archiveSha);
  });
});
