import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHarness } from "@weft/loom";
import type { BuiltSpool } from "@weft/loom";
import type { Index, IndexVersion } from "@weft/schema";
import { gsdFixtureDir, gsdPattern } from "../../loom/test/fixtures/gsd-pattern";
import {
  installHarness,
  listInstalled,
  searchOp,
  uninstallHarness,
  updateIndex,
  upgradeAll,
  upgradeHarness,
} from "../src/index";
import type { WeftEnv } from "../src/index";

function versionRef(spools: BuiltSpool[], version: string): IndexVersion {
  return {
    version,
    spools: spools.map((s) => ({
      cli: s.cli,
      scope: s.scope,
      url: pathToFileURL(s.tgzPath).href,
      spoolSha: s.spoolSha,
      spoolJsonSha: s.spoolJsonSha,
    })),
  };
}

function writeIndex(millDir: string, versions: IndexVersion[], latest: string): string {
  const index: Index = {
    schema: 1,
    generatedAt: "2026-06-25T00:00:00.000Z",
    entries: [
      {
        id: gsdPattern.id,
        displayName: gsdPattern.displayName,
        description: gsdPattern.description,
        homepage: gsdPattern.homepage,
        keywords: gsdPattern.keywords ?? [],
        latest,
        clis: ["claude-code"],
        versions,
      },
    ],
  };
  const path = join(millDir, "index.json");
  writeIndex.path = path;
  writeFileSync(path, JSON.stringify(index, null, 2));
  return path;
}
writeIndex.path = "";

function makeEnv(home: string, cwd: string, indexSource: string): WeftEnv {
  return { home, weftDir: join(home, ".weft"), cwd, millIndexSource: indexSource, weftVersion: "test" };
}

const cleanup: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

// ── shared v1 mill (1.5.0) ──
let indexSource: string;
beforeAll(async () => {
  const mill = tmp("weft-mill-");
  const result = await buildHarness(gsdPattern, { outDir: mill, sourceDir: gsdFixtureDir });
  indexSource = writeIndex(mill, [versionRef(result.spools, result.version)], "1.5.0");
});

describe("update + search", () => {
  it("pulls the index and finds gsd-core (incl. typo + cli alias)", () => {
    const env = makeEnv(tmp("weft-home-"), tmp("weft-cwd-"), indexSource);
    expect(updateIndex(env).entries).toBe(1);
    expect(searchOp(env, "gsd").map((h) => h.entry.id)).toContain("gsd-core");
    expect(searchOp(env, "gsd-cor").map((h) => h.entry.id)).toContain("gsd-core");
    expect(searchOp(env, "cluade").map((h) => h.entry.id)).toContain("gsd-core"); // alias → claude-code
  });
});

describe("install + uninstall (global)", () => {
  const home = () => env.home;
  let env: WeftEnv;
  beforeAll(() => {
    env = makeEnv(tmp("weft-home-"), tmp("weft-cwd-"), indexSource);
  });

  it("installs gsd-core for claude-code/global", async () => {
    const res = await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(res.status).toBe("installed");

    const claude = join(home(), ".claude");
    expect(existsSync(join(claude, "agents", "gsd-planner.md"))).toBe(true);
    expect(existsSync(join(claude, "agents", "gsd-reviewer.md"))).toBe(true);
    // command flattened to gsd-<name>
    expect(existsSync(join(claude, "commands", "gsd-plan.md"))).toBe(true);
    expect(existsSync(join(claude, "commands", "gsd-execute.md"))).toBe(true);
  });

  it("rewrites the plugin-root token to a real absolute path (no residue)", () => {
    const claude = join(home(), ".claude");
    const guard = readFileSync(join(claude, "gsd-core", "hooks", "gsd-guard.js"), "utf8");
    expect(guard).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(guard).not.toContain("{{WEFT_PAYLOAD_DIR}}");
    expect(guard).toContain(join(claude, "gsd-core"));
  });

  it("merges hooks into settings.json with absolute commands", () => {
    const settings = JSON.parse(readFileSync(join(home(), ".claude", "settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse[0];
    expect(pre.matcher).toBe("Write|Edit");
    const cmd = pre.hooks[0].command as string;
    expect(cmd).toContain(join(home(), ".claude", "gsd-core", "hooks", "gsd-guard.js"));
    expect(cmd).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart"]);
  });

  it("lists the install and is idempotent", async () => {
    const list = listInstalled(env);
    expect(list).toHaveLength(1);
    expect(list[0]?.harness).toBe("gsd-core");
    expect(list[0]?.version).toBe("1.5.0");

    const again = await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(again.status).toBe("already-installed");
  });

  it("uninstalls cleanly, leaving no trace", async () => {
    const res = await uninstallHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(res.status).toBe("uninstalled");
    expect(existsSync(join(home(), ".claude"))).toBe(false); // pruned to nothing
    expect(listInstalled(env)).toHaveLength(0);
  });
});

describe("dry-run writes nothing", () => {
  it("plans without touching disk", async () => {
    const env = makeEnv(tmp("weft-home-"), tmp("weft-cwd-"), indexSource);
    const res = await installHarness(env, {
      harness: "gsd-core",
      cli: "claude-code",
      scope: "global",
      dryRun: true,
    });
    expect(res.status).toBe("planned");
    if (res.status === "planned") {
      expect(res.plan.files.length).toBeGreaterThan(0);
      expect(res.plan.notes.some((n) => n.includes("commands install as"))).toBe(true);
    }
    expect(existsSync(join(env.home, ".claude"))).toBe(false);
    expect(listInstalled(env)).toHaveLength(0);
  });
});

describe("local scope keys by project realpath", () => {
  it("installs into cwd/.claude and uninstalls", async () => {
    const home = tmp("weft-home-");
    const project = tmp("weft-proj-");
    const env = makeEnv(home, project, indexSource);

    const res = await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "local" });
    expect(res.status).toBe("installed");
    expect(existsSync(join(project, ".claude", "agents", "gsd-planner.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(true);
    if (res.status === "installed") {
      expect(res.receipt.scopeKey).toMatch(/^local:sha256:/);
      expect(res.receipt.projectPath).toBeTruthy();
    }
    // a different cwd does not see the local install
    expect(listInstalled({ ...env, cwd: tmp("weft-other-") })).toHaveLength(0);
    expect(listInstalled(env)).toHaveLength(1);

    await uninstallHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "local" });
    expect(existsSync(join(project, ".claude"))).toBe(false);
    expect(existsSync(project)).toBe(true); // project root itself preserved
  });
});

describe("upgrade applies a version delta", () => {
  it("moves 1.5.0 → 1.6.0: adds new files, removes dropped ones, rewrites hooks", async () => {
    // Build a v1.6.0 source: add an agent, drop a command, change a hook script.
    const v2src = tmp("weft-v2src-");
    cpSync(gsdFixtureDir, v2src, { recursive: true });
    writeFileSync(join(v2src, "package.json"), JSON.stringify({ name: "@opengsd/gsd-core", version: "1.6.0" }));
    writeFileSync(join(v2src, "agents", "gsd-tester.md"), "---\nname: gsd-tester\n---\nTester.\n");
    rmSync(join(v2src, "commands", "gsd", "execute.md"));
    writeFileSync(join(v2src, "hooks", "gsd-guard.js"), '#!/usr/bin/env node\n// v2\nconsole.error("${CLAUDE_PLUGIN_ROOT}");\n');

    const mill = tmp("weft-mill2-");
    const v1 = await buildHarness(gsdPattern, { outDir: mill, sourceDir: gsdFixtureDir, version: "1.5.0" });
    const v2 = await buildHarness(gsdPattern, { outDir: mill, sourceDir: v2src, version: "1.6.0" });
    const idx = writeIndex(
      mill,
      [versionRef(v1.spools, "1.5.0"), versionRef(v2.spools, "1.6.0")],
      "1.6.0",
    );

    const home = tmp("weft-home-");
    const env = makeEnv(home, tmp("weft-cwd-"), idx);
    await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global", version: "1.5.0" });

    const claude = join(home, ".claude");
    expect(existsSync(join(claude, "commands", "gsd-execute.md"))).toBe(true);

    const up = await upgradeHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(up.status).toBe("upgraded");
    if (up.status === "upgraded") {
      expect(up.from).toBe("1.5.0");
      expect(up.to).toBe("1.6.0");
    }
    expect(existsSync(join(claude, "agents", "gsd-tester.md"))).toBe(true); // added
    expect(existsSync(join(claude, "commands", "gsd-execute.md"))).toBe(false); // removed
    expect(listInstalled(env)[0]?.version).toBe("1.6.0");

    // uninstall after upgrade is still clean
    await uninstallHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(existsSync(claude)).toBe(false);
  });

  it("upgradeAll upgrades local installs in EVERY project, each in its own folder", async () => {
    const v2src = tmp("weft-v2src-all-");
    cpSync(gsdFixtureDir, v2src, { recursive: true });
    writeFileSync(join(v2src, "package.json"), JSON.stringify({ name: "@opengsd/gsd-core", version: "1.6.0" }));
    writeFileSync(join(v2src, "agents", "gsd-tester.md"), "---\nname: gsd-tester\n---\nTester.\n");

    const mill = tmp("weft-mill-all-");
    const v1 = await buildHarness(gsdPattern, { outDir: mill, sourceDir: gsdFixtureDir, version: "1.5.0" });
    const v2 = await buildHarness(gsdPattern, { outDir: mill, sourceDir: v2src, version: "1.6.0" });
    const idx = writeIndex(mill, [versionRef(v1.spools, "1.5.0"), versionRef(v2.spools, "1.6.0")], "1.6.0");

    const home = tmp("weft-home-all-");
    const projA = tmp("weft-projA-");
    const projB = tmp("weft-projB-");
    const envA = makeEnv(home, projA, idx);
    const envB = makeEnv(home, projB, idx);

    // Install 1.5.0 locally in two SEPARATE project folders.
    await installHarness(envA, { harness: "gsd-core", cli: "claude-code", scope: "local", version: "1.5.0" });
    await installHarness(envB, { harness: "gsd-core", cli: "claude-code", scope: "local", version: "1.5.0" });
    expect(existsSync(join(projB, ".claude", "agents", "gsd-tester.md"))).toBe(false);

    // Run upgradeAll from projA's cwd — it must upgrade BOTH projects, writing into each one's dir.
    const { outcomes } = await upgradeAll(envA, { harness: "gsd-core" });
    expect(outcomes.filter((o) => o.status === "upgraded")).toHaveLength(2);
    expect(existsSync(join(projA, ".claude", "agents", "gsd-tester.md"))).toBe(true);
    expect(existsSync(join(projB, ".claude", "agents", "gsd-tester.md"))).toBe(true); // other folder upgraded in place
    expect(listInstalled(envB)[0]?.version).toBe("1.6.0");

    // Idempotent: a second pass finds everything already current.
    const again = await upgradeAll(envA, { harness: "gsd-core" });
    expect(again.outcomes.every((o) => o.status === "up-to-date")).toBe(true);
  });
});
