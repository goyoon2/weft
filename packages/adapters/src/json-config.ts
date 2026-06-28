import { readFileSync } from "node:fs";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import type { ParsedConfig } from "./types";

/**
 * Read a shared JSON config permissively. A missing file yields an empty config; a present file
 * that can't be parsed at all (genuine syntax error) is flagged `unparsable` so the caller refuses
 * to rewrite it rather than dropping the user's content.
 *
 * Parsing goes through `comment-json`, which accepts JSON *and* JSONC and keeps comments as
 * non-enumerable metadata on the returned object. That lets a merge round-trip a commented config —
 * Gemini and OpenCode are officially JSONC — without stripping the user's comments. The result still
 * behaves as a plain object for property access, `Object.keys`, and `JSON.stringify` (the hash path).
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
    const parsed = parseJsonc(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path, data: {}, existed: true, unparsable: true };
    }
    return { path, data: parsed as Record<string, unknown>, existed: true, unparsable: false };
  } catch {
    return { path, data: {}, existed: true, unparsable: true };
  }
}

/** Strict-ish JSON, 2-space indent, trailing newline. `stringify` (not `JSON.stringify`) so any
 *  comments captured at read time survive the rewrite. Top-level key order is preserved by mutation. */
export function serializeJsonConfig(cfg: ParsedConfig): string {
  return `${stringifyJsonc(cfg.data, null, 2)}\n`;
}
