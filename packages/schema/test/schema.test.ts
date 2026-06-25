import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  extractPlaceholders,
  parsePattern,
  parseSpool,
  sha256OfBytes,
  sha256OfValue,
  substitutePlaceholders,
} from "../src/index";
import type { HarnessPattern, Spool } from "../src/index";

describe("hash", () => {
  it("produces sha256:<hex> and is deterministic", () => {
    const a = sha256OfBytes("hello");
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256OfBytes("hello")).toBe(a);
    expect(sha256OfBytes("world")).not.toBe(a);
  });

  it("canonical hash is independent of object key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(sha256OfValue({ type: "command", command: "x", timeout: 5 })).toBe(
      sha256OfValue({ timeout: 5, command: "x", type: "command" }),
    );
    // nested order also normalized
    expect(sha256OfValue({ a: { y: 1, x: 2 } })).toBe(sha256OfValue({ a: { x: 2, y: 1 } }));
  });
});

describe("placeholders", () => {
  it("extracts and substitutes, leaving unknowns intact", () => {
    const text = 'node "{{WEFT_PAYLOAD_DIR}}/hooks/x.js" {{UNKNOWN}}';
    expect(extractPlaceholders(text)).toEqual(["WEFT_PAYLOAD_DIR", "UNKNOWN"]);
    expect(substitutePlaceholders(text, { WEFT_PAYLOAD_DIR: "/home/u/.claude/gsd-core" })).toBe(
      'node "/home/u/.claude/gsd-core/hooks/x.js" {{UNKNOWN}}',
    );
  });
});

describe("validate", () => {
  const validPattern: HarnessPattern = {
    schema: 1,
    id: "gsd-core",
    displayName: "GSD Core",
    description: "Spec-driven development system.",
    source: { type: "npm", package: "@opengsd/gsd-core" },
    versioning: { strategy: "semver", track: "latest" },
    namespace: { mode: "as-is" },
    targets: {
      "claude-code": {
        strategy: "declarative",
        map: [{ kind: "agent", from: "agents/*.md", as: "agent:${name}" }],
        transforms: [
          {
            type: "substitute-var",
            appliesTo: "hooks/**",
            from: "${CLAUDE_PLUGIN_ROOT}",
            to: "{{WEFT_PAYLOAD_DIR}}",
          },
        ],
      },
    },
  };

  it("accepts a valid pattern", () => {
    expect(parsePattern(validPattern).id).toBe("gsd-core");
  });

  it("rejects a bad id", () => {
    expect(() => parsePattern({ ...validPattern, id: "GSD_Core" })).toThrow();
  });

  it("rejects an unknown CLI key in targets", () => {
    expect(() =>
      parsePattern({ ...validPattern, targets: { vim: { strategy: "declarative" } } }),
    ).toThrow();
  });

  it("accepts an optional livecheck override block", () => {
    const p = parsePattern({
      ...validPattern,
      livecheck: { strategy: "github-tags", tagPattern: "v*" },
    });
    expect(p.livecheck?.strategy).toBe("github-tags");
  });

  it("requires a reason when livecheck opts out (the no_autobump! rule)", () => {
    expect(() => parsePattern({ ...validPattern, livecheck: { skip: true } })).toThrow();
    expect(
      parsePattern({ ...validPattern, livecheck: { skip: true, skipReason: "no upstream releases" } })
        .livecheck?.skipReason,
    ).toBe("no upstream releases");
  });

  it("round-trips a minimal spool", () => {
    const spool: Spool = {
      schema: 1,
      harness: "gsd-core",
      version: "1.5.0",
      cli: "claude-code",
      scope: "global",
      builtAt: "2026-06-25T00:00:00.000Z",
      files: [],
      payloads: [],
      fragments: [
        {
          id: "gsd-core#hook-0001",
          target: "settings.json",
          mergeInto: "hooks",
          op: { type: "hook", event: "PreToolUse", matcher: "Write|Edit", command: { type: "command", command: "node x.js" } },
          valueSha: sha256OfValue({ type: "command", command: "node x.js" }),
        },
      ],
      placeholders: ["WEFT_PAYLOAD_DIR"],
      archiveSha: sha256OfBytes("payload"),
    };
    expect(parseSpool(spool).fragments[0]?.id).toBe("gsd-core#hook-0001");
  });
});
