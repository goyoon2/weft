/**
 * Core weft data model. These are the serialized shapes shared by every package:
 * the mill author writes a {@link HarnessPattern}; the loom builds a {@link Spool};
 * the mill publishes an {@link Index}; the client records a {@link Receipt}.
 *
 * This module is pure types — no runtime code — so it erases completely at build.
 */

/** A content hash, always `sha256:<64 lowercase hex>`. */
export type Sha256 = `sha256:${string}`;

/** Host CLIs weft can target. The vertical slice implements only `claude-code`. */
export type CliId = "claude-code" | "codex" | "gemini" | "cursor" | "opencode";

/** Where a harness is installed. `global` = home dir; `local` = the current project (cwd). */
export type Scope = "global" | "local";

/**
 * The CLI-agnostic vocabulary the loom emits and adapters consume.
 * - `skill`/`agent`/`command` — independent files placed in a slot directory.
 * - `hook`/`mcp-server` — merge fragments folded into a shared config file.
 * - `payload` — an opaque directory tree placed at a CLI base dir (e.g. an out-of-tree runtime).
 */
export type SlotKind = "skill" | "agent" | "command" | "hook" | "mcp-server" | "payload";

/** Which shared config map a fragment merges into. */
export type MergeInto = "hooks" | "mcpServers";

// ───────────────────────────── pattern (mill source) ─────────────────────────────

export type SourceSpec =
  | { type: "npm"; package: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "github-release"; repo: string; assetPattern?: string };

/** One declarative mapping from a source glob to a logical slot. */
export interface SlotMapRule {
  kind: SlotKind;
  /** Glob relative to the fetched source root, e.g. `"agents/*.md"`. */
  from: string;
  /**
   * Logical destination template. `${name}` is captured from the file/dir name.
   * Examples: `"agent:${name}"`, `"command:gsd-${name}"`, `"payload:gsd-core"`, `"hook"`.
   */
  as: string;
  /** For shared-file slots only. */
  mergeInto?: MergeInto;
}

/** A content transform applied to assembled spool files at build time. */
export interface TransformRule {
  type: "substitute-var";
  /** Glob (relative to the assembled spool tree) of files to rewrite. */
  appliesTo: string;
  /** Literal token to replace, e.g. `"${CLAUDE_PLUGIN_ROOT}"`. */
  from: string;
  /** Replacement, normally a spool placeholder like `"{{WEFT_PAYLOAD_DIR}}"`. */
  to: string;
}

/** A literal string normalization applied to captured text (machine/env leak → placeholder). */
export interface CaptureNormalizeRule {
  /** Literal substring to replace, e.g. an absolute node path the installer baked in. */
  from: string;
  /** Replacement, often a spool placeholder like `"{{WEFT_PAYLOAD_DIR}}"` or a bare command. */
  to: string;
}

/**
 * The `captured` strategy: run the harness's own installer once, in a throwaway sandbox, and
 * snapshot exactly what it produced — so weft never re-implements per-installer rewrites by hand.
 * The only generic re-localization is turning the (known) sandbox install path back into a
 * placeholder; everything else the installer emitted is taken verbatim.
 */
export interface CaptureSpec {
  /**
   * Command run inside the sandbox to produce a real install. Tokens substituted before running:
   * `{pkg}` (source package), `{version}`, `{scopeFlag}` (`--global` / `--local`).
   */
  installCmd: string;
  /**
   * The config directory the installer produces, relative to the sandbox root (e.g. `".claude"`).
   * Use the `{ global, local }` form when the installer targets different dirs per scope
   * (e.g. opencode: `.config/opencode` globally vs `.opencode` locally).
   */
  configDir: string | { global: string; local: string };
  /** Extra normalizations beyond the automatic sandbox-path/node-path ones. */
  normalize?: CaptureNormalizeRule[];
}

export interface TargetBuildSpec {
  strategy: "declarative" | "captured";
  /** Declarative strategy: explicit slot mappings. */
  map?: SlotMapRule[];
  /** Captured strategy (future): run the upstream installer in a sandbox and diff. */
  capture?: CaptureSpec;
  /** Content transforms applied after mapping. */
  transforms?: TransformRule[];
}

export interface NamespaceSpec {
  mode: "as-is" | "prefix";
  prefix?: string;
}

/** How `resolveUpstreamVersion` discovers the newest upstream version (the strategy keys mirror Homebrew livecheck strategies). */
export type LivecheckStrategy =
  /** Read a dist-tag (default `latest`) from the npm registry — metadata only, no tarball. */
  | "npm-dist-tag"
  /** `git ls-remote --tags`, pick the highest semver tag. */
  | "git-tags"
  /** The repo's "latest" GitHub release tag (`/releases/latest`). */
  | "github-latest"
  /** Highest semver among the repo's git tags via the GitHub API (`/tags`). */
  | "github-tags";

/**
 * Optional **livecheck** descriptor — the Homebrew-`livecheck` analogue. Declares how to *observe*
 * the newest upstream version cheaply (a registry/API metadata call, no tarball download) so a
 * scheduled job can detect drift between what the catalog was built at and what upstream now ships
 * — without a full rebuild.
 *
 * When omitted, the check is **derived** from {@link SourceSpec} (+ `versioning.track`):
 *   - `npm`            → the `latest` dist-tag (`npm-dist-tag`)
 *   - `git`            → highest semver tag (`git-tags`)
 *   - `github-release` → the latest published release (`github-latest`)
 *
 * Add a block only to override that default or to opt out.
 */
export interface LivecheckSpec {
  /** Opt this pattern out of version observation — the `no_autobump!` analogue. Requires `skipReason`. */
  skip?: boolean;
  /** Why it's excluded (mirrors Homebrew's mandatory `no_autobump!` reason). Required when `skip`. */
  skipReason?: string;
  /** Override the strategy derived from `source`. */
  strategy?: LivecheckStrategy;
  /** `npm-dist-tag`: which dist-tag to read (default `latest`). */
  distTag?: string;
  /** `git-tags`/`github-tags`: only consider tags matching this glob, e.g. `"v*"`. */
  tagPattern?: string;
  /** `git-tags`: query this repo URL when it differs from `source` (rare). */
  repoUrl?: string;
}

/** A human-authored harness recipe (`weft-mill/patterns/<id>.yaml`). The formula analogue. */
export interface HarnessPattern {
  schema: 1;
  id: string;
  displayName: string;
  description: string;
  homepage?: string;
  keywords?: string[];
  source: SourceSpec;
  versioning: { strategy: "semver"; track?: "latest" | "tagged" };
  namespace?: NamespaceSpec;
  /** How to observe upstream version drift. Optional — derived from `source` when omitted. */
  livecheck?: LivecheckSpec;
  /** Presence of a CLI key declares support for that CLI. */
  targets: Partial<Record<CliId, TargetBuildSpec>>;
}

// ───────────────────────────── index (mill catalog) ─────────────────────────────

export interface SpoolRef {
  cli: CliId;
  scope: Scope;
  /** `file://…` during the slice; `https://…` once hosted. */
  url: string;
  spoolSha: Sha256;
  spoolJsonSha: Sha256;
}

export interface IndexVersion {
  version: string;
  spools: SpoolRef[];
}

export interface IndexEntry {
  id: string;
  displayName: string;
  description: string;
  homepage?: string;
  keywords: string[];
  latest: string;
  clis: CliId[];
  versions: IndexVersion[];
}

/** The thin catalog `weft update` downloads. */
export interface Index {
  schema: 1;
  /**
   * Optional build timestamp. Omitted from the committed mill catalog so a pure upstream-version
   * bump produces a clean, single-harness diff (a wall-clock stamp would churn every rebuild).
   */
  generatedAt?: string;
  entries: IndexEntry[];
}

// ───────────────────────────── spool (built artifact) ─────────────────────────────

export interface FileArtifact {
  slot: SlotKind;
  /** Destination relative to the resolved slot root, e.g. `"gsd-foo.md"` or `"gsd-foo/SKILL.md"`. */
  destRel: string;
  /** Path of the file inside the spool archive payload. */
  archivePath: string;
  /** Hash of the (post-transform) content. */
  sha: Sha256;
  logicalName: string;
  /** For agents: the frontmatter `name:` we wrote (identity for collisions/uninstall). */
  frontmatterName?: string;
}

export interface PayloadEntry {
  rel: string;
  sha: Sha256;
}

export interface PayloadArtifact {
  id: string;
  /** Base dir relative to the CLI payload base, e.g. `"gsd-core"`. */
  baseRel: string;
  /** Directory inside the spool archive holding the tree. */
  archiveDir: string;
  entries: PayloadEntry[];
}

export type MergeOp =
  | { type: "mcpServer"; name: string; value: unknown }
  | { type: "hook"; event: string; matcher?: string; command: unknown };

export type MergeTarget = "settings.json" | "mcp.json" | "claude.json-user";

export interface MergeFragment {
  /** Stable provenance id, e.g. `"gsd-core#hook-0007"`. */
  id: string;
  target: MergeTarget;
  mergeInto: MergeInto;
  op: MergeOp;
  /** Canonical hash of the inserted value, for verify-before-remove. */
  valueSha: Sha256;
}

/** A normalized, ready-to-merge snapshot for one `(harness, version, cli, scope)`. */
export interface Spool {
  schema: 1;
  harness: string;
  version: string;
  cli: CliId;
  scope: Scope;
  builtAt: string;
  files: FileArtifact[];
  payloads: PayloadArtifact[];
  fragments: MergeFragment[];
  /** Placeholders the client must resolve at install, e.g. `["WEFT_PAYLOAD_DIR"]`. */
  placeholders: string[];
  /** Integrity of the archive payload. */
  archiveSha: Sha256;
}

// ───────────────────────────── receipt (install state) ─────────────────────────────

export interface ShadowRecord {
  backupPath: string;
  originalSha: Sha256;
}

export interface PlacedFile {
  slot: SlotKind;
  absPath: string;
  sha: Sha256;
  /** Present if we overwrote a pre-existing file (backed up for restore on uninstall). */
  shadowed?: ShadowRecord;
  /** Present if collision namespacing renamed this artifact. */
  renamedFrom?: string;
}

export interface PlacedPayload {
  id: string;
  baseAbs: string;
  entries: PayloadEntry[];
}

export type FragmentLocator =
  | { kind: "mcpServer"; name: string }
  | { kind: "hook"; event: string; matcher?: string };

export interface AppliedFragment {
  id: string;
  targetAbs: string;
  mergeInto: MergeInto;
  /** How to re-find the entry on uninstall. */
  locator: FragmentLocator;
  /** Canonical hash of the value we placed (verify-before-remove). */
  valueSha: Sha256;
}

/** The exact record of one successful install (`~/.weft/receipts/<receiptId>.json`). */
export interface Receipt {
  schema: 1;
  receiptId: string;
  harness: string;
  version: string;
  cli: CliId;
  scope: Scope;
  /** `"global"` or `"local:sha256:<realpath(projectRoot)>"`. */
  scopeKey: string;
  /** Plaintext realpath (local scope only) for human listing. */
  projectPath?: string;
  installedAt: string;
  weftVersion: string;
  spoolSha: Sha256;
  status: "installed";
  placedFiles: PlacedFile[];
  placedPayloads: PlacedPayload[];
  appliedFragments: AppliedFragment[];
  resolvedPlaceholders: Record<string, string>;
  /** Fidelity warnings surfaced to the user. */
  notes?: string[];
}
