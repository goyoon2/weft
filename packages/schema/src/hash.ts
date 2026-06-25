import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Sha256 } from "./types";

/** Hash raw bytes or a string as `sha256:<hex>`. */
export function sha256OfBytes(data: Buffer | Uint8Array | string): Sha256 {
  const hex = createHash("sha256").update(data).digest("hex");
  return `sha256:${hex}`;
}

/** Hash a file's contents. */
export async function sha256OfFile(path: string): Promise<Sha256> {
  return sha256OfBytes(await readFile(path));
}

/**
 * Deterministic JSON serialization: object keys sorted recursively. Two values that
 * are structurally equal (ignoring key order) produce identical strings — so a hash
 * over this form is order-independent, which is what verify-before-remove needs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical (order-independent) hash of a JSON-serializable value. */
export function sha256OfValue(value: unknown): Sha256 {
  return sha256OfBytes(canonicalJson(value));
}
