/**
 * Spool placeholders are `{{UPPER_SNAKE}}` tokens baked in at build time and resolved
 * by the client at install (e.g. `{{WEFT_PAYLOAD_DIR}}` → the absolute payload path).
 */
const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/** Distinct placeholder names appearing in `text`. */
export function extractPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found];
}

/** Replace known placeholders; unknown ones are left intact. */
export function substitutePlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : value;
  });
}
