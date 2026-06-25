import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPattern } from "@weft/schema";

/** Absolute path to the vendored gsd-core-like source tree. */
export const gsdFixtureDir = join(dirname(fileURLToPath(import.meta.url)), "gsd-core-src");

/** The canonical gsd-core pattern, mirrored by `weft-mill/patterns/gsd-core.yaml`. */
export const gsdPattern: HarnessPattern = {
  schema: 1,
  id: "gsd-core",
  displayName: "GSD Core",
  description: "Spec-driven development system for AI coding agents.",
  homepage: "https://github.com/open-gsd/gsd-core",
  keywords: ["gsd", "spec", "planning", "workflow"],
  source: { type: "npm", package: "@opengsd/gsd-core" },
  versioning: { strategy: "semver", track: "latest" },
  namespace: { mode: "as-is" },
  targets: {
    "claude-code": {
      strategy: "declarative",
      map: [
        { kind: "agent", from: "agents/*.md", as: "agent:${name}" },
        { kind: "command", from: "commands/gsd/*.md", as: "command:gsd-${name}" },
        { kind: "payload", from: "gsd-core/**", as: "payload:gsd-core" },
        { kind: "payload", from: "hooks/**", as: "payload:gsd-core" },
        { kind: "hook", from: "hooks/hooks.json", as: "hook", mergeInto: "hooks" },
      ],
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
