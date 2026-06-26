import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildHarness } from "@weft/loom";
import type { BuiltSpool } from "@weft/loom";
import { getAdapter } from "@weft/adapters";
import type { Index, IndexVersion, Spool } from "@weft/schema";
import { gsdFixtureDir, gsdPattern } from "../../loom/test/fixtures/gsd-pattern";
import { buildPlan, ghHeaders, installHarness, uninstallHarness, upgradeHarness } from "../src/index";
import type { WeftEnv } from "../src/index";

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
