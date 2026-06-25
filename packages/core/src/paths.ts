import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256OfBytes } from "@weft/schema";
import type { Scope } from "@weft/schema";
import type { ResolveCtx } from "@weft/adapters";

/** The runtime environment a weft operation runs against. All paths derive from here. */
export interface WeftEnv {
  /** Base for `global` scope. */
  home: string;
  /** weft's own state root (`~/.weft`). */
  weftDir: string;
  /** Working directory; the `local` scope project root derives from this. */
  cwd: string;
  /** Where `weft update` pulls the catalog from (a path or `file://`/`https://` URL). */
  millIndexSource: string;
  /** Version string stamped into receipts. */
  weftVersion: string;
}

/** Build an env from process state. Refuses the real HOME under tests unless explicitly overridden. */
export function defaultEnv(overrides: Partial<WeftEnv> = {}): WeftEnv {
  const override = process.env.WEFT_HOME_OVERRIDE;
  if (process.env.NODE_ENV === "test" && !override && !overrides.home) {
    throw new Error("weft: refusing to use the real HOME under NODE_ENV=test; set WEFT_HOME_OVERRIDE");
  }
  const home = overrides.home ?? override ?? homedir();
  const weftDir = overrides.weftDir ?? join(home, ".weft");
  const millDir = process.env.WEFT_MILL_DIR;
  const millIndexSource =
    overrides.millIndexSource ??
    process.env.WEFT_INDEX_URL ??
    (millDir ? join(millDir, "index.json") : join(weftDir, "cache", "index.json"));
  return {
    home,
    weftDir,
    cwd: overrides.cwd ?? process.cwd(),
    millIndexSource,
    weftVersion: overrides.weftVersion ?? "0.0.0",
  };
}

export function stateDirs(env: WeftEnv): {
  receipts: string;
  cache: string;
  spools: string;
  backups: string;
  journal: string;
  locks: string;
  indexCache: string;
} {
  const cache = join(env.weftDir, "cache");
  return {
    receipts: join(env.weftDir, "receipts"),
    cache,
    spools: join(cache, "spools"),
    backups: join(env.weftDir, "backups"),
    journal: join(env.weftDir, "journal"),
    locks: join(env.weftDir, "locks"),
    indexCache: join(cache, "index.json"),
  };
}

/** Resolve adapter context. `projectRoot` is the realpath of cwd (matches how Claude reads cwd). */
export function resolveCtx(env: WeftEnv): ResolveCtx {
  let projectRoot: string;
  try {
    projectRoot = realpathSync(env.cwd);
  } catch {
    projectRoot = env.cwd;
  }
  return { home: env.home, projectRoot };
}

/** `"global"` or `"local:sha256:<realpath>"` — the receipt lookup key for a scope + cwd. */
export function scopeKeyFor(scope: Scope, ctx: ResolveCtx): string {
  return scope === "global" ? "global" : `local:${sha256OfBytes(ctx.projectRoot)}`;
}
