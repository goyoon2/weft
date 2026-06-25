import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256OfBytes } from "@weft/schema";
import { stateDirs } from "./paths";
import type { WeftEnv } from "./paths";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A coarse mkdir-based advisory lock. `mkdir` is atomic, so the first creator wins;
 * a lock older than `staleMs` is reclaimed (a previous run that crashed).
 */
async function acquireLock(lockDir: string, staleMs = 60_000, timeoutMs = 30_000): Promise<() => void> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return () => {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* lock vanished; retry */
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`weft: timed out acquiring lock ${lockDir} (another weft process running?)`);
      }
      await sleep(80);
    }
  }
}

/**
 * Journaled, locked, atomic file mutation. Records a pre-image of every path it touches;
 * `rollback()` restores them (or deletes paths it created), making a multi-file
 * install/uninstall/upgrade all-or-nothing.
 */
export class Transaction {
  private readonly txId = randomUUID();
  private readonly journalDir: string;
  private readonly pre: { path: string; existed: boolean }[] = [];
  private release?: () => void;

  constructor(private readonly env: WeftEnv) {
    this.journalDir = join(stateDirs(env).journal, this.txId);
  }

  async begin(): Promise<void> {
    const dirs = stateDirs(this.env);
    mkdirSync(dirs.locks, { recursive: true });
    mkdirSync(this.journalDir, { recursive: true });
    this.release = await acquireLock(join(dirs.locks, "global.lock.d"));
  }

  private journalPathFor(path: string): string {
    return join(this.journalDir, sha256OfBytes(path).slice("sha256:".length));
  }

  /** Snapshot a path before mutating it (idempotent per path). */
  recordPre(path: string): void {
    if (this.pre.some((r) => r.path === path)) return;
    const existed = existsSync(path);
    if (existed) copyFileSync(path, this.journalPathFor(path));
    this.pre.push({ path, existed });
  }

  writeFileAtomic(path: string, data: Buffer | string): void {
    this.recordPre(path);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.weft-tmp-${this.txId}`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  removeFile(path: string): void {
    this.recordPre(path);
    if (existsSync(path)) rmSync(path);
  }

  async commit(): Promise<void> {
    rmSync(this.journalDir, { recursive: true, force: true });
    this.release?.();
  }

  async rollback(): Promise<void> {
    for (let i = this.pre.length - 1; i >= 0; i--) {
      const entry = this.pre[i];
      if (!entry) continue;
      try {
        if (entry.existed) {
          mkdirSync(dirname(entry.path), { recursive: true });
          copyFileSync(this.journalPathFor(entry.path), entry.path);
        } else if (existsSync(entry.path)) {
          rmSync(entry.path, { recursive: true, force: true });
        }
      } catch {
        /* best-effort restore */
      }
    }
    rmSync(this.journalDir, { recursive: true, force: true });
    this.release?.();
  }
}
