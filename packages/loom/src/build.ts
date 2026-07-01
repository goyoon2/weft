import { execFileSync } from "node:child_process";
import {
  type Dirent,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { coerce } from "semver";
import { create as tarCreate, extract as tarExtract } from "tar";
import {
  extractPlaceholders,
  isResolvablePlaceholder,
  RESOLVABLE_PLACEHOLDERS,
  sha256OfBytes,
  sha256OfFile,
  sha256OfValue,
} from "@weft/schema";
import type {
  CliId,
  FileArtifact,
  HarnessPattern,
  MergeFragment,
  PayloadArtifact,
  PayloadEntry,
  Scope,
  Sha256,
  SlotKind,
  SlotMapRule,
  Spool,
  TargetBuildSpec,
  TransformRule,
} from "@weft/schema";
import { buildCapturedSpoolForTarget } from "./capture";
import { buildDelegatedSpoolForTarget } from "./delegate";
import { pickHighestTag } from "./livecheck";

export interface BuiltSpool {
  cli: CliId;
  scope: Scope;
  tgzPath: string;
  spoolSha: Sha256;
  spoolJsonSha: Sha256;
  spool: Spool;
}

export interface BuildResult {
  harness: string;
  version: string;
  spools: BuiltSpool[];
  notes: string[];
}

export interface BuildOptions {
  /** Mill root; spools are written under `<outDir>/spools/<id>/<version>/`. */
  outDir: string;
  /** Explicit version; defaults to the fetched/declared version. */
  version?: string;
  /** Skip fetching and build from this source tree (used by tests for hermetic builds). */
  sourceDir?: string;
  /** Scopes to build; defaults to both. */
  scopes?: Scope[];
}

// ───────────────────────────── glob / template helpers ─────────────────────────────

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*\*/g, "\x00").replace(/\*/g, "[^/]*").replace(/\x00/g, ".*");
  return new RegExp(`^${body}$`);
}

function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

/** `${name}` capture: the stem of the first wildcard segment of `fromGlob` in `matchedRel`. */
function captureName(fromGlob: string, matchedRel: string): string {
  const gParts = fromGlob.split("/");
  const mParts = matchedRel.split("/");
  const i = gParts.findIndex((p) => p.includes("*"));
  if (i < 0 || i >= mParts.length) return matchedRel;
  let seg = mParts[i] ?? "";
  const gseg = gParts[i] ?? "";
  const dot = gseg.indexOf(".");
  if (gseg.startsWith("*") && dot >= 0) {
    const ext = gseg.slice(dot);
    if (seg.endsWith(ext)) seg = seg.slice(0, -ext.length);
  }
  return seg;
}

function asDest(as: string): { kind: string; tmpl: string } {
  const i = as.indexOf(":");
  if (i < 0) return { kind: as, tmpl: "" };
  return { kind: as.slice(0, i), tmpl: as.slice(i + 1) };
}

function fillName(tmpl: string, name: string): string {
  return tmpl.split("${name}").join(name);
}

/**
 * Reject a slot/payload name that could escape its install root (path traversal). Interior slashes
 * are allowed — Claude supports nested command/agent namespaces and a skill is a whole sub-tree — but
 * a `..` segment or an absolute path is not. Defense-in-depth at the source: a bad pattern fails the
 * mill build (CI) here rather than publishing a spool the client must then refuse to place.
 */
function safeName(name: string, what: string): string {
  if (!name) throw new Error(`loom: empty ${what}`);
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`loom: ${what} "${name}" must be a relative path, not absolute`);
  }
  for (const seg of name.split(/[\\/]/)) {
    if (seg === "..") throw new Error(`loom: ${what} "${name}" escapes its slot root ("..")`);
  }
  return name;
}

function slotDir(slot: SlotKind): string {
  switch (slot) {
    case "agent":
      return "agents";
    case "command":
      return "commands";
    case "skill":
      return "skills";
    default:
      return slot;
  }
}

function frontmatterName(content: string): string | undefined {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const line = (fm[1] ?? "").match(/^name:\s*(.+?)\s*$/m);
  return line ? (line[1] ?? "").replace(/^["']|["']$/g, "") : undefined;
}

function applyTransforms(text: string, transforms: TransformRule[], relForMatch: string): string {
  let out = text;
  for (const t of transforms) {
    if (t.type === "substitute-var" && matchGlob(t.appliesTo, relForMatch)) {
      out = out.split(t.from).join(t.to);
    }
  }
  return out;
}

function loadContent(
  abs: string,
  relForMatch: string,
  transforms: TransformRule[],
): { data: Buffer | string; text?: string } {
  const buf = readFileSync(abs);
  if (buf.includes(0)) return { data: buf }; // binary: copy verbatim
  const text = applyTransforms(buf.toString("utf8"), transforms, relForMatch);
  return { data: text, text };
}

function walkFiles(absDir: string, root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    // Never bundle a VCS metadata dir. A skill whose `SKILL.md` sits at the repo ROOT (common for
    // single-skill repos) walks the whole fetched tree — which for a git source includes `.git/`.
    // No artifact ever wants VCS internals shipped, so skip it defensively (the published npm/tarball
    // paths never contain `.git`, so this only ever bites the git-clone path).
    if (entry.name === ".git") continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, root));
    else if (entry.isFile()) out.push(relative(root, abs));
  }
  return out;
}

/** Resolve a `from` glob to file paths relative to `root`. `dir/**` recurses dir explicitly. */
function globFiles(pattern: string, root: string): string[] {
  if (pattern.endsWith("/**")) {
    return walkFiles(join(root, pattern.slice(0, -3)), root).sort();
  }
  return globSync(pattern, { cwd: root })
    .filter((rel) => {
      try {
        return statSync(join(root, rel)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Files a `from` glob yields, minus anything matching one of the rule's `exclude` globs. Lets a map
 * rule skip non-artifact files that live in an artifact directory (e.g. per-category `README.md`
 * index files sitting next to real agent `.md`), which a glob alone can't express.
 */
function selectFiles(rule: SlotMapRule, root: string): string[] {
  // Only an inline `mcp-server`/`status-line` rule omits `from`; every file-placing rule supplies it
  // (enforced in `validate.ts`). Guard so the optional `from` narrows to a string for the glob below.
  if (!rule.from) return [];
  const matches = globFiles(rule.from, root);
  if (!rule.exclude?.length) return matches;
  return matches.filter((rel) => !rule.exclude?.some((ex) => matchGlob(ex, rel)));
}

/**
 * Pull the server map out of an upstream MCP config file. Upstreams ship the map under various keys
 * (`mcpServers` for Claude/Gemini/Cursor, `mcp` for OpenCode, `mcp_servers` for Codex) or, rarely, as
 * a bare top-level map of name → server. Returns the inner `name → value` object, or undefined.
 */
function extractServerMap(parsed: unknown): Record<string, unknown> | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  for (const key of ["mcpServers", "mcp", "mcp_servers"]) {
    const inner = obj[key];
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  // A bare map: every value is an object (a server def). Avoids mistaking a wrapper for the map.
  const values = Object.values(obj);
  if (values.length > 0 && values.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
    return obj;
  }
  return undefined;
}

/** Strip a leading source-path prefix (a payload rule's `rebase`) from `rel`, so a payload tree can
 *  be rooted at a sub-path of the source. No-op when `rel` doesn't start with the prefix. */
function rebaseRel(rel: string, rebase?: string): string {
  if (!rebase) return rel;
  const prefix = rebase.endsWith("/") ? rebase : `${rebase}/`;
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
}

// ───────────────────────────── per-target spool build ─────────────────────────────

function buildSpoolForTarget(args: {
  pattern: HarnessPattern;
  target: TargetBuildSpec;
  cli: CliId;
  scope: Scope;
  sourceRoot: string;
  stagingDir: string;
  version: string;
}): { spool: Spool; notes: string[] } {
  const { pattern, target, cli, scope, sourceRoot, stagingDir, version } = args;
  const transforms = target.transforms ?? [];
  const notes: string[] = [];

  const files: FileArtifact[] = [];
  const payloadMap = new Map<string, PayloadArtifact>();
  const fragments: MergeFragment[] = [];
  const placeholders = new Set<string>();
  let hookCounter = 0;
  let mcpCounter = 0;
  let statusLineCounter = 0;

  const write = (archivePath: string, data: Buffer | string): void => {
    const abs = join(stagingDir, archivePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  };

  for (const rule of target.map ?? []) {
    const { tmpl } = asDest(rule.as);

    // mcp-server and status-line are the slots that can carry their registration INLINE (no upstream
    // file), so handle them before the `from` guard below. The MCP runtime model (fragment →
    // mcpServers merge → per-CLI config placement → uninstall reversal) already exists end-to-end;
    // this only emits the fragment.
    if (rule.kind === "mcp-server") {
      // (a) Inline registration declared in the pattern — the common case for an upstream launched by
      // a published command (`npx`/`uvx`/binary). The name comes from `as` ("mcpServer:<name>"); the
      // value (`server`) is folded verbatim under mcpServers, exactly like a captured server fragment.
      if (rule.server !== undefined) {
        const name = safeName(tmpl, `mcp-server name (rule "${rule.as}")`);
        fragments.push({
          id: `${pattern.id}#mcp-${String(mcpCounter++).padStart(4, "0")}`,
          mergeInto: "mcpServers",
          op: { type: "mcpServer", name, value: rule.server },
          valueSha: sha256OfValue(rule.server),
        });
        continue;
      }
      // (b) File-based: an upstream that ships a static `.mcp.json` — read its server map and decompose
      // each entry into an individually-mergeable fragment (the same shape the captured path emits).
      if (rule.from) {
        const abs = join(sourceRoot, rule.from);
        let raw: string;
        try {
          raw = readFileSync(abs, "utf8");
        } catch {
          notes.push(`${cli}/${scope}: mcp-server source "${rule.from}" not found`);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(applyTransforms(raw, transforms, rule.from));
        } catch {
          notes.push(`${cli}/${scope}: mcp-server source "${rule.from}" is not valid JSON`);
          continue;
        }
        const servers = extractServerMap(parsed);
        if (!servers || Object.keys(servers).length === 0) {
          notes.push(`${cli}/${scope}: mcp-server source "${rule.from}" has no server map`);
          continue;
        }
        for (const [name, value] of Object.entries(servers)) {
          fragments.push({
            id: `${pattern.id}#mcp-${String(mcpCounter++).padStart(4, "0")}`,
            mergeInto: "mcpServers",
            op: { type: "mcpServer", name, value },
            valueSha: sha256OfValue(value),
          });
        }
      }
      continue;
    }

    // status-line is the one slot that carries its value INLINE (no upstream file), so handle it
    // before the `from` guard below. It folds a single `statusLine` object into the CLI's settings;
    // its `{{WEFT_PAYLOAD_DIR}}` placeholder (e.g. in a `bash …/statusline.sh` command) resolves at
    // install, like a hook command.
    if (rule.kind === "status-line") {
      if (!rule.statusLine) {
        notes.push(`${cli}/${scope}: status-line rule "${rule.as}" needs an inline "statusLine" value`);
        continue;
      }
      fragments.push({
        id: `${pattern.id}#statusline-${String(statusLineCounter++).padStart(4, "0")}`,
        mergeInto: "statusLine",
        op: { type: "statusLine", value: rule.statusLine },
        valueSha: sha256OfValue(rule.statusLine),
      });
      for (const p of extractPlaceholders(JSON.stringify(rule.statusLine))) placeholders.add(p);
      continue;
    }

    // Every remaining slot kind places/reads files selected by `from`; narrow it for all below.
    if (!rule.from) {
      notes.push(`${cli}/${scope}: rule "${rule.as}" (${rule.kind}) missing 'from'`);
      continue;
    }

    if (rule.kind === "skill") {
      // A skill IS its directory: `from` selects skills by their `SKILL.md`, and we bundle that
      // file plus every sibling (reference docs, scripts, sub-dirs) so multi-file skills install
      // intact. The logical name comes from the captured skill-dir name; namespacing on collision
      // prefixes the whole dir, keeping a skill's files together.
      const matches = selectFiles(rule, sourceRoot);
      if (matches.length === 0) notes.push(`${cli}/${scope}: rule "${rule.from}" matched no files`);
      for (const rel of matches) {
        const name = captureName(rule.from, rel);
        const logicalName = safeName(fillName(tmpl, name), `skill name (rule "${rule.as}")`);
        const skillDir = dirname(rel);
        for (const fileRel of walkFiles(join(sourceRoot, skillDir), sourceRoot)) {
          // `exclude` also prunes the bundled tree (not just the SKILL.md match). Essential for a
          // ROOT-level skill (skillDir = ".") so repo chrome — README/LICENSE/.github/CI — isn't
          // shipped inside the skill; for a normal `skills/<name>/` dir it's usually unnecessary.
          if (rule.exclude?.some((ex) => matchGlob(ex, fileRel))) continue;
          const destRel = `${logicalName}/${relative(skillDir, fileRel)}`;
          const archivePath = `files/skills/${destRel}`;
          const { data } = loadContent(join(sourceRoot, fileRel), fileRel, transforms);
          files.push({ slot: "skill", destRel, archivePath, sha: sha256OfBytes(data), logicalName });
          write(archivePath, data);
        }
      }
      continue;
    }

    if (rule.kind === "agent" || rule.kind === "command") {
      const matches = selectFiles(rule, sourceRoot);
      if (matches.length === 0) notes.push(`${cli}/${scope}: rule "${rule.from}" matched no files`);
      for (const rel of matches) {
        const name = captureName(rule.from, rel);
        const logicalName = safeName(fillName(tmpl, name), `${rule.kind} name (rule "${rule.as}")`);
        const destRel = `${logicalName}.md`;
        const archivePath = `files/${slotDir(rule.kind)}/${destRel}`;
        const { data, text } = loadContent(join(sourceRoot, rel), rel, transforms);
        files.push({
          slot: rule.kind,
          destRel,
          archivePath,
          sha: sha256OfBytes(data),
          logicalName,
          frontmatterName: rule.kind === "agent" ? frontmatterName(text ?? "") : undefined,
        });
        write(archivePath, data);
      }
      continue;
    }

    if (rule.kind === "payload") {
      const id = safeName(tmpl, `payload id (rule "${rule.as}")`);
      const existing = payloadMap.get(id) ?? { id, baseRel: id, archiveDir: `payloads/${id}`, entries: [] };
      const matches = selectFiles(rule, sourceRoot);
      for (const rel of matches) {
        // Read + transform-match by the SOURCE rel, but STORE under the rebased rel (so a payload can
        // be rooted at a sub-path of the source, e.g. `src/hooks/x` → `hooks/x`).
        const { data } = loadContent(join(sourceRoot, rel), rel, transforms);
        const storedRel = safeName(rebaseRel(rel, rule.rebase), `payload entry (rule "${rule.as}")`);
        const entry: PayloadEntry = { rel: storedRel, sha: sha256OfBytes(data) };
        existing.entries.push(entry);
        write(`${existing.archiveDir}/${storedRel}`, data);
      }
      existing.entries.sort((a, b) => a.rel.localeCompare(b.rel));
      payloadMap.set(id, existing);
      continue;
    }

    if (rule.kind === "hook") {
      const abs = join(sourceRoot, rule.from);
      let raw: string;
      try {
        raw = readFileSync(abs, "utf8");
      } catch {
        notes.push(`${cli}/${scope}: hook source "${rule.from}" not found`);
        continue;
      }
      const transformed = applyTransforms(raw, transforms, rule.from);
      const parsed = JSON.parse(transformed) as { hooks?: Record<string, unknown> };
      const hookMap = parsed.hooks ?? {};
      for (const event of Object.keys(hookMap)) {
        const groups = hookMap[event];
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          if (group === null || typeof group !== "object") continue;
          const g = group as { matcher?: unknown; hooks?: unknown };
          const matcher = typeof g.matcher === "string" ? g.matcher : undefined;
          const commands = Array.isArray(g.hooks) ? g.hooks : [];
          for (const command of commands) {
            fragments.push({
              id: `${pattern.id}#hook-${String(hookCounter++).padStart(4, "0")}`,
              mergeInto: "hooks",
              op: { type: "hook", event, matcher, command },
              valueSha: sha256OfValue(command),
            });
          }
        }
      }
      continue;
    }

    notes.push(`${cli}/${scope}: unsupported rule kind "${rule.kind}"`);
  }

  // weft placeholders are exactly those the loom INTRODUCES via transforms (e.g. WEFT_PAYLOAD_DIR).
  // A harness's own {{...}} template tokens are not weft's and must pass through untouched.
  for (const t of transforms) extractPlaceholders(t.to).forEach((p) => placeholders.add(p));

  // Fail at build time on a placeholder the client can't resolve — otherwise the spool parses fine
  // and then throws on every user's install. Keeps both ends of the placeholder contract in sync.
  for (const p of placeholders) {
    if (!isResolvablePlaceholder(p)) {
      throw new Error(
        `loom: transform introduces unresolvable placeholder {{${p}}} (resolvable: ${RESOLVABLE_PLACEHOLDERS.join(", ")})`,
      );
    }
  }

  const payloads = [...payloadMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Aggregate content fingerprint over every declared artifact (order-independent).
  const fingerprint = [
    ...files.map((f) => ({ p: f.archivePath, sha: f.sha })),
    ...payloads.flatMap((pl) => pl.entries.map((e) => ({ p: `${pl.archiveDir}/${e.rel}`, sha: e.sha }))),
  ].sort((a, b) => a.p.localeCompare(b.p));

  const spool: Spool = {
    schema: 1,
    harness: pattern.id,
    version,
    cli,
    scope,
    builtAt: new Date().toISOString(),
    files: files.sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
    payloads,
    fragments,
    placeholders: [...placeholders].sort(),
    archiveSha: sha256OfValue(fingerprint),
  };

  return { spool, notes };
}

// ───────────────────────────── source fetch ─────────────────────────────

function readPkgVersion(root: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Resolve the highest semver git tag at `url` to its raw ref (for checkout) and clean version. */
function resolveLatestGitTag(url: string, tagPattern?: string): { rawTag: string; version: string } {
  const out = execFileSync("git", ["ls-remote", "--tags", "--refs", url], { encoding: "utf8" });
  const rawTags = out
    .split("\n")
    .map((line) => line.split("\t")[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/^refs\/tags\//, ""));
  const version = pickHighestTag(rawTags, { tagPattern });
  if (!version) throw new Error(`loom: no semver tags at ${url}`);
  const rawTag = rawTags.find((t) => coerce(t)?.version === version) ?? version;
  return { rawTag, version };
}

/**
 * Shallow-clone a git source into a temp dir. A pinned `source.ref` (or an explicit build version)
 * is checked out verbatim; otherwise we resolve the highest semver tag — mirroring the `git-tags`
 * livecheck strategy, so what we build matches what livecheck observes as latest.
 */
function fetchGitSource(
  pattern: HarnessPattern,
  version: string | undefined,
): { root: string; version: string } {
  if (pattern.source.type !== "git") throw new Error("loom: fetchGitSource needs a git source");
  const { url, ref } = pattern.source;
  const parent = mkdtempSync(join(tmpdir(), "weft-src-"));
  const root = join(parent, "repo");

  let checkout: string;
  let resolved: string;
  if (ref) {
    checkout = ref;
    resolved = coerce(ref)?.version ?? ref;
  } else if (version) {
    checkout = version;
    resolved = coerce(version)?.version ?? version;
  } else {
    ({ rawTag: checkout, version: resolved } = resolveLatestGitTag(url, pattern.livecheck?.tagPattern));
  }

  try {
    execFileSync(
      "git",
      [
        // Neutralize Git LFS: treat pointer files as plain content. weft only needs the
        // source tree (SKILL.md, scripts) — never the multi-MB LFS example artifacts some
        // repos ship — and smudging them fails on CI runners where git-lfs is installed but
        // the repo is over its LFS data/bandwidth quota. These overrides make the clone
        // deterministic and independent of whether git-lfs is installed at all.
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.required=false",
        "clone",
        "--depth",
        "1",
        "--branch",
        checkout,
        url,
        root,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(`loom: git clone failed for ${url}@${checkout}${stderr ? `\n${stderr}` : ""}`);
  }
  return { root, version: resolved };
}

async function fetchSource(
  pattern: HarnessPattern,
  version: string | undefined,
): Promise<{ root: string; version: string }> {
  if (pattern.source.type === "git") return fetchGitSource(pattern, version);
  if (pattern.source.type !== "npm") {
    throw new Error(`loom: source type "${pattern.source.type}" not yet supported`);
  }
  const parent = mkdtempSync(join(tmpdir(), "weft-src-"));
  const spec = `${pattern.source.package}@${version ?? pattern.versioning.track ?? "latest"}`;
  const out = execFileSync("npm", ["pack", spec, "--pack-destination", parent, "--json"], {
    encoding: "utf8",
  });
  const meta = (JSON.parse(out) as Array<{ filename: string; version: string }>)[0];
  if (!meta) throw new Error(`loom: npm pack returned no metadata for ${spec}`);
  await tarExtract({ file: join(parent, meta.filename), cwd: parent });
  return { root: join(parent, "package"), version: meta.version };
}

// ───────────────────────────── public build entrypoint ─────────────────────────────

export async function buildHarness(pattern: HarnessPattern, opts: BuildOptions): Promise<BuildResult> {
  const scopes = opts.scopes ?? (["global", "local"] satisfies Scope[]);

  let sourceRoot: string;
  let version: string;
  if (opts.sourceDir) {
    sourceRoot = opts.sourceDir;
    version = opts.version ?? readPkgVersion(opts.sourceDir) ?? "0.0.0";
  } else {
    const fetched = await fetchSource(pattern, opts.version);
    sourceRoot = fetched.root;
    version = fetched.version;
  }

  const spools: BuiltSpool[] = [];
  const notes: string[] = [];

  // A delegated target may pin the version to a file in the source tree (e.g. gstack's `VERSION`),
  // since such whole-repo tools often carry no git tags. First versionFile found wins (one version
  // per pattern). Read after fetch so we have the checked-out tree.
  const versionFile = Object.values(pattern.targets).find(
    (t) => t?.strategy === "delegated" && t.delegate?.versionFile,
  )?.delegate?.versionFile;
  if (versionFile) {
    try {
      version = readFileSync(join(sourceRoot, versionFile), "utf8").trim() || version;
    } catch {
      notes.push(`delegate versionFile "${versionFile}" not found in source; using "${version}"`);
    }
  }
  // The git ref the delegated recipe is built at (becomes `{ref}` in install commands).
  const gitRef = pattern.source.type === "git" ? (pattern.source.ref ?? version) : version;

  for (const cli of Object.keys(pattern.targets) as CliId[]) {
    const target = pattern.targets[cli];
    if (!target) continue;
    if (
      target.strategy !== "declarative" &&
      target.strategy !== "captured" &&
      target.strategy !== "delegated"
    ) {
      notes.push(`skip ${cli}: strategy "${target.strategy}" not supported in this build`);
      continue;
    }
    for (const scope of scopes) {
      const stagingDir = mkdtempSync(join(tmpdir(), `weft-spool-${pattern.id}-`));

      let built: { spool: Spool; notes: string[] };
      if (target.strategy === "delegated") {
        if (!target.delegate) {
          notes.push(`skip ${cli}/${scope}: delegated strategy needs a "delegate" block`);
          continue;
        }
        const d = buildDelegatedSpoolForTarget({
          harnessId: pattern.id,
          delegate: target.delegate,
          cli,
          scope,
          version,
          ref: gitRef,
        });
        if (!d.spool) {
          notes.push(...d.notes);
          continue; // this scope isn't targeted by the delegate (e.g. global-only tool)
        }
        built = { spool: d.spool, notes: d.notes };
      } else if (target.strategy === "captured") {
        if (!target.capture) {
          notes.push(`skip ${cli}/${scope}: captured strategy needs a "capture" block`);
          continue;
        }
        if (pattern.source.type !== "npm") {
          notes.push(`skip ${cli}/${scope}: captured strategy currently assumes an npm source`);
          continue;
        }
        built = buildCapturedSpoolForTarget({
          harnessId: pattern.id,
          pkg: pattern.source.package,
          capture: target.capture,
          cli,
          scope,
          version,
          stagingDir,
        });
      } else {
        built = buildSpoolForTarget({ pattern, target, cli, scope, sourceRoot, stagingDir, version });
      }
      const { spool, notes: n } = built;
      notes.push(...n);

      writeFileSync(join(stagingDir, "spool.json"), `${JSON.stringify(spool, null, 2)}\n`);

      const tgzDir = join(opts.outDir, "spools", pattern.id, version);
      mkdirSync(tgzDir, { recursive: true });
      const tgzPath = join(tgzDir, `${cli}.${scope}.spool.tgz`);
      const entries = ["spool.json", "files", "payloads"].filter((e) => {
        try {
          statSync(join(stagingDir, e));
          return true;
        } catch {
          return false;
        }
      });
      await tarCreate({ gzip: true, file: tgzPath, cwd: stagingDir }, entries);

      spools.push({
        cli,
        scope,
        tgzPath,
        spoolSha: await sha256OfFile(tgzPath),
        spoolJsonSha: sha256OfBytes(readFileSync(join(stagingDir, "spool.json"))),
        spool,
      });
    }
  }

  return { harness: pattern.id, version, spools, notes };
}
