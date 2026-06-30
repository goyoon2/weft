import { z } from "zod";
import type { HarnessPattern, Index, Receipt, Spool } from "./types";

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex>");
const cliId = z.enum(["claude-code", "codex", "gemini", "cursor", "opencode"]);
const scope = z.enum(["global", "local"]);
const slotKind = z.enum(["skill", "agent", "command", "hook", "mcp-server", "status-line", "payload"]);
const mergeInto = z.enum(["hooks", "mcpServers", "statusLine"]);
const shadowRecord = z.object({ backupPath: z.string(), originalSha: sha256 });

// ── pattern ──
const sourceSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("npm"), package: z.string().min(1) }),
  z.object({ type: z.literal("git"), url: z.string().min(1), ref: z.string().optional() }),
  z.object({
    type: z.literal("github-release"),
    repo: z.string().min(1),
    assetPattern: z.string().optional(),
  }),
]);

const slotMapRule = z
  .object({
    kind: slotKind,
    from: z.string().min(1).optional(),
    as: z.string().min(1),
    exclude: z.array(z.string().min(1)).optional(),
    mergeInto: mergeInto.optional(),
    // Inline value for a `status-line` rule (the statusLine object). Open-shaped.
    statusLine: z.record(z.string(), z.unknown()).optional(),
    // payload only: leading source-path prefix to strip from each entry's stored rel.
    rebase: z.string().min(1).optional(),
  })
  // `from` is required for every file/hook slot; the inline `status-line` slot omits it.
  .refine((r) => r.kind === "status-line" || !!r.from, {
    message: "slot rule requires 'from' (a source glob)",
    path: ["from"],
  })
  // A status-line rule carries its value inline; `from` is not used for it.
  .refine((r) => r.kind !== "status-line" || !!r.statusLine, {
    message: "status-line rule requires an inline 'statusLine' value",
    path: ["statusLine"],
  });

const transformRule = z.object({
  type: z.literal("substitute-var"),
  appliesTo: z.string().min(1),
  from: z.string().min(1),
  to: z.string(),
});

const livecheckSpec = z
  .object({
    skip: z.boolean().optional(),
    skipReason: z.string().min(1).optional(),
    strategy: z.enum(["npm-dist-tag", "git-tags", "github-latest", "github-tags", "version-file"]).optional(),
    distTag: z.string().min(1).optional(),
    tagPattern: z.string().min(1).optional(),
    repoUrl: z.string().min(1).optional(),
    versionFile: z.string().min(1).optional(),
  })
  // The `no_autobump!` rule: opting out must say why.
  .refine((v) => !v.skip || !!v.skipReason, {
    message: "livecheck.skip requires livecheck.skipReason",
    path: ["skipReason"],
  })
  // version-file is the one strategy that needs an extra field (which file to read).
  .refine((v) => v.strategy !== "version-file" || !!v.versionFile, {
    message: "livecheck.strategy 'version-file' requires livecheck.versionFile",
    path: ["versionFile"],
  });

const delegateSpec = z
  .object({
    installCmd: z.string().min(1),
    uninstallCmd: z.string().min(1),
    upgradeCmd: z.string().min(1).optional(),
    dir: z
      .object({ global: z.string().min(1).optional(), local: z.string().min(1).optional() })
      .refine((d) => !!d.global || !!d.local, { message: "delegate.dir needs at least one of global/local" }),
    requires: z.array(z.string().min(1)).optional(),
    summary: z.string().min(1).optional(),
    versionFile: z.string().min(1).optional(),
  });

const targetBuildSpec = z
  .object({
    strategy: z.enum(["declarative", "captured", "delegated"]),
    map: z.array(slotMapRule).optional(),
    capture: z
      .object({
        installCmd: z.string().min(1),
        configDir: z.union([
          z.string().min(1),
          z.object({ global: z.string().min(1), local: z.string().min(1) }),
        ]),
        normalize: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      })
      .optional(),
    delegate: delegateSpec.optional(),
    transforms: z.array(transformRule).optional(),
  })
  // Each strategy must carry the block it builds from — caught at parse time (the `brew audit`
  // analogue) so a misconfigured target can't silently produce no spool while the index still
  // advertises the CLI.
  .refine((t) => t.strategy !== "delegated" || !!t.delegate, {
    message: "delegated strategy requires a delegate block",
    path: ["delegate"],
  })
  .refine((t) => t.strategy !== "captured" || !!t.capture, {
    message: "captured strategy requires a capture block",
    path: ["capture"],
  })
  .refine((t) => t.strategy !== "declarative" || (Array.isArray(t.map) && t.map.length > 0), {
    message: "declarative strategy requires a non-empty map",
    path: ["map"],
  });

const patternSchema = z.object({
  schema: z.literal(1),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  displayName: z.string().min(1),
  description: z.string(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  source: sourceSpec,
  versioning: z.object({
    strategy: z.literal("semver"),
    track: z.enum(["latest", "tagged"]).optional(),
  }),
  livecheck: livecheckSpec.optional(),
  targets: z.record(cliId, targetBuildSpec),
});

// ── index ──
const spoolRef = z.object({
  cli: cliId,
  scope,
  url: z.string().min(1),
  spoolSha: sha256,
  spoolJsonSha: sha256,
});

const indexSchema = z.object({
  schema: z.literal(1),
  generatedAt: z.string().optional(),
  entries: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      homepage: z.string().optional(),
      keywords: z.array(z.string()),
      latest: z.string(),
      clis: z.array(cliId),
      versions: z.array(z.object({ version: z.string(), spools: z.array(spoolRef) })),
    }),
  ),
});

// ── spool ──
const payloadEntry = z.object({ rel: z.string(), sha: sha256 });

const mergeOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mcpServer"), name: z.string(), value: z.unknown() }),
  z.object({
    type: z.literal("hook"),
    event: z.string(),
    matcher: z.string().optional(),
    command: z.unknown(),
  }),
  z.object({ type: z.literal("statusLine"), value: z.unknown() }),
]);

const spoolSchema = z.object({
  schema: z.literal(1),
  harness: z.string(),
  version: z.string(),
  cli: cliId,
  scope,
  builtAt: z.string(),
  files: z.array(
    z.object({
      slot: slotKind,
      destRel: z.string(),
      archivePath: z.string(),
      sha: sha256,
      logicalName: z.string(),
      frontmatterName: z.string().optional(),
    }),
  ),
  payloads: z.array(
    z.object({
      id: z.string(),
      baseRel: z.string(),
      archiveDir: z.string(),
      entries: z.array(payloadEntry),
    }),
  ),
  fragments: z.array(
    z.object({
      id: z.string(),
      mergeInto,
      op: mergeOp,
      valueSha: sha256,
    }),
  ),
  placeholders: z.array(z.string()),
  delegate: z
    .object({
      installCmd: z.string(),
      uninstallCmd: z.string(),
      upgradeCmd: z.string().optional(),
      dir: z.string(),
      requires: z.array(z.string()),
      summary: z.string().optional(),
      ref: z.string(),
      version: z.string(),
    })
    .optional(),
  archiveSha: sha256,
});

// ── receipt ──
const fragmentLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcpServer"), name: z.string() }),
  z.object({ kind: z.literal("hook"), event: z.string(), matcher: z.string().optional() }),
  z.object({ kind: z.literal("statusLine") }),
]);

const receiptSchema = z.object({
  schema: z.literal(1),
  receiptId: z.string(),
  harness: z.string(),
  version: z.string(),
  cli: cliId,
  scope,
  scopeKey: z.string(),
  projectPath: z.string().optional(),
  installedAt: z.string(),
  weftVersion: z.string(),
  spoolSha: sha256,
  status: z.literal("installed"),
  placedFiles: z.array(
    z.object({
      slot: slotKind,
      absPath: z.string(),
      sha: sha256,
      shadowed: shadowRecord.optional(),
      renamedFrom: z.string().optional(),
    }),
  ),
  placedPayloads: z.array(
    z.object({
      id: z.string(),
      baseAbs: z.string(),
      entries: z.array(payloadEntry.extend({ shadowed: shadowRecord.optional() })),
    }),
  ),
  appliedFragments: z.array(
    z.object({
      id: z.string(),
      targetAbs: z.string(),
      mergeInto,
      locator: fragmentLocator,
      valueSha: sha256,
    }),
  ),
  resolvedPlaceholders: z.record(z.string(), z.string()),
  delegation: z
    .object({
      installCmd: z.string(),
      uninstallCmd: z.string(),
      dir: z.string(),
      exitCode: z.number(),
      ranAt: z.string(),
    })
    .optional(),
  notes: z.array(z.string()).optional(),
});

/** Validate (and narrow) untrusted input into each artifact type. Throws `ZodError` on mismatch. */
export const parsePattern = (input: unknown): HarnessPattern => patternSchema.parse(input) as HarnessPattern;
export const parseIndex = (input: unknown): Index => indexSchema.parse(input) as Index;
export const parseSpool = (input: unknown): Spool => spoolSchema.parse(input) as Spool;
export const parseReceipt = (input: unknown): Receipt => receiptSchema.parse(input) as Receipt;
