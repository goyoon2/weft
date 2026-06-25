import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReceipt } from "@weft/schema";
import type { CliId, Receipt } from "@weft/schema";
import { stateDirs } from "./paths";
import type { WeftEnv } from "./paths";

export function readAllReceipts(env: WeftEnv): Receipt[] {
  const dir = stateDirs(env).receipts;
  if (!existsSync(dir)) return [];
  const out: Receipt[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(parseReceipt(JSON.parse(readFileSync(join(dir, file), "utf8"))));
    } catch {
      // skip unreadable/corrupt receipts rather than crash listing
    }
  }
  return out;
}

export interface ReceiptQuery {
  harness?: string;
  cli?: CliId;
  scopeKey?: string;
}

export function findReceipts(env: WeftEnv, q: ReceiptQuery): Receipt[] {
  return readAllReceipts(env).filter(
    (r) =>
      (q.harness === undefined || r.harness === q.harness) &&
      (q.cli === undefined || r.cli === q.cli) &&
      (q.scopeKey === undefined || r.scopeKey === q.scopeKey),
  );
}

export function isInstalled(env: WeftEnv, harness: string, cli: CliId, scopeKey: string): boolean {
  return findReceipts(env, { harness, cli, scopeKey }).length > 0;
}

export function writeReceipt(env: WeftEnv, receipt: Receipt): void {
  const dir = stateDirs(env).receipts;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${receipt.receiptId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

export function deleteReceipt(env: WeftEnv, receiptId: string): void {
  const path = join(stateDirs(env).receipts, `${receiptId}.json`);
  if (existsSync(path)) rmSync(path);
}
