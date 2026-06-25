import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHarness } from "@weft/loom";
import type { HarnessPattern, Index } from "@weft/schema";
import { installHarness, installMatrix, uninstallHarness, updateIndex, upgradeHarness } from "../src/index";
import type { WeftEnv } from "../src/index";

// A harmless delegated (cask) harness: "install" writes a marker into {dir}; "uninstall" removes it.
// Proves the delegated runtime path — running a command on the user's machine, recording a receipt
// with the uninstall command, and delegating removal — without any network/binary download.
const caskPattern: HarnessPattern = {
  schema: 1,
  id: "fake-cask",
  displayName: "Fake Cask",
  description: "hermetic delegated test",
  source: { type: "git", url: "https://example.invalid/x", ref: "main" },
  versioning: { strategy: "semver" },
  livecheck: { skip: true, skipReason: "test fixture" },
  targets: {
    "claude-code": {
      strategy: "delegated",
      delegate: {
        installCmd: "mkdir -p {dir} && printf '%s' {version} > {dir}/marker",
        uninstallCmd: "rm -rf {dir}",
        dir: { global: "{home}/caskdir" },
        requires: [],
        summary: "writes a marker file",
      },
    },
  },
};

function makeEnv(home: string, indexSource: string): WeftEnv {
  return { home, weftDir: join(home, ".weft"), cwd: home, millIndexSource: indexSource, weftVersion: "test" };
}

describe("delegated (cask) install", () => {
  let home: string;
  let millDir: string;
  let env: WeftEnv;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "weft-cask-home-"));
    millDir = mkdtempSync(join(tmpdir(), "weft-cask-mill-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "weft-cask-src-"));

    const built = await buildHarness(caskPattern, { outDir: millDir, sourceDir, version: "1.2.3", scopes: ["global"] });
    const index: Index = {
      schema: 1,
      entries: [
        {
          id: caskPattern.id,
          displayName: caskPattern.displayName,
          description: caskPattern.description,
          keywords: [],
          latest: built.version,
          clis: ["claude-code"],
          versions: [
            {
              version: built.version,
              spools: built.spools.map((s) => ({
                cli: s.cli,
                scope: s.scope,
                url: pathToFileURL(s.tgzPath).href,
                spoolSha: s.spoolSha,
                spoolJsonSha: s.spoolJsonSha,
              })),
            },
          ],
        },
      ],
    };
    writeFileSync(join(millDir, "index.json"), JSON.stringify(index, null, 2));
    env = makeEnv(home, pathToFileURL(join(millDir, "index.json")).href);
    await updateIndex(env);
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(millDir, { recursive: true, force: true });
  });

  it("offers only the scopes that have a spool (global-only → no local in the matrix)", () => {
    const cells = installMatrix(env, "fake-cask");
    expect(cells).toEqual([{ cli: "claude-code", scope: "global", installed: false }]);
  });

  it("refuses to run the installer without consent (no receipt written)", async () => {
    const res = await installHarness(env, { harness: "fake-cask", cli: "claude-code", scope: "global" });
    expect(res.status).toBe("declined");
    expect(existsSync(join(home, "caskdir", "marker"))).toBe(false);
    expect(existsSync(join(home, ".weft", "receipts"))).toBe(false);
  });

  it("runs the installer on consent, records a delegation receipt, then delegates uninstall", async () => {
    let asked: string | undefined;
    const res = await installHarness(env, {
      harness: "fake-cask",
      cli: "claude-code",
      scope: "global",
      onDelegate: async (info) => {
        asked = info.cmd;
        return true;
      },
    });
    expect(res.status).toBe("installed");
    // The command actually ran on the machine and {dir}/{version} were resolved.
    expect(asked).toContain(join(home, "caskdir"));
    expect(readFileSync(join(home, "caskdir", "marker"), "utf8")).toBe("1.2.3");

    // The receipt carries the resolved uninstall command (so removal can delegate).
    if (res.status !== "installed") throw new Error("unreachable");
    expect(res.receipt.delegation?.uninstallCmd).toBe(`rm -rf ${join(home, "caskdir")}`);
    expect(res.receipt.placedFiles).toEqual([]);

    // Uninstall delegates to that command — the dir is gone and the receipt removed.
    const un = await uninstallHarness(env, { harness: "fake-cask", onDelegate: async () => true });
    expect(un.status).toBe("uninstalled");
    expect(existsSync(join(home, "caskdir"))).toBe(false);
    expect(readdirSync(join(home, ".weft", "receipts"))).toEqual([]);
  });

  it("upgrade re-runs the recipe's upgradeCmd and bumps the receipt to the new catalog version", async () => {
    // A cask whose install and upgrade write DIFFERENT markers, so we can tell which command ran.
    const upPattern: HarnessPattern = {
      ...caskPattern,
      id: "up-cask",
      targets: {
        "claude-code": {
          strategy: "delegated",
          delegate: {
            installCmd: "mkdir -p {dir} && printf 'install %s' {version} > {dir}/marker",
            upgradeCmd: "printf 'upgrade %s' {version} > {dir}/marker",
            uninstallCmd: "rm -rf {dir}",
            dir: { global: "{home}/upcask" },
            requires: [],
          },
        },
      },
    };
    const src = mkdtempSync(join(tmpdir(), "weft-up-src-"));

    const writeIdx = async (version: string): Promise<WeftEnv> => {
      const built = await buildHarness(upPattern, { outDir: millDir, sourceDir: src, version, scopes: ["global"] });
      const index: Index = {
        schema: 1,
        entries: [
          {
            id: "up-cask",
            displayName: "Up",
            description: "x",
            keywords: [],
            latest: version,
            clis: ["claude-code"],
            versions: [
              {
                version,
                spools: built.spools.map((s) => ({
                  cli: s.cli,
                  scope: s.scope,
                  url: pathToFileURL(s.tgzPath).href,
                  spoolSha: s.spoolSha,
                  spoolJsonSha: s.spoolJsonSha,
                })),
              },
            ],
          },
        ],
      };
      writeFileSync(join(millDir, "index.json"), JSON.stringify(index, null, 2));
      const e = makeEnv(home, pathToFileURL(join(millDir, "index.json")).href);
      await updateIndex(e);
      return e;
    };

    // Install v1.0.0 → install command ran.
    let e = await writeIdx("1.0.0");
    const r1 = await installHarness(e, { harness: "up-cask", cli: "claude-code", scope: "global", onDelegate: async () => true });
    expect(r1.status).toBe("installed");
    expect(readFileSync(join(home, "upcask", "marker"), "utf8")).toBe("install 1.0.0");

    // Catalog hasn't moved → upgrade is a no-op (the livecheck.skip reality: no bump, nothing to pull).
    const noop = await upgradeHarness(e, { harness: "up-cask", onDelegate: async () => true });
    expect(noop.status).toBe("up-to-date");

    // Catalog bumped to 2.0.0 → upgrade runs upgradeCmd, pulling the new version into the marker.
    e = await writeIdx("2.0.0");
    const up = await upgradeHarness(e, { harness: "up-cask", onDelegate: async () => true });
    expect(up.status).toBe("upgraded");
    if (up.status !== "upgraded") throw new Error("unreachable");
    expect(up.from).toBe("1.0.0");
    expect(up.to).toBe("2.0.0");
    expect(readFileSync(join(home, "upcask", "marker"), "utf8")).toBe("upgrade 2.0.0");

    // And without consent, the upgrade does not run — the command is never executed, code untouched.
    const e3 = await writeIdx("3.0.0");
    const declined = await upgradeHarness(e3, { harness: "up-cask" }); // no onDelegate → not approved
    expect(declined.status).toBe("not-installed"); // single-harness upgrade maps a skipped outcome here
    expect(readFileSync(join(home, "upcask", "marker"), "utf8")).toBe("upgrade 2.0.0"); // unchanged

    await uninstallHarness(e3, { harness: "up-cask", onDelegate: async () => true });
  });

  it("aborts the install when a required tool is missing", async () => {
    const needy: HarnessPattern = {
      ...caskPattern,
      id: "needy-cask",
      targets: {
        "claude-code": {
          strategy: "delegated",
          delegate: {
            installCmd: "true",
            uninstallCmd: "true",
            dir: { global: "{home}/needy" },
            requires: ["definitely-not-a-real-binary-xyz"],
          },
        },
      },
    };
    const src = mkdtempSync(join(tmpdir(), "weft-needy-src-"));
    const built = await buildHarness(needy, { outDir: millDir, sourceDir: src, version: "1.0.0", scopes: ["global"] });
    const index: Index = {
      schema: 1,
      entries: [
        {
          id: "needy-cask",
          displayName: "Needy",
          description: "x",
          keywords: [],
          latest: "1.0.0",
          clis: ["claude-code"],
          versions: [
            {
              version: "1.0.0",
              spools: built.spools.map((s) => ({
                cli: s.cli,
                scope: s.scope,
                url: pathToFileURL(s.tgzPath).href,
                spoolSha: s.spoolSha,
                spoolJsonSha: s.spoolJsonSha,
              })),
            },
          ],
        },
      ],
    };
    writeFileSync(join(millDir, "index.json"), JSON.stringify(index, null, 2));
    const env2 = makeEnv(home, pathToFileURL(join(millDir, "index.json")).href);
    await updateIndex(env2);
    await expect(
      installHarness(env2, { harness: "needy-cask", cli: "claude-code", scope: "global", onDelegate: async () => true }),
    ).rejects.toThrow(/needs .* on PATH/);
  });
});
