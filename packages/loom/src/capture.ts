import { execSync } from "node:child_process";
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { sha256OfBytes, sha256OfValue } from "@weft/schema";
import type {
  CaptureSpec,
  CliId,
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
 * Build one spool by running the harness's own installer in a sandbox and snapshotting its
 * output. The whole config tree becomes a single payload rooted at the CLI's config dir
 * (`baseRel: ""`), so the existing payload-placement + `{{WEFT_PAYLOAD_DIR}}` resolution path
 * installs it verbatim. The only rewrite is generic: the absolute sandbox config path the
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

  // ── 1. run the upstream installer in a throwaway, HOME-isolated sandbox ──
  const sandbox = mkdtempSync(join(tmpdir(), `weft-capture-${harnessId}-`));
  const scopeFlag = scope === "global" ? "--global" : "--local";
  const cmd = capture.installCmd
    .split("{pkg}").join(pkg)
    .split("{version}").join(version)
    .split("{scopeFlag}").join(scopeFlag);
  try {
    execSync(cmd, {
      cwd: sandbox,
      env: { ...process.env, HOME: sandbox, npm_config_yes: "true", CI: "1", DO_NOT_TRACK: "1" },
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

  // Longest-first so the config path is consumed before the bare sandbox root it sits under.
  const pathRewrites: { from: string; to: string }[] = [
    { from: configReal, to: PAYLOAD_PLACEHOLDER },
    { from: configRaw, to: PAYLOAD_PLACEHOLDER },
    ...[...nodePaths].map((from) => ({ from, to: "node" })),
    ...(capture.normalize ?? []),
  ].sort((a, b) => b.from.length - a.from.length);

  const templatize = (text: string): string => {
    let out = text;
    for (const r of pathRewrites) if (r.from) out = out.split(r.from).join(r.to);
    return out;
  };

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

  for (const rel of walkRel(configReal, configReal).sort()) {
    const buf = readFileSync(join(configReal, rel));
    let data: Buffer | string;
    if (buf.includes(0)) {
      data = buf; // binary: verbatim
    } else {
      const original = buf.toString("utf8");
      const text = templatize(original);
      if (text.includes(PAYLOAD_PLACEHOLDER)) usedPlaceholder = true;
      // Any surviving machine-specific path means the spool isn't portable to other machines.
      for (const root of leakRoots) {
        if (text.includes(root)) {
          leaks.add(rel);
          break;
        }
      }
      data = text;
    }
    entries.push({ rel, sha: sha256OfBytes(data) });
    write(`${archiveDir}/${rel}`, data);
  }

  if (entries.length === 0) {
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
    fragments: [],
    placeholders: usedPlaceholder ? ["WEFT_PAYLOAD_DIR"] : [],
    archiveSha,
  };

  return { spool, notes };
}
