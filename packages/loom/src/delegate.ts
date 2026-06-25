import { sha256OfValue } from "@weft/schema";
import type { CliId, DelegateRecipe, DelegateSpec, Scope, Spool } from "@weft/schema";

/**
 * Build a `delegated` (cask) spool: no static files — just the recipe weft will run on the user's
 * machine at install time. We resolve only the build-time tokens here (`{ref}`, `{version}`); the
 * client substitutes `{dir}`/`{home}`/`{scopeFlag}` at install (it alone knows the user's home).
 *
 * Returns `spool: null` (with a note) for a scope the delegate doesn't target — e.g. a tool that only
 * installs globally has no `dir.local`, so weft ships no local spool for it.
 */
export function buildDelegatedSpoolForTarget(args: {
  harnessId: string;
  delegate: DelegateSpec;
  cli: CliId;
  scope: Scope;
  version: string;
  /** The git ref the recipe was built at (e.g. `"main"` or a tag); becomes `{ref}`. */
  ref: string;
}): { spool: Spool | null; notes: string[] } {
  const { harnessId, delegate, cli, scope, version, ref } = args;
  const notes: string[] = [];

  const dir = delegate.dir[scope];
  if (!dir) {
    notes.push(`skip ${cli}/${scope}: delegate has no "dir.${scope}" (this scope is not supported)`);
    return { spool: null, notes };
  }

  const recipe: DelegateRecipe = {
    installCmd: delegate.installCmd,
    uninstallCmd: delegate.uninstallCmd,
    upgradeCmd: delegate.upgradeCmd,
    dir,
    requires: delegate.requires ?? [],
    summary: delegate.summary,
    ref,
    version,
  };

  const spool: Spool = {
    schema: 1,
    harness: harnessId,
    version,
    cli,
    scope,
    builtAt: new Date().toISOString(),
    files: [],
    payloads: [],
    fragments: [],
    placeholders: [],
    delegate: recipe,
    // The recipe IS the content — fingerprint it so a changed command/dir/version changes the sha.
    archiveSha: sha256OfValue(recipe),
  };

  return { spool, notes };
}
