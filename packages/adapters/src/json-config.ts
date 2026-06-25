import { readFileSync } from "node:fs";
import type { ParsedConfig } from "./types";

/**
 * Read a shared JSON config permissively. A missing file yields an empty config; a present
 * file that is not strict JSON (comments/JSONC/syntax error) is flagged `unparsable` so the
 * caller can refuse to rewrite it rather than silently dropping the user's content.
 */
export function readJsonConfig(path: string): ParsedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, data: {}, existed: false, unparsable: false };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path, data: {}, existed: true, unparsable: true };
    }
    return { path, data: parsed as Record<string, unknown>, existed: true, unparsable: false };
  } catch {
    return { path, data: {}, existed: true, unparsable: true };
  }
}

/** Strict JSON, 2-space indent, trailing newline. Top-level key order is preserved by mutation. */
export function serializeJsonConfig(cfg: ParsedConfig): string {
  return `${JSON.stringify(cfg.data, null, 2)}\n`;
}
