import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCapturedSpoolForTarget } from "../src/capture";

// Regression for the settings.json clobber: a captured installer writes a SHARED config file
// (Claude's settings.json) holding both mergeable maps (hooks) and keys weft can't merge
// (statusLine, permissions). The old builder shipped the whole tree — including settings.json — as
// one opaque payload, so installing it OVERWROTE the user's real settings.json. The builder must
// instead decompose the shared config into merge fragments and leave it OUT of the payload, so
// install folds gsd's hooks into the user's file rather than replacing it.

const scriptDir = mkdtempSync(join(tmpdir(), "weft-decompose-fixture-"));
const scriptPath = join(scriptDir, "fake-install.sh");
writeFileSync(
  scriptPath,
  [
    "#!/bin/sh",
    "set -e",
    'mkdir -p "$HOME/.claude/hooks" "$HOME/.claude/agents"',
    // gsd's own files (correctly placed as payload, under the payload root):
    'printf \'console.log("guard");\\n\' > "$HOME/.claude/hooks/guard.js"',
    'printf -- "---\\nname: foo\\n---\\nAgent.\\n" > "$HOME/.claude/agents/foo.md"',
    // the SHARED config: a hook (mergeable) whose command points at gsd's own script via an
    // absolute sandbox path (→ {{WEFT_PAYLOAD_DIR}}), plus statusLine + permissions (NOT mergeable).
    'cat > "$HOME/.claude/settings.json" <<EOF',
    "{",
    '  "hooks": {',
    '    "PreToolUse": [',
    '      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "node $HOME/.claude/hooks/guard.js", "timeout": 5 } ] }',
    "    ]",
    "  },",
    '  "statusLine": { "type": "command", "command": "node $HOME/.claude/hooks/status.js" },',
    '  "permissions": { "allow": ["Bash(npx foo *)"] }',
    "}",
    "EOF",
    "",
  ].join("\n"),
);
chmodSync(scriptPath, 0o755);

const staging = mkdtempSync(join(tmpdir(), "weft-decompose-staging-"));
const built = buildCapturedSpoolForTarget({
  harnessId: "fakegsd",
  pkg: "fake-pkg",
  capture: { installCmd: `sh ${scriptPath}`, configDir: ".claude" },
  cli: "claude-code",
  scope: "global",
  version: "0.0.0",
  stagingDir: staging,
});

afterAll(() => {
  rmSync(scriptDir, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
});

describe("captured shared-config is decomposed into fragments, not placed as a file", () => {
  const payloadRels = () => built.spool.payloads[0]?.entries.map((e) => e.rel) ?? [];

  it("keeps the harness's OWN files in the payload but NOT the shared settings.json", () => {
    expect(payloadRels()).toContain("hooks/guard.js");
    expect(payloadRels()).toContain("agents/foo.md");
    expect(payloadRels()).not.toContain("settings.json"); // ← would clobber the user's file if placed
  });

  it("emits the hook as a merge fragment with the payload placeholder substituted", () => {
    expect(built.spool.fragments).toHaveLength(1);
    const f = built.spool.fragments[0]!;
    expect(f.mergeInto).toBe("hooks");
    expect(f.op).toMatchObject({ type: "hook", event: "PreToolUse", matcher: "Write|Edit" });
    const cmd = (f.op as { command: { command: string } }).command.command;
    expect(cmd).toBe("node {{WEFT_PAYLOAD_DIR}}/hooks/guard.js"); // re-localized, no machine path
    expect(built.spool.placeholders).toContain("WEFT_PAYLOAD_DIR");
  });

  it("surfaces the keys it could NOT merge (statusLine, permissions) as a note, never silently dropping", () => {
    const note = built.notes.find((n) => n.includes("does not merge"));
    expect(note).toBeDefined();
    expect(note).toContain("settings.json");
    expect(note).toContain("permissions");
    expect(note).toContain("statusLine");
  });
});

// The same decomposition for a TOML CLI: Codex keeps mcp servers in config.toml under
// [mcp_servers.*]. The builder must pull those into mcpServer fragments and keep config.toml out
// of the payload (else it overwrites the user's config.toml + other settings on install).
describe("captured codex config.toml is decomposed into mcp fragments, not placed", () => {
  const codexScriptDir = mkdtempSync(join(tmpdir(), "weft-codex-fixture-"));
  const codexScript = join(codexScriptDir, "fake-codex-install.sh");
  writeFileSync(
    codexScript,
    [
      "#!/bin/sh",
      "set -e",
      'mkdir -p "$HOME/.codex"',
      'cat > "$HOME/.codex/config.toml" <<EOF',
      'model = "gpt-5"',
      "[mcp_servers.weftctx]",
      'command = "npx"',
      'args = ["-y", "@weft/mcp"]',
      "EOF",
      "",
    ].join("\n"),
  );
  chmodSync(codexScript, 0o755);
  const codexStaging = mkdtempSync(join(tmpdir(), "weft-codex-staging-"));
  const codexBuilt = buildCapturedSpoolForTarget({
    harnessId: "fakecodex",
    pkg: "fake-pkg",
    capture: { installCmd: `sh ${codexScript}`, configDir: ".codex" },
    cli: "codex",
    scope: "global",
    version: "0.0.0",
    stagingDir: codexStaging,
  });

  afterAll(() => {
    rmSync(codexScriptDir, { recursive: true, force: true });
    rmSync(codexStaging, { recursive: true, force: true });
  });

  it("emits the mcp server as a fragment and leaves config.toml out of the payload", () => {
    expect(codexBuilt.spool.payloads[0]?.entries.map((e) => e.rel) ?? []).not.toContain("config.toml");
    const mcp = codexBuilt.spool.fragments.filter((f) => f.mergeInto === "mcpServers");
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.op).toMatchObject({ type: "mcpServer", name: "weftctx" });
    // `model` isn't mergeable → reported, not placed
    expect(codexBuilt.notes.find((n) => n.includes("does not merge"))).toContain("model");
  });
});
