import type {
  AppliedFragment,
  CliId,
  FileArtifact,
  FragmentLocator,
  MergeFragment,
  MergeInto,
  MergeOp,
  Scope,
  SlotKind,
} from "@weft/schema";

/**
 * Where weft resolves paths from. Injected (never read from `process` directly) so tests
 * can point at a temp dir instead of the real home.
 */
export interface ResolveCtx {
  /** Base for `global` scope (a home directory). */
  home: string;
  /** Base for `local` scope (the resolved project root). */
  projectRoot: string;
}

/** A shared config file parsed into memory. The adapter knows its concrete JSON shape. */
export interface ParsedConfig {
  path: string;
  /** Parsed object, mutated in place by merge/unmerge. `{}` when the file is absent. */
  data: Record<string, unknown>;
  existed: boolean;
  /** True if the file existed but couldn't be parsed (syntax error) — unsafe to rewrite. */
  unparsable: boolean;
  /**
   * True if rewriting this file loses content the parser can't round-trip (e.g. TOML comments via
   * smol-toml). JSON/JSONC round-trips comments, so it's never set there. The caller surfaces a
   * warning rather than silently normalizing the user's file.
   */
  lossyReserialize?: boolean;
}

export interface MergeResult {
  /** False if we declined to apply (e.g. a foreign entry already owns the key). */
  applied: boolean;
  /** How to re-find this entry on uninstall. */
  locator: FragmentLocator;
  warnings: string[];
}

export interface UnmergeResult {
  removed: boolean;
  /** True if the on-disk value differed from what we recorded — left untouched, not clobbered. */
  conflict: boolean;
  warnings: string[];
}

/** Build-time inverse of a merge: the ops pulled out of a captured config file, plus the keys consumed. */
export interface DecomposedConfig {
  /** One op per hook command / mcp server found in the captured config. */
  ops: MergeOp[];
  /** Top-level keys this decomposition consumed, so the loom can report the unmerged remainder. */
  consumedKeys: string[];
}

export interface NamespacedArtifact {
  artifact: FileArtifact;
  /** The destRel before renaming (recorded in the receipt). */
  renamedFrom: string;
  /** If set, the file content must be rewritten (e.g. an agent's frontmatter `name:`). */
  rewriteContent?: (content: string) => string;
}

/**
 * The per-CLI seam. Everything CLI-specific (paths, config shapes, identity, namespacing)
 * lives behind this. Adding a CLI = one new implementation + one registry line.
 */
export interface CliAdapter {
  readonly id: CliId;

  /** Directory holding an independent-file slot (`skill`/`agent`/`command`) for a scope. */
  slotRoot(slot: SlotKind, scope: Scope, ctx: ResolveCtx): string;
  /** Absolute path of the shared config file a `mergeInto` map targets, for a scope. */
  configFilePath(mergeInto: MergeInto, scope: Scope, ctx: ResolveCtx): string;
  /** Base dir under which `payload` slots are placed (payload `baseRel` joins onto this). */
  payloadBase(scope: Scope, ctx: ResolveCtx): string;

  /** Permissive read; returns an empty config if the file is missing. */
  readConfig(absPath: string): ParsedConfig;
  /** Serialize a (possibly mutated) config back to a string (strict JSON). */
  serializeConfig(cfg: ParsedConfig): string;
  /** Fold one fragment into `cfg.data` (mutates), recording how to find it later. */
  mergeFragment(cfg: ParsedConfig, frag: MergeFragment): MergeResult;
  /** Remove a previously-applied fragment by provenance + value hash (mutates). */
  unmergeFragment(cfg: ParsedConfig, applied: AppliedFragment): UnmergeResult;
  /**
   * Build-time inverse of {@link mergeFragment}: pull the merge ops (and the top-level keys they
   * consume) out of a parsed captured config for one map. Lets the loom decompose a captured CLI
   * config (e.g. a snapshot's `settings.json`) into fragments that merge into the user's real config
   * — instead of placing it as an opaque file that would clobber it. Returns no ops for a map this
   * CLI doesn't keep in a mergeable file.
   */
  decomposeConfig(data: Record<string, unknown>, mergeInto: MergeInto): DecomposedConfig;

  /** Collision identity. Skill/command share a namespace (Claude unified them); agents use frontmatter name. */
  artifactIdentity(art: FileArtifact): string;
  /** Apply a harness namespace prefix (rename + rewrite agent frontmatter name where needed). */
  applyNamespace(art: FileArtifact, prefix: string): NamespacedArtifact;
}
