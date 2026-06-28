import { execSync } from "node:child_process";
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { sha256OfBytes, sha256OfValue } from "@weft/schema";
import { getAdapter } from "@weft/adapters";
import type {
  CaptureSpec,
  CliId,
  MergeFragment,
  MergeInto,
  PayloadArtifact,
  PayloadEntry,
  Scope,
  Spool,
  Sha256,
} from "@weft/schema";

/** The single placeholder a captured spool introduces: the install-time config root (`.claude`). */
const PAYLOAD_PLACEHOLDER = "{{WEFT_PAYLOAD_DIR}}";

function walkRel(absDir: string, root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) out.push(...walkRel(abs, root));
    else if (entry.isFile()) out.push(relative(root, abs));
  }
  return out;
}

export interface CapturedBuild {
  spool: Spool;
  notes: string[];
}

/**
 * Build one spool by running the harness's own installer against a throwaway, redirected HOME and
 * snapshotting its output. NOTE: this is build-time HOME/XDG **redirection** (a temp HOME plus XDG
 * bases pinned inside it), NOT a security sandbox — the child inherits the build machine's network,
 * filesystem, and `process.env`, so this strategy runs only for patterns the mill operator has
 * reviewed and chosen to build. The whole config tree becomes a single payload rooted at the CLI's
 * config dir (`baseRel: ""`), so the existing payload-placement + `{{WEFT_PAYLOAD_DIR}}` resolution
 * path installs it verbatim. The only rewrite is generic: the absolute sandbox config path the
 * installer baked into its files is turned back into `{{WEFT_PAYLOAD_DIR}}`.
 */
export function buildCapturedSpoolForTarget(args: {
  harnessId: string;
  pkg: string;
  capture: CaptureSpec;
  cli: CliId;
  scope: Scope;
  version: string;
  stagingDir: string;
}): CapturedBuild {
  const { harnessId, pkg, capture, cli, scope, version, stagingDir } = args;
  const notes: string[] = [];
  const adapter = getAdapter(cli);

  // ── 1. run the upstream installer against a throwaway, redirected HOME (build-time, not a sandbox) ──
  const sandbox = mkdtempSync(join(tmpdir(), `weft-capture-${harnessId}-`));
  const scopeFlag = scope === "global" ? "--global" : "--local";
  const cmd = capture.installCmd
    .split("{pkg}").join(pkg)
    .split("{version}").join(version)
    .split("{scopeFlag}").join(scopeFlag);
  try {
    execSync(cmd, {
      cwd: sandbox,
      // HOME alone doesn't contain an installer: XDG_* point outside it on many machines
      // (GitHub-hosted runners set XDG_CONFIG_HOME), so an XDG-aware installer — e.g. opencode's
      // global config dir — would write OUTSIDE the snapshot and capture would find nothing.
      // Pin every XDG base inside the sandbox so the result is identical on macOS, Linux, and CI.
      env: {
        ...process.env,
        HOME: sandbox,
        XDG_CONFIG_HOME: join(sandbox, ".config"),
        XDG_DATA_HOME: join(sandbox, ".local", "share"),
        XDG_STATE_HOME: join(sandbox, ".local", "state"),
        XDG_CACHE_HOME: join(sandbox, ".cache"),
        npm_config_yes: "true",
        CI: "1",
        DO_NOT_TRACK: "1",
      },
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new Error(
      `loom: capture install failed for ${cli}/${scope}\n  cmd: ${cmd}\n  ${e.stderr || e.stdout || e.message}`,
    );
  }

  // ── 2. locate what it produced ──
  const configRel = typeof capture.configDir === "string" ? capture.configDir : capture.configDir[scope];
  const configRaw = join(sandbox, configRel);
  let configReal: string;
  try {
    configReal = realpathSync(configRaw);
  } catch {
    throw new Error(
      `loom: capture for ${cli}/${scope} produced no config dir at "${configRel}" (cmd: ${cmd})`,
    );
  }
  const sandboxReal = realpathSync(sandbox);

  // Every spelling of THIS build machine's `node`, all normalized to a bare `node`. An installer
  // commonly records `which node` (e.g. the Homebrew symlink `/opt/homebrew/bin/node`) while
  // `process.execPath` is the resolved target (`…/Cellar/node/<v>/bin/node`); both — and their
  // realpaths — must rewrite, or a machine path leaks into the spool. In CI these resolve to the
  // runner's node automatically, so the same code keeps the artifact portable wherever it builds.
  const nodePaths = new Set<string>();
  const addNode = (p: string | undefined): void => {
    if (!p) return;
    nodePaths.add(p);
    try {
      nodePaths.add(realpathSync(p));
    } catch {
      /* a non-existent candidate spelling is fine to skip */
    }
  };
  addNode(process.execPath);
  try {
    addNode(execSync("command -v node", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    /* no `node` on PATH — process.execPath still covers us */
  }

  // The whole sandbox (cwd == HOME == every XDG base) is the throwaway build root: the only things
  // under it are the captured config dir AND build-time noise — the npx unpack of the upstream package
  // (`<sandbox>/.npm/_npx/<hash>/node_modules/<pkg>`), the temp HOME, etc. An installer that records
  // absolute *source* paths in a self-describing receipt (e.g. ECC's `ecc-install-state.json`, whose
  // `operations[].sourcePath` points at the unpack dir) bakes a sandbox-rooted path that ISN'T the
  // config dir, so the configReal/configRaw rewrites miss it and it leaks. Re-localize the bare sandbox
  // root too — it has no meaning to the installed user, and like configReal it collapses to the payload
  // dir. Listed AFTER configReal/configRaw and sorted longest-first, so a destination path under the
  // config dir is still consumed by the (longer) configReal rule before this shorter root rule sees it.
  const pathRewrites: { from: string; to: string }[] = [
    { from: configReal, to: PAYLOAD_PLACEHOLDER },
    { from: configRaw, to: PAYLOAD_PLACEHOLDER },
    { from: sandboxReal, to: PAYLOAD_PLACEHOLDER },
    { from: sandbox, to: PAYLOAD_PLACEHOLDER },
    ...[...nodePaths].map((from) => ({ from, to: "node" })),
    ...(capture.normalize ?? []),
  ].sort((a, b) => b.from.length - a.from.length);

  const templatize = (text: string): string => {
    let out = text;
    for (const r of pathRewrites) if (r.from) out = out.split(r.from).join(r.to);
    return out;
  };

  // ── shared-config decomposition setup ──
  // A captured CLI config that lives INSIDE the snapshot (Claude's settings.json, Codex's
  // config.toml, …) must NOT be placed as an opaque payload file — that overwrites the user's real
  // config on install. Decompose each into merge fragments instead. The file's location comes from
  // the SAME adapter logic the runtime uses, so a map whose file resolves OUTSIDE the captured dir
  // (e.g. Claude's global mcp in ~/.claude.json) simply isn't in the snapshot, and is skipped here.
  const configMaps = new Map<string, MergeInto[]>();
  for (const mergeInto of ["mcpServers", "hooks"] as MergeInto[]) {
    let cfgAbs: string;
    try {
      cfgAbs = adapter.configFilePath(mergeInto, scope, { home: sandbox, projectRoot: sandbox });
    } catch {
      continue; // this CLI keeps no mergeable file for this map (e.g. cursor/opencode hooks)
    }
    const rel = relative(configRaw, cfgAbs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue; // lives outside the captured dir
    const list = configMaps.get(rel) ?? [];
    list.push(mergeInto);
    configMaps.set(rel, list);
  }
  const parseTmp = mkdtempSync(join(tmpdir(), `weft-decompose-${harnessId}-`));

  // ── 3. snapshot every file into one root payload, re-localizing the install path ──
  const write = (archivePath: string, data: Buffer | string): void => {
    const abs = join(stagingDir, archivePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  };

  const archiveDir = `payloads/${harnessId}`;
  const entries: PayloadEntry[] = [];
  let usedPlaceholder = false;
  const leaks = new Set<string>();

  // Machine-specific path roots that must NOT survive into a portable spool — derived from
  // runtime facts only (no distro/CI hardcoding): the build sandbox, the build user's real HOME,
  // and the node bin dir(s) (a sibling tool path like `/opt/homebrew/bin/npm` is just as
  // non-portable). Anything still matching one of these after rewriting is reported as a leak.
  const leakRoots = new Set<string>();
  const addRoot = (p: string | undefined): void => {
    if (p && p !== "/") leakRoots.add(p);
  };
  addRoot(sandbox);
  addRoot(sandboxReal);
  addRoot(homedir());
  for (const n of nodePaths) addRoot(dirname(n));

  const fragments: MergeFragment[] = [];
  const unmergedKeys = new Map<string, string[]>(); // captured config rel → keys weft can't merge
  let hookSeq = 0;
  let mcpSeq = 0;

  // Re-localize a non-binary file's text into a portable copy, flagging any surviving machine path.
  const localize = (rel: string, buf: Buffer): string => {
    const text = templatize(buf.toString("utf8"));
    if (text.includes(PAYLOAD_PLACEHOLDER)) usedPlaceholder = true;
    for (const root of leakRoots) {
      if (text.includes(root)) {
        leaks.add(rel);
        break;
      }
    }
    return text;
  };

  for (const rel of walkRel(configReal, configReal).sort()) {
    const buf = readFileSync(join(configReal, rel));
    const maps = configMaps.get(rel);

    // ── shared-config file → decompose into merge fragments; never place it as a payload file ──
    if (maps && !buf.includes(0)) {
      const text = localize(rel, buf);
      const stage = join(parseTmp, rel);
      mkdirSync(dirname(stage), { recursive: true });
      writeFileSync(stage, text);
      const cfg = adapter.readConfig(stage);
      if (cfg.unparsable) {
        // Can't safely decompose; place it (status quo) rather than silently dropping the config.
        notes.push(`${cli}/${scope}: captured ${rel} isn't parseable — placed as-is (may overwrite a user's ${rel})`);
        entries.push({ rel, sha: sha256OfBytes(text) });
        write(`${archiveDir}/${rel}`, text);
        continue;
      }
      const consumed = new Set<string>();
      for (const mergeInto of maps) {
        const { ops, consumedKeys } = adapter.decomposeConfig(cfg.data, mergeInto);
        for (const k of consumedKeys) consumed.add(k);
        for (const op of ops) {
          fragments.push(
            op.type === "hook"
              ? {
                  id: `${harnessId}#hook-${String(hookSeq++).padStart(4, "0")}`,
                  mergeInto: "hooks",
                  op,
                  valueSha: sha256OfValue(op.command),
                }
              : {
                  id: `${harnessId}#mcp-${String(mcpSeq++).padStart(4, "0")}`,
                  mergeInto: "mcpServers",
                  op,
                  valueSha: sha256OfValue(op.value),
                },
          );
        }
      }
      const leftover = Object.keys(cfg.data).filter((k) => !consumed.has(k));
      if (leftover.length) unmergedKeys.set(rel, leftover);
      continue;
    }

    // ── ordinary captured file → payload entry (binary verbatim, text re-localized) ──
    const data: Buffer | string = buf.includes(0) ? buf : localize(rel, buf);
    entries.push({ rel, sha: sha256OfBytes(data) });
    write(`${archiveDir}/${rel}`, data);
  }
  rmSync(parseTmp, { recursive: true, force: true });

  // Keys in a captured shared-config that weft can't merge (e.g. gsd's settings.json `statusLine` /
  // `permissions`) are intentionally NOT applied — the user's own config keeps them. Surface, never drop silently.
  for (const [rel, keys] of unmergedKeys) {
    notes.push(
      `${cli}/${scope}: captured ${rel} also set ${keys.sort().join(", ")} which weft does not merge — ` +
        `not applied (the user's ${rel} keeps its own)`,
    );
  }
  if (entries.length === 0 && fragments.length === 0) {
    notes.push(`${cli}/${scope}: captured install produced no files`);
  }
  if (leaks.size > 0) {
    notes.push(
      `LEAK ${cli}/${scope}: ${leaks.size} captured file(s) still contain a machine-specific ` +
        `absolute path (not re-localized): ${[...leaks].slice(0, 5).join(", ")}${leaks.size > 5 ? " …" : ""}`,
    );
  }

  // weft places one payload rooted at the CLI's payloadBase, so anything the installer wrote
  // OUTSIDE the captured config dir (e.g. a global ~/.gsd defaults file) is not included.
  // Surface it rather than dropping it silently.
  const ignore = new Set([
    configRel.split("/")[0],
    ".npm",
    ".config", // XDG_CONFIG_HOME — pinned into the sandbox; not part of any one CLI's surface
    ".cache",
    ".npmrc",
    ".node_repl_history",
    ".node-gyp",
    ".local",
  ]);
  const extras = readdirSync(sandboxReal).filter((n) => !ignore.has(n));
  if (extras.length > 0) {
    notes.push(
      `${cli}/${scope}: installer also wrote outside "${configRel}" (NOT captured): ${extras.sort().join(", ")}`,
    );
  }

  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  const payload: PayloadArtifact = { id: harnessId, baseRel: "", archiveDir, entries };

  const fingerprint = entries
    .map((e) => ({ p: `${archiveDir}/${e.rel}`, sha: e.sha }))
    .sort((a, b) => a.p.localeCompare(b.p));

  const archiveSha: Sha256 = sha256OfValue(fingerprint);

  const spool: Spool = {
    schema: 1,
    harness: harnessId,
    version,
    cli,
    scope,
    builtAt: new Date().toISOString(),
    files: [],
    payloads: [payload],
    fragments,
    placeholders: usedPlaceholder ? ["WEFT_PAYLOAD_DIR"] : [],
    archiveSha,
  };

  return { spool, notes };
}
