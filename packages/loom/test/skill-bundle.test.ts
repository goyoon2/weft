import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HarnessPattern, Spool } from "@weft/schema";
import { buildHarness } from "../src/index";

const skillsFixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "skills-src");

/** A plain multi-file skills repo (mattpocock-skills shape): declarative skill map, no installer. */
const skillsPattern: HarnessPattern = {
  schema: 1,
  id: "matt-skills",
  displayName: "Matt Skills",
  description: "fixture",
  source: { type: "git", url: "https://example.invalid/skills" },
  versioning: { strategy: "semver", track: "latest" },
  targets: {
    "claude-code": {
      strategy: "declarative",
      map: [
        { kind: "skill", from: "skills/engineering/*/SKILL.md", as: "skill:${name}" },
        { kind: "skill", from: "skills/productivity/*/SKILL.md", as: "skill:${name}" },
      ],
    },
  },
};

function globalSpool(spools: { scope: string; spool: Spool }[]): Spool {
  const s = spools.find((x) => x.scope === "global");
  if (!s) throw new Error("no global spool");
  return s.spool;
}

const resultP = buildHarness(skillsPattern, {
  outDir: mkdtempSync(join(tmpdir(), "weft-skills-test-")),
  sourceDir: skillsFixtureDir,
  version: "1.0.0",
  scopes: ["global"],
});

describe("loom skill slot (multi-file bundling)", () => {
  it("bundles SKILL.md plus every sibling file, preserving sub-dirs", async () => {
    const spool = globalSpool((await resultP).spools);
    const skillFiles = spool.files.filter((f) => f.slot === "skill").map((f) => f.destRel).sort();
    expect(skillFiles).toEqual([
      "solo/SKILL.md",
      "tdd/SKILL.md",
      "tdd/mocking.md",
      "tdd/scripts/run.sh",
      "teach/GLOSSARY.md",
      "teach/SKILL.md",
    ]);
  });

  it("groups every file of a skill under one logicalName (the skill dir name)", async () => {
    const spool = globalSpool((await resultP).spools);
    const byLogical = (name: string): string[] =>
      spool.files.filter((f) => f.logicalName === name).map((f) => f.destRel).sort();
    expect(byLogical("tdd")).toEqual(["tdd/SKILL.md", "tdd/mocking.md", "tdd/scripts/run.sh"]);
    expect(byLogical("teach")).toEqual(["teach/GLOSSARY.md", "teach/SKILL.md"]);
  });

  it("ships only mapped categories — deprecated/ is excluded", async () => {
    const spool = globalSpool((await resultP).spools);
    expect(spool.files.some((f) => f.logicalName === "old")).toBe(false);
  });
});
