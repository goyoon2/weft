import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHarness } from "@weft/loom";
import type { BuiltSpool } from "@weft/loom";
import type { HarnessPattern, Index } from "@weft/schema";
import { installHarness, uninstallHarness, updateIndex } from "../src/index";
import type { WeftEnv } from "../src/index";

// END-TO-END regression for the settings.json clobber. A `captured` harness (the gsd-core strategy)
// whose installer writes a shared settings.json — hooks + statusLine + permissions — used to be
// shipped as one opaque payload, so `weft install` OVERWROTE the user's settings.json wholesale.
// After the fix the builder decomposes that file into merge fragments, so install folds the hooks
// into the user's real settings.json and never touches their model/permissions/statusLine/other hooks.

const cleanup: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  cleanup.push(d);
  return d;
};
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

// A hermetic stand-in for gsd-core's installer: writes its own files + a shared settings.json that
// references its scripts by absolute (sandbox) path — exactly the shape that produced the clobber.
function writeFakeInstaller(dir: string): string {
  const script = join(dir, "fake-install.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "set -e",
      'mkdir -p "$HOME/.claude/hooks" "$HOME/.claude/agents"',
      'printf \'console.log("guard");\\n\' > "$HOME/.claude/hooks/guard.js"',
      'printf -- "---\\nname: fakegsd-foo\\n---\\nAgent.\\n" > "$HOME/.claude/agents/fakegsd-foo.md"',
      'cat > "$HOME/.claude/settings.json" <<EOF',
      "{",
      '  "hooks": {',
      '    "PreToolUse": [',
      '      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "node $HOME/.claude/hooks/guard.js", "timeout": 5 } ] }',
      "    ]",
      "  },",
      '  "statusLine": { "type": "command", "command": "node $HOME/.claude/hooks/gsd-status.js" },',
      '  "permissions": { "allow": ["Bash(npx fakegsd *)"] }',
      "}",
      "EOF",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return script;
}

const pattern = (script: string): HarnessPattern => ({
  schema: 1,
  id: "fakegsd",
  displayName: "Fake GSD",
  description: "captured fixture for the clobber regression",
  keywords: [],
  source: { type: "npm", package: "fake-pkg" },
  versioning: { strategy: "semver", track: "latest" },
  targets: { "claude-code": { strategy: "captured", capture: { installCmd: `sh ${script}`, configDir: ".claude" } } },
});

function writeIndex(millDir: string, spools: BuiltSpool[], version: string): string {
  const index: Index = {
    schema: 1,
    entries: [
      {
        id: "fakegsd",
        displayName: "Fake GSD",
        description: "captured fixture",
        keywords: [],
        latest: version,
        clis: ["claude-code"],
        versions: [
          {
            version,
            spools: spools.map((s) => ({
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
  const path = join(millDir, "index.json");
  writeFileSync(path, JSON.stringify(index, null, 2));
  return pathToFileURL(path).href;
}

describe("captured harness merges into a pre-existing settings.json instead of clobbering it", () => {
  let env: WeftEnv;
  let home: string;
  let original: Record<string, unknown>;
  const settingsPath = (): string => join(home, ".claude", "settings.json");

  beforeAll(async () => {
    const mill = tmp("capmill-");
    const built = await buildHarness(pattern(writeFakeInstaller(tmp("capsrc-"))), {
      outDir: mill,
      sourceDir: tmp("capsrcdir-"),
      scopes: ["global"],
      version: "1.0.0",
    });
    const indexSource = writeIndex(mill, built.spools, "1.0.0");

    home = tmp("caphome-");
    env = { home, weftDir: join(home, ".weft"), cwd: tmp("capcwd-"), millIndexSource: indexSource, weftVersion: "test" };

    // The user's real settings.json — the thing that must survive.
    original = {
      model: "opus[1m]",
      permissions: { allow: ["mcp__pencil"], deny: ["Bash(sudo:*)"] },
      statusLine: { type: "command", command: "user-statusline" },
      enabledPlugins: { "ouroboros@ouroboros": true },
      hooks: { PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "user-hook" }] }] },
    };
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(original, null, 2)}\n`);

    await updateIndex(env);
    await installHarness(env, { harness: "fakegsd", cli: "claude-code", scope: "global" });
  });

  it("preserves every user-owned key (model, permissions, statusLine, plugins, their hooks)", () => {
    const after = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(after.model).toBe("opus[1m]");
    expect(after.permissions).toEqual(original.permissions); // gsd's permissions NOT merged in
    expect(after.statusLine).toEqual(original.statusLine); // gsd's statusLine did NOT overwrite
    expect(after.enabledPlugins).toEqual(original.enabledPlugins);
    expect(after.hooks.PostToolUse).toEqual([{ matcher: "Read", hooks: [{ type: "command", command: "user-hook" }] }]);
  });

  it("merges gsd's hook into the user's hooks with the payload path resolved", () => {
    const after = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const group = after.hooks.PreToolUse?.[0];
    expect(group?.matcher).toBe("Write|Edit");
    const cmd = group?.hooks?.[0]?.command as string;
    expect(cmd).toContain(join(home, ".claude", "hooks", "guard.js")); // {{WEFT_PAYLOAD_DIR}} resolved
    expect(cmd).not.toContain("{{WEFT_PAYLOAD_DIR}}");
    // gsd's own files were placed as payload.
    expect(existsSync(join(home, ".claude", "hooks", "guard.js"))).toBe(true);
    expect(existsSync(join(home, ".claude", "agents", "fakegsd-foo.md"))).toBe(true);
  });

  it("uninstall reverses to EXACTLY the user's original settings.json", async () => {
    await uninstallHarness(env, { harness: "fakegsd", cli: "claude-code", scope: "global" });
    expect(existsSync(settingsPath())).toBe(true); // user's file kept (it pre-existed)
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual(original); // gsd's hook removed, rest intact
    expect(existsSync(join(home, ".claude", "hooks", "guard.js"))).toBe(false); // payload removed
  });
});
