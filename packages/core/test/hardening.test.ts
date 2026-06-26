import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildHarness } from "@weft/loom";
import type { BuiltSpool } from "@weft/loom";
import { getAdapter } from "@weft/adapters";
import { sha256OfBytes } from "@weft/schema";
import type { Index, IndexVersion, Sha256, Spool } from "@weft/schema";
import { gsdFixtureDir, gsdPattern } from "../../loom/test/fixtures/gsd-pattern";
import {
  buildPlan,
  ghHeaders,
  installHarness,
  installPlan,
  listInstalled,
  stateDirs,
  uninstallHarness,
  uninstallReceipt,
  upgradeHarness,
} from "../src/index";
import type { ExecutionPlan, WeftEnv } from "../src/index";

const cleanup: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function makeEnv(home: string, cwd: string, indexSource: string): WeftEnv {
  return { home, weftDir: join(home, ".weft"), cwd, millIndexSource: indexSource, weftVersion: "test" };
}

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
  writeFileSync(path, JSON.stringify(index, null, 2));
  return pathToFileURL(path).href;
}

// ── path traversal: a hostile spool path must never write outside its slot root ─────────────────

describe("spool path containment (buildPlan)", () => {
  const home = tmp("weft-trav-home-");
  const fetched = tmp("weft-trav-fetched-");
  const env = makeEnv(home, tmp("weft-trav-cwd-"), "unused");
  const adapter = getAdapter("claude-code");
  const base: Omit<Spool, "files" | "payloads"> = {
    schema: 1,
    harness: "evil",
    version: "1.0.0",
    cli: "claude-code",
    scope: "global",
    builtAt: "2026-01-01T00:00:00.000Z",
    fragments: [],
    placeholders: [],
    archiveSha: `sha256:${"0".repeat(64)}`,
  };
  const plan = (spool: Spool): Promise<unknown> =>
    buildPlan({
      env,
      ctx: { home, projectRoot: env.cwd },
      scope: "global",
      scopeKey: "global",
      adapter,
      spool,
      spoolSha: `sha256:${"0".repeat(64)}`,
      fetchedDir: fetched,
      receiptId: "r1",
    });

  it("refuses a file destRel that escapes the slot root via ..", async () => {
    const spool: Spool = {
      ...base,
      files: [
        {
          slot: "command",
          destRel: "../../../../../../tmp/weft-pwned.md",
          archivePath: "files/commands/x.md",
          sha: `sha256:${"0".repeat(64)}`,
          logicalName: "x",
        },
      ],
      payloads: [],
    };
    await expect(plan(spool)).rejects.toThrow(/escapes|refusing/);
  });

  it("refuses an absolute file destRel", async () => {
    const spool: Spool = {
      ...base,
      files: [
        {
          slot: "command",
          destRel: "/etc/cron.d/weft-pwned",
          archivePath: "files/commands/x.md",
          sha: `sha256:${"0".repeat(64)}`,
          logicalName: "x",
        },
      ],
      payloads: [],
    };
    await expect(plan(spool)).rejects.toThrow(/absolute|refusing/);
  });

  it("refuses a payload baseRel that escapes the payload base", async () => {
    const spool: Spool = {
      ...base,
      files: [],
      payloads: [{ id: "p", baseRel: "../../../../tmp/weft-pwned", archiveDir: "payloads/p", entries: [] }],
    };
    await expect(plan(spool)).rejects.toThrow(/escapes|refusing/);
  });

  it("accepts an ordinary nested destRel (no false positive)", async () => {
    const spool: Spool = {
      ...base,
      files: [
        {
          slot: "command",
          destRel: "gsd/plan.md",
          archivePath: "files/commands/gsd/plan.md",
          sha: `sha256:${"0".repeat(64)}`,
          logicalName: "gsd/plan",
        },
      ],
      payloads: [],
    };
    await expect(plan(spool)).resolves.toBeTruthy();
  });
});

// ── foreign-file restore across the full lifecycle (shadow honored on file + payload) ───────────

describe("user file preservation (shadow restore)", () => {
  let indexSource: string;
  let upgradeIndex: string;
  beforeAll(async () => {
    const mill = tmp("weft-hard-mill-");
    const v1 = await buildHarness(gsdPattern, { outDir: mill, sourceDir: gsdFixtureDir, version: "1.5.0" });
    indexSource = writeIndex(mill, [versionRef(v1.spools, "1.5.0")], "1.5.0");

    // v1.6.0 source: keep commands/gsd/plan.md (so its path stays owned across the upgrade), bump version.
    const v2src = tmp("weft-hard-v2-");
    cpSync(gsdFixtureDir, v2src, { recursive: true });
    writeFileSync(join(v2src, "package.json"), JSON.stringify({ name: "@opengsd/gsd-core", version: "1.6.0" }));
    const mill2 = tmp("weft-hard-mill2-");
    const a = await buildHarness(gsdPattern, { outDir: mill2, sourceDir: gsdFixtureDir, version: "1.5.0" });
    const b = await buildHarness(gsdPattern, { outDir: mill2, sourceDir: v2src, version: "1.6.0" });
    upgradeIndex = writeIndex(mill2, [versionRef(a.spools, "1.5.0"), versionRef(b.spools, "1.6.0")], "1.6.0");
  });

  it("restores a pre-existing command file on uninstall (file shadow)", async () => {
    const home = tmp("weft-hard-home-");
    const env = makeEnv(home, tmp("weft-hard-cwd-"), indexSource);
    const cmd = join(home, ".claude", "commands", "gsd-plan.md");
    mkdirSync(dirname(cmd), { recursive: true });
    writeFileSync(cmd, "MY ORIGINAL NOTES");

    await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global", version: "1.5.0" });
    expect(readFileSync(cmd, "utf8")).not.toBe("MY ORIGINAL NOTES"); // weft owns it now

    await uninstallHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(existsSync(cmd)).toBe(true);
    expect(readFileSync(cmd, "utf8")).toBe("MY ORIGINAL NOTES"); // restored, not deleted
  });

  it("restores a pre-existing file even after an upgrade (shadow carried forward)", async () => {
    const home = tmp("weft-hard-home-up-");
    const env = makeEnv(home, tmp("weft-hard-cwd-up-"), upgradeIndex);
    const cmd = join(home, ".claude", "commands", "gsd-plan.md");
    mkdirSync(dirname(cmd), { recursive: true });
    writeFileSync(cmd, "MY ORIGINAL NOTES");

    await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global", version: "1.5.0" });
    const up = await upgradeHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(up.status).toBe("upgraded");

    await uninstallHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(existsSync(cmd)).toBe(true);
    expect(readFileSync(cmd, "utf8")).toBe("MY ORIGINAL NOTES"); // would be deleted without the carry-forward fix
  });

  it("restores a pre-existing payload file on uninstall (payload shadow)", async () => {
    const home = tmp("weft-hard-home-pl-");
    const env = makeEnv(home, tmp("weft-hard-cwd-pl-"), indexSource);
    const payloadFile = join(home, ".claude", "gsd-core", "hooks", "gsd-context.js");
    mkdirSync(dirname(payloadFile), { recursive: true });
    writeFileSync(payloadFile, "USER PAYLOAD ORIGINAL");

    await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global", version: "1.5.0" });
    expect(readFileSync(payloadFile, "utf8")).not.toBe("USER PAYLOAD ORIGINAL");

    await uninstallHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global" });
    expect(existsSync(payloadFile)).toBe(true);
    expect(readFileSync(payloadFile, "utf8")).toBe("USER PAYLOAD ORIGINAL"); // restored, not deleted
  });
});

// ── auth token is scoped to real GitHub hosts over HTTPS only ───────────────────────────────────

describe("ghHeaders token scoping", () => {
  const keys = ["WEFT_GH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.WEFT_GH_TOKEN = "secret-token";
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("sends the bearer token to real github hosts over https", () => {
    expect(ghHeaders("https://raw.githubusercontent.com/o/r/main/index.json").Authorization).toBe("Bearer secret-token");
    expect(ghHeaders("https://objects.githubusercontent.com/x").Authorization).toBe("Bearer secret-token");
    expect(ghHeaders("https://github.com/o/r").Authorization).toBe("Bearer secret-token");
    expect(ghHeaders("https://api.github.com/repos/o/r").Authorization).toBe("Bearer secret-token");
  });

  it("never sends the token to lookalike/typosquat hosts", () => {
    expect(ghHeaders("https://rawgithubusercontent.com/o/r/x").Authorization).toBeUndefined();
    expect(ghHeaders("https://evil-githubusercontent.com/x").Authorization).toBeUndefined();
    expect(ghHeaders("https://github.com.attacker.com/x").Authorization).toBeUndefined();
    expect(ghHeaders("https://notgithub.com/x").Authorization).toBeUndefined();
  });

  it("never sends the token over plaintext http", () => {
    expect(ghHeaders("http://raw.githubusercontent.com/o/r/x").Authorization).toBeUndefined();
  });
});

// ── pruneEmptyDirs stops at the receipt's OWN project root, never another project's tree ─────────

describe("prune boundary is the receipt's project, not the cwd", () => {
  let indexSource: string;
  beforeAll(async () => {
    const mill = tmp("weft-prune-mill-");
    const v1 = await buildHarness(gsdPattern, { outDir: mill, sourceDir: gsdFixtureDir, version: "1.5.0" });
    indexSource = writeIndex(mill, [versionRef(v1.spools, "1.5.0")], "1.5.0");
  });

  it("uninstalling a local receipt from a DIFFERENT cwd leaves that project's folder intact", async () => {
    const home = tmp("weft-prune-home-");
    const projA = tmp("weft-prune-projA-"); // the cwd we run from
    const projB = tmp("weft-prune-projB-"); // where the install actually lives (otherwise empty)

    const envB = makeEnv(home, projB, indexSource);
    await installHarness(envB, { harness: "gsd-core", cli: "claude-code", scope: "local", version: "1.5.0" });
    const receipt = listInstalled(envB).find((r) => r.scope === "local");
    if (!receipt) throw new Error("expected a local receipt");
    expect(existsSync(join(projB, ".claude"))).toBe(true);

    // Run uninstall with cwd = projA (NOT projB). With the old cwd-based boundary, pruneEmptyDirs would
    // walk up past the now-empty projB and rmdir it; with the fix it stops at the receipt's projectPath.
    const envA = makeEnv(home, projA, indexSource);
    await uninstallReceipt(envA, getAdapter("claude-code"), receipt);

    expect(existsSync(join(projB, ".claude"))).toBe(false); // the install dir was cleaned
    expect(existsSync(projB)).toBe(true); // but the project folder itself must survive
  });
});

// ── a mid-transaction failure rolls back the shadow backup too (no orphan) ───────────────────────

describe("shadow backup is journaled by the transaction", () => {
  it("rolls back the backup blob and restores the original when a later file fails integrity", async () => {
    const home = tmp("weft-txbk-home-");
    const fetched = tmp("weft-txbk-fetched-");
    const env = makeEnv(home, tmp("weft-txbk-cwd-"), "unused");

    writeFileSync(join(fetched, "a.md"), "AAA");
    writeFileSync(join(fetched, "b.md"), "BBB");
    const shaA = sha256OfBytes("AAA");
    const bad = `sha256:${"0".repeat(64)}` as Sha256; // wrong sha for b.md → writePlaced throws

    const destA = join(home, ".claude", "agents", "a.md");
    mkdirSync(dirname(destA), { recursive: true });
    writeFileSync(destA, "ORIGINAL-A"); // a pre-existing foreign file → will be shadowed
    const backupPath = join(stateDirs(env).backups, "rid", "files", "a.md");

    const plan: ExecutionPlan = {
      harness: "t",
      version: "1.0.0",
      cli: "claude-code",
      scope: "global",
      scopeKey: "global",
      receiptId: "rid",
      spoolSha: bad,
      resolvedPlaceholders: {},
      files: [
        {
          artifact: { slot: "agent", destRel: "a.md", archivePath: "a.md", sha: shaA, logicalName: "a" },
          srcAbs: join(fetched, "a.md"),
          destAbs: destA,
          expectedSrcSha: shaA,
          shadow: { backupPath, originalSha: sha256OfBytes("ORIGINAL-A") },
        },
        {
          artifact: { slot: "agent", destRel: "b.md", archivePath: "b.md", sha: bad, logicalName: "b" },
          srcAbs: join(fetched, "b.md"),
          destAbs: join(home, ".claude", "agents", "b.md"),
          expectedSrcSha: bad,
        },
      ],
      payloads: [],
      fragments: [],
      configTargets: [],
      notes: [],
    };

    await expect(installPlan(env, getAdapter("claude-code"), plan)).rejects.toThrow(/integrity/);
    expect(readFileSync(destA, "utf8")).toBe("ORIGINAL-A"); // restored by rollback
    expect(existsSync(backupPath)).toBe(false); // backup was journaled → removed on rollback (no orphan)
  });
});

// ── the spool cache doesn't accumulate extracted/downloaded temp dirs ────────────────────────────

describe("spool cache is not leaked", () => {
  it("removes the extraction dir after a successful install", async () => {
    const mill = tmp("weft-cache-mill-");
    const v1 = await buildHarness(gsdPattern, { outDir: mill, sourceDir: gsdFixtureDir, version: "1.5.0" });
    const idx = writeIndex(mill, [versionRef(v1.spools, "1.5.0")], "1.5.0");
    const env = makeEnv(tmp("weft-cache-home-"), tmp("weft-cache-cwd-"), idx);

    await installHarness(env, { harness: "gsd-core", cli: "claude-code", scope: "global", version: "1.5.0" });

    const spools = stateDirs(env).spools;
    const leftover = existsSync(spools)
      ? readdirSync(spools).filter((n) => n.startsWith("spool-") || n.startsWith("dl-"))
      : [];
    expect(leftover).toEqual([]); // no orphaned spool-*/dl-* temp dirs
  });
});
