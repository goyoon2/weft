import { z } from "zod";
import type { HarnessPattern, Index, Receipt, Spool } from "./types";

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex>");
const cliId = z.enum(["claude-code", "codex", "gemini", "cursor", "opencode"]);
const scope = z.enum(["global", "local"]);
const slotKind = z.enum(["skill", "agent", "command", "hook", "mcp-server", "payload"]);
const mergeInto = z.enum(["hooks", "mcpServers"]);
const mergeTarget = z.enum(["settings.json", "mcp.json", "claude.json-user"]);

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

const slotMapRule = z.object({
  kind: slotKind,
  from: z.string().min(1),
  as: z.string().min(1),
  mergeInto: mergeInto.optional(),
});

const transformRule = z.object({
  type: z.literal("substitute-var"),
  appliesTo: z.string().min(1),
  from: z.string().min(1),
  to: z.string(),
});

const targetBuildSpec = z.object({
  strategy: z.enum(["declarative", "captured"]),
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
  transforms: z.array(transformRule).optional(),
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
  namespace: z
    .object({ mode: z.enum(["as-is", "prefix"]), prefix: z.string().optional() })
    .optional(),
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
  generatedAt: z.string(),
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
      target: mergeTarget,
      mergeInto,
      op: mergeOp,
      valueSha: sha256,
    }),
  ),
  placeholders: z.array(z.string()),
  archiveSha: sha256,
});

// ── receipt ──
const fragmentLocator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcpServer"), name: z.string() }),
  z.object({ kind: z.literal("hook"), event: z.string(), matcher: z.string().optional() }),
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
      shadowed: z.object({ backupPath: z.string(), originalSha: sha256 }).optional(),
      renamedFrom: z.string().optional(),
    }),
  ),
  placedPayloads: z.array(
    z.object({ id: z.string(), baseAbs: z.string(), entries: z.array(payloadEntry) }),
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
  notes: z.array(z.string()).optional(),
});

/** Validate (and narrow) untrusted input into each artifact type. Throws `ZodError` on mismatch. */
export const parsePattern = (input: unknown): HarnessPattern => patternSchema.parse(input) as HarnessPattern;
export const parseIndex = (input: unknown): Index => indexSchema.parse(input) as Index;
export const parseSpool = (input: unknown): Spool => spoolSchema.parse(input) as Spool;
export const parseReceipt = (input: unknown): Receipt => receiptSchema.parse(input) as Receipt;
