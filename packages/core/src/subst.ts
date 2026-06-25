import { substitutePlaceholders } from "@weft/schema";

/** Recursively substitute `{{NAME}}` placeholders in every string within a JSON-like value. */
export function substituteDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return substitutePlaceholders(value, vars);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, vars);
    }
    return out;
  }
  return value;
}
