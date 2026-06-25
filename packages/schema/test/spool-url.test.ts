import { describe, expect, it } from "vitest";
import { absolutizeIndexSpools, absolutizeSpoolUrl, relativizeEntrySpools, relativizeSpoolUrl } from "../src/index";
import type { Index, IndexEntry } from "../src/index";

const MILL = "/home/runner/work/weft-mill";
const REL = "spools/gsd-core/1.6.0/claude-code.global.spool.tgz";

describe("spool url relativize ↔ absolutize", () => {
  it("absolutize resolves a relative path to a file:// url under millDir", () => {
    expect(absolutizeSpoolUrl(REL, MILL)).toBe(`file://${MILL}/${REL}`);
  });

  it("relativize converts a file:// url back to a millDir-relative path", () => {
    expect(relativizeSpoolUrl(`file://${MILL}/${REL}`, MILL)).toBe(REL);
  });

  it("round-trips (relativize ∘ absolutize === identity for in-mill paths)", () => {
    expect(relativizeSpoolUrl(absolutizeSpoolUrl(REL, MILL), MILL)).toBe(REL);
    const abs = `file://${MILL}/${REL}`;
    expect(absolutizeSpoolUrl(relativizeSpoolUrl(abs, MILL), MILL)).toBe(abs);
  });

  it("leaves hosted http(s) urls untouched in both directions", () => {
    const hosted = "https://example.com/spool.tgz";
    expect(absolutizeSpoolUrl(hosted, MILL)).toBe(hosted);
    expect(relativizeSpoolUrl(hosted, MILL)).toBe(hosted);
  });

  it("absolutize is idempotent on an already-absolute url", () => {
    const abs = `file://${MILL}/${REL}`;
    expect(absolutizeSpoolUrl(abs, MILL)).toBe(abs);
  });

  it("relativize is idempotent on an already-relative path", () => {
    expect(relativizeSpoolUrl(REL, MILL)).toBe(REL);
  });

  it("maps every spool in an index/entry and round-trips", () => {
    const entry: IndexEntry = {
      id: "gsd-core",
      displayName: "GSD Core",
      description: "x",
      keywords: [],
      latest: "1.6.0",
      clis: ["claude-code"],
      versions: [
        {
          version: "1.6.0",
          spools: [
            { cli: "claude-code", scope: "global", url: REL, spoolSha: "sha256:a", spoolJsonSha: "sha256:b" },
            { cli: "claude-code", scope: "local", url: REL, spoolSha: "sha256:c", spoolJsonSha: "sha256:d" },
          ],
        },
      ],
    };
    const index: Index = { schema: 1, entries: [entry] };
    const abs = absolutizeIndexSpools(index, MILL);
    expect(abs.entries[0]!.versions[0]!.spools[0]!.url).toBe(`file://${MILL}/${REL}`);
    // other ref fields untouched
    expect(abs.entries[0]!.versions[0]!.spools[0]!.spoolSha).toBe("sha256:a");
    // entry-level relativize undoes it
    const back = relativizeEntrySpools(abs.entries[0]!, MILL);
    expect(back.versions[0]!.spools[0]!.url).toBe(REL);
    expect(back.versions[0]!.spools[1]!.url).toBe(REL);
  });
});
