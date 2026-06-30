import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePattern, sha256OfValue } from "@weft/schema";
import type { HarnessPattern, Spool } from "@weft/schema";
import { buildHarness } from "../src/index";

const SL = { type: "command", command: "bash {{WEFT_PAYLOAD_DIR}}/hooks/statusline.sh", padding: 0 };

function globalSpool(spools: { scope: string; spool: Spool }[]): Spool {
  const s = spools.find((x) => x.scope === "global");
  if (!s) throw new Error("no global spool");
  return s.spool;
}

describe("loom status-line slot", () => {
  const pattern: HarnessPattern = parsePattern({
    schema: 1,
    id: "caveman",
    displayName: "Caveman",
    description: "Status line badge.",
    source: { type: "git", url: "https://github.com/JuliusBrussee/caveman" },
    versioning: { strategy: "semver", track: "latest" },
    targets: {
      "claude-code": {
        strategy: "declarative",
        map: [{ kind: "status-line", as: "status-line", statusLine: SL }],
      },
    },
  });

  it("emits one statusLine fragment with the inline value and registers the placeholder", async () => {
    const out = mkdtempSync(join(tmpdir(), "weft-sl-"));
    const src = mkdtempSync(join(tmpdir(), "weft-sl-src-"));
    const result = await buildHarness(pattern, { outDir: out, sourceDir: src, version: "1.0.0" });
    const spool = globalSpool(result.spools);
    expect(spool.files).toHaveLength(0);
    expect(spool.fragments).toHaveLength(1);
    const frag = spool.fragments[0]!;
    expect(frag.mergeInto).toBe("statusLine");
    expect(frag.op).toEqual({ type: "statusLine", value: SL });
    expect(frag.valueSha).toBe(sha256OfValue(SL));
    // the {{WEFT_PAYLOAD_DIR}} in the command must be registered so the client resolves it at install
    expect(spool.placeholders).toContain("WEFT_PAYLOAD_DIR");
  });

  it("rejects a status-line rule with no inline value", () => {
    expect(() =>
      parsePattern({
        ...pattern,
        targets: { "claude-code": { strategy: "declarative", map: [{ kind: "status-line", as: "status-line" }] } },
      }),
    ).toThrow();
  });
});
