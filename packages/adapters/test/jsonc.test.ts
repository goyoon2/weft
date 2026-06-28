import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256OfValue } from "@weft/schema";
import type { AppliedFragment, MergeFragment } from "@weft/schema";
import { geminiAdapter } from "../src/index";

// Gemini and OpenCode officially use JSONC (comments allowed). weft must merge into such a file
// without dropping the user's comments — and must NOT refuse it as "unparsable". This drives the
// real on-disk read/serialize path (comment-json) through the gemini adapter.

const dir = mkdtempSync(join(tmpdir(), "weft-jsonc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mcpFrag = (name: string, value: unknown): MergeFragment => ({
  id: `m-${name}`,
  mergeInto: "mcpServers",
  op: { type: "mcpServer", name, value },
  valueSha: sha256OfValue(value),
});

describe("JSONC config merges without dropping the user's comments", () => {
  it("keeps comments + siblings when weft adds, then removes, its server", () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      [
        "{",
        "  // my gemini settings — keep this comment!",
        '  "theme": "dark",',
        '  "mcpServers": {',
        '    "userctx": { "command": "node" } // user-owned server',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const cfg = geminiAdapter.readConfig(path);
    expect(cfg.unparsable).toBe(false); // parsed as JSONC, NOT refused

    const frag = mcpFrag("weftctx", { command: "npx", args: ["-y", "@weft/mcp"] });
    expect(geminiAdapter.mergeFragment(cfg, frag).applied).toBe(true);

    const merged = geminiAdapter.serializeConfig(cfg);
    expect(merged).toContain("// my gemini settings — keep this comment!"); // comment survived
    expect(merged).toContain("// user-owned server");
    expect(merged).toContain('"theme": "dark"');
    expect(merged).toContain('"weftctx"');
    expect(merged).toContain('"userctx"');

    const applied: AppliedFragment = {
      id: frag.id,
      targetAbs: path,
      mergeInto: "mcpServers",
      locator: { kind: "mcpServer", name: "weftctx" },
      valueSha: frag.valueSha,
    };
    geminiAdapter.unmergeFragment(cfg, applied);
    const reverted = geminiAdapter.serializeConfig(cfg);
    expect(reverted).toContain("// my gemini settings — keep this comment!"); // still there after removal
    expect(reverted).toContain('"userctx"');
    expect(reverted).not.toContain("weftctx"); // only weft's server removed
  });
});
