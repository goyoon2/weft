import { describe, expect, it } from "vitest";
import type { SourceSpec } from "@weft/schema";
import { deriveLivecheckStrategy, pickHighestTag } from "../src/livecheck";

// Pure helpers only — no network. The live resolvers (npm view / git ls-remote / GitHub API) are
// exercised by the mill's `scripts/livecheck.ts`, never in the no-network CI unit suite.

describe("deriveLivecheckStrategy", () => {
  it("maps each source type to its default strategy", () => {
    expect(deriveLivecheckStrategy({ type: "npm", package: "x" })).toBe("npm-dist-tag");
    expect(deriveLivecheckStrategy({ type: "git", url: "https://example.com/x.git" })).toBe("git-tags");
    expect(deriveLivecheckStrategy({ type: "github-release", repo: "o/r" } satisfies SourceSpec)).toBe(
      "github-latest",
    );
  });
});

describe("pickHighestTag", () => {
  it("returns the highest semver across mixed v-prefixed and plain tags", () => {
    expect(pickHighestTag(["v1.2.0", "1.10.0", "v1.9.3", "1.0.0"])).toBe("1.10.0");
  });

  it("ignores tags that aren't semver", () => {
    expect(pickHighestTag(["nightly", "latest", "v2.0.0", "release"])).toBe("2.0.0");
  });

  it("returns null when nothing parses", () => {
    expect(pickHighestTag(["nightly", "edge", "stable"])).toBeNull();
    expect(pickHighestTag([])).toBeNull();
  });

  it("applies a tagPattern glob before parsing", () => {
    // Without the filter the highest is 9.9.9; the glob restricts to the `v*` line of tags.
    const tags = ["v1.2.0", "v1.3.0", "snapshot-9.9.9"];
    expect(pickHighestTag(tags, { tagPattern: "v*" })).toBe("1.3.0");
  });

  it("respects prerelease ordering (stable beats its own prerelease)", () => {
    expect(pickHighestTag(["v2.0.0-rc.1", "v2.0.0", "v1.9.0"])).toBe("2.0.0");
  });
});
