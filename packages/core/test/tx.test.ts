import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Transaction } from "../src/tx";
import type { WeftEnv } from "../src/paths";

const cleanup: string[] = [];
function makeEnv(): WeftEnv {
  const home = mkdtempSync(join(tmpdir(), "weft-tx-"));
  cleanup.push(home);
  return { home, weftDir: join(home, ".weft"), cwd: home, millIndexSource: "x", weftVersion: "t" };
}
afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("Transaction", () => {
  it("rolls back: restores overwritten files and deletes created ones", async () => {
    const env = makeEnv();
    const existing = join(env.home, "a.txt");
    writeFileSync(existing, "ORIG");
    const created = join(env.home, "sub", "deep", "b.txt");

    const tx = new Transaction(env);
    await tx.begin();
    tx.writeFileAtomic(existing, "NEW");
    tx.writeFileAtomic(created, "X");
    expect(readFileSync(existing, "utf8")).toBe("NEW");
    expect(existsSync(created)).toBe(true);

    await tx.rollback();
    expect(readFileSync(existing, "utf8")).toBe("ORIG"); // restored
    expect(existsSync(created)).toBe(false); // deleted
  });

  it("commits: changes persist", async () => {
    const env = makeEnv();
    const file = join(env.home, "c.txt");
    const tx = new Transaction(env);
    await tx.begin();
    tx.writeFileAtomic(file, "DONE");
    tx.removeFile(join(env.home, "does-not-exist")); // tolerated
    await tx.commit();
    expect(readFileSync(file, "utf8")).toBe("DONE");
  });

  it("serializes concurrent transactions via the lock", async () => {
    const env = makeEnv();
    const t1 = new Transaction(env);
    const t2 = new Transaction(env);
    await t1.begin();

    let t2Acquired = false;
    const p2 = t2.begin().then(() => {
      t2Acquired = true;
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(t2Acquired).toBe(false); // still blocked while t1 holds the lock

    await t1.commit();
    await p2;
    expect(t2Acquired).toBe(true); // acquired once t1 released
    await t2.commit();
  });
});
