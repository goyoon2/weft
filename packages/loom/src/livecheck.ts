import { execFileSync } from "node:child_process";
import { coerce, rcompare, valid } from "semver";
import type { HarnessPattern, LivecheckSpec, LivecheckStrategy, SourceSpec } from "@weft/schema";

/**
 * **Livecheck** — observe the newest *upstream* version of a harness without rebuilding it. This is
 * weft's Homebrew-`livecheck` analogue: a cheap metadata call (npm registry / GitHub API / a single
 * `git ls-remote`) that lets a scheduled job spot drift between the version the catalog was *built*
 * at and what upstream now *ships*. The expensive part — actually fetching the source and producing
 * spools — stays in `build.ts`; this module only answers "what's the latest version number?".
 *
 * The pure helpers ({@link deriveLivecheckStrategy}, {@link pickHighestTag}) are unit-tested; the
 * network resolvers are exercised live by the mill's `scripts/livecheck.ts`.
 */

export interface UpstreamObservation {
  /** The resolved upstream version (e.g. `"1.7.0"`), or `null` when the pattern opted out. */
  version: string | null;
  /** The strategy actually used (`"skip"` when opted out). */
  strategy: LivecheckStrategy | "skip";
  /** Human description of where the value came from, e.g. `"npm dist-tag latest"`. */
  via: string;
  /** Present when the pattern opted out via `livecheck.skip`. */
  skipped?: { reason: string };
}

// ───────────────────────────── pure helpers (unit-tested, no I/O) ─────────────────────────────

/** Default strategy for a source when the pattern declares no explicit `livecheck.strategy`. */
export function deriveLivecheckStrategy(source: SourceSpec): LivecheckStrategy {
  switch (source.type) {
    case "npm":
      return "npm-dist-tag";
    case "git":
      return "git-tags";
    case "github-release":
      return "github-latest";
  }
}

/** A `*`-only glob (e.g. `"v*"`) compiled to an anchored RegExp. */
function tagGlobToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

/** Normalize a raw tag to a clean semver string (`"v1.2.3"` → `"1.2.3"`), or `null` if it isn't one. */
function toSemver(tag: string): string | null {
  const exact = valid(tag);
  if (exact) return exact;
  const coerced = coerce(tag);
  return coerced ? coerced.version : null;
}

/**
 * From a list of raw tag names, return the highest **semver** version, or `null` if none parse.
 * `tagPattern` (a `*`-glob over the raw tag name) pre-filters before semver parsing.
 */
export function pickHighestTag(tags: string[], opts?: { tagPattern?: string }): string | null {
  const re = opts?.tagPattern ? tagGlobToRegExp(opts.tagPattern) : undefined;
  const versions = tags
    .filter((t) => (re ? re.test(t) : true))
    .map(toSemver)
    .filter((v): v is string => v !== null);
  if (versions.length === 0) return null;
  versions.sort(rcompare);
  return versions[0]!;
}

/** Resolve `owner/repo` for the GitHub strategies from the source, an explicit hint, or the homepage. */
function githubRepoOf(pattern: HarnessPattern, lc: LivecheckSpec | undefined): string {
  if (pattern.source.type === "github-release") return pattern.source.repo;
  // For a git source the source URL is the repo itself — prefer it over homepage; `repoUrl` still wins.
  const gitUrl = pattern.source.type === "git" ? pattern.source.url : undefined;
  const hint = lc?.repoUrl ?? gitUrl ?? pattern.homepage;
  const fromUrl = hint?.match(/github\.com[:/]+([^/]+\/[^/#?.]+)/);
  if (fromUrl?.[1]) return fromUrl[1];
  if (hint && /^[^/\s]+\/[^/\s]+$/.test(hint)) return hint;
  throw new Error(
    "github strategy needs a github-release source, livecheck.repoUrl, or a github.com homepage",
  );
}

// ───────────────────────────── network resolvers ─────────────────────────────

/** npm registry metadata only — `npm view … dist-tags` never downloads a tarball. */
function resolveNpmDistTag(pkg: string, tag: string): { version: string; via: string } {
  const out = execFileSync("npm", ["view", pkg, "dist-tags", "--json"], { encoding: "utf8" });
  const tags = JSON.parse(out) as Record<string, string>;
  const version = tags[tag];
  if (!version) {
    throw new Error(`npm dist-tag "${tag}" not found for ${pkg} (have: ${Object.keys(tags).join(", ") || "none"})`);
  }
  return { version, via: `npm dist-tag ${tag}` };
}

/** One `git ls-remote --tags` — no clone, no checkout. */
function resolveGitTags(url: string, tagPattern?: string): { version: string; via: string } {
  const out = execFileSync("git", ["ls-remote", "--tags", "--refs", url], { encoding: "utf8" });
  const tags = out
    .split("\n")
    .map((line) => line.split("\t")[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/^refs\/tags\//, ""));
  const version = pickHighestTag(tags, { tagPattern });
  if (!version) throw new Error(`no semver tags at ${url}`);
  return { version, via: `git tag (${tags.length} refs)` };
}

async function githubApi(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "weft-livecheck",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function resolveGithubLatest(repo: string): Promise<{ version: string; via: string }> {
  const rel = (await githubApi(`/repos/${repo}/releases/latest`)) as { tag_name?: string };
  if (!rel.tag_name) throw new Error(`no "latest" release for ${repo}`);
  return { version: toSemver(rel.tag_name) ?? rel.tag_name, via: `github release ${rel.tag_name}` };
}

async function resolveGithubTags(repo: string, tagPattern?: string): Promise<{ version: string; via: string }> {
  const tags = (await githubApi(`/repos/${repo}/tags?per_page=100`)) as Array<{ name: string }>;
  const version = pickHighestTag(
    tags.map((t) => t.name),
    { tagPattern },
  );
  if (!version) throw new Error(`no semver tags for ${repo}`);
  return { version, via: `github tags (${tags.length})` };
}

/**
 * Read a version file from a repo over a raw GitHub URL — a single cheap GET, no clone. The trimmed
 * file contents ARE the version (verbatim, not semver-coerced) so they compare equal to a build that
 * read the same file via `delegate.versionFile`. For tagless branch-tracked repos (e.g. gstack).
 */
async function resolveVersionFile(repo: string, ref: string, file: string): Promise<{ version: string; via: string }> {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file.replace(/^\/+/, "")}`;
  const res = await fetch(url, { headers: { "User-Agent": "weft-livecheck" } });
  if (!res.ok) throw new Error(`version file ${url} → ${res.status} ${res.statusText}`);
  const version = (await res.text()).trim();
  if (!version) throw new Error(`version file ${file} @ ${ref} is empty`);
  return { version, via: `${file} @ ${ref}` };
}

// ───────────────────────────── public entrypoint ─────────────────────────────

/**
 * Observe the newest upstream version for one pattern. Uses `pattern.livecheck` when present,
 * otherwise the strategy derived from `pattern.source`. Throws on a resolution failure (no version
 * found, network/registry error) so callers can report it per-pattern.
 */
export async function resolveUpstreamVersion(pattern: HarnessPattern): Promise<UpstreamObservation> {
  const lc = pattern.livecheck;
  if (lc?.skip) {
    return { version: null, strategy: "skip", via: "skipped", skipped: { reason: lc.skipReason ?? "" } };
  }

  const strategy = lc?.strategy ?? deriveLivecheckStrategy(pattern.source);
  switch (strategy) {
    case "npm-dist-tag": {
      if (pattern.source.type !== "npm") {
        throw new Error(`npm-dist-tag strategy needs an npm source (got "${pattern.source.type}")`);
      }
      const { version, via } = resolveNpmDistTag(pattern.source.package, lc?.distTag ?? "latest");
      return { version, strategy, via };
    }
    case "git-tags": {
      const url = lc?.repoUrl ?? (pattern.source.type === "git" ? pattern.source.url : undefined);
      if (!url) throw new Error("git-tags strategy needs a git source url or livecheck.repoUrl");
      const { version, via } = resolveGitTags(url, lc?.tagPattern);
      return { version, strategy, via };
    }
    case "github-latest": {
      const { version, via } = await resolveGithubLatest(githubRepoOf(pattern, lc));
      return { version, strategy, via };
    }
    case "github-tags": {
      const { version, via } = await resolveGithubTags(githubRepoOf(pattern, lc), lc?.tagPattern);
      return { version, strategy, via };
    }
    case "version-file": {
      if (!lc?.versionFile) throw new Error("version-file strategy needs livecheck.versionFile");
      // Read the same ref the build uses, so livecheck and build agree on the version string.
      const ref = pattern.source.type === "git" ? (pattern.source.ref ?? "main") : "main";
      const { version, via } = await resolveVersionFile(githubRepoOf(pattern, lc), ref, lc.versionFile);
      return { version, strategy, via };
    }
  }
}
