import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCapturedSpoolForTarget } from "../src/capture";

// A hermetic stand-in for a runtime-heavy installer (no network): a shell script that writes a
// config tree recording (a) the machine's `node` the way an installer does — `which node`, i.e.
// the symlink, which differs from process.execPath's resolved target — and (b) a file hardcoding
// the build user's real HOME. (a) must be normalized to a bare `node`; (b) must be flagged a leak.
const nodeSymlink = execSync("command -v node", { encoding: "utf8" }).trim();
const realHome = homedir();

const scriptDir = mkdtempSync(join(tmpdir(), "weft-capture-fixture-"));
const scriptPath = join(scriptDir, "fake-install.sh");
writeFileSync(
  scriptPath,
  [
    "#!/bin/sh",
    "set -e",
    'mkdir -p "$HOME/.claude"',
    // (a) the OMC-class bug: an installer recording `which node` (the symlink) into its config.
    `printf '{"nodeBinary":"%s"}\\n' "${nodeSymlink}" > "$HOME/.claude/config.json"`,
    // (b) a genuine machine-path leak weft cannot rewrite: the build user's real HOME.
    `printf 'export PATH=%s/leakbin:$PATH\\n' "${realHome}" > "$HOME/.claude/leak.sh"`,
    // a plain file that should pass through untouched.
    'printf "hello\\n" > "$HOME/.claude/readme.txt"',
    "",
  ].join("\n"),
);
chmodSync(scriptPath, 0o755);

const staging = mkdtempSync(join(tmpdir(), "weft-capture-staging-"));
const built = buildCapturedSpoolForTarget({
  harnessId: "fake",
  pkg: "fake-pkg",
  capture: { installCmd: `sh ${scriptPath}`, configDir: ".claude" },
  cli: "claude-code",
  scope: "global",
  version: "0.0.0",
  stagingDir: staging,
});

const archived = (rel: string): string => readFileSync(join(staging, "payloads/fake", rel), "utf8");

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

describe("loom capture path normalization", () => {
  it("normalizes every spelling of the machine's node (symlink + resolved) to a bare `node`", () => {
    expect(archived("config.json")).toBe('{"nodeBinary":"node"}\n');
    // the original machine path must not survive anywhere in the spool
    expect(archived("config.json")).not.toContain(nodeSymlink);
  });

  it("flags a surviving machine-specific path (build user's HOME) as a LEAK note", () => {
    const leakNote = built.notes.find((n) => n.includes("LEAK"));
    expect(leakNote).toBeDefined();
    expect(leakNote).toContain("leak.sh");
    // only the genuinely-leaking file is named — the normalized + plain files are clean
    expect(leakNote).not.toContain("config.json");
    expect(leakNote).not.toContain("readme.txt");
  });

  it("leaves portable files untouched", () => {
    expect(archived("readme.txt")).toBe("hello\n");
  });
});
