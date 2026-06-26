#!/usr/bin/env node
// Refresh the bundled catalog snapshot that ships in the npm package, so a fresh
// `npm install -g @goyoon/weft` can show `weft catalog` instantly (offline, no `weft update`).
//
// Source of truth, in order of preference:
//   1. WEFT_SNAPSHOT_SRC                          (explicit path or http(s) url)
//   2. the sibling weft-mill checkout's index.json (../../../../weft-mill/index.json)
//   3. the hosted mill index over https           (DEFAULT_MILL_INDEX_URL)
//
// The snapshot keeps spool urls RELATIVE (exactly as committed in the mill); they are
// absolutized at runtime against the live mill index url. Run before publishing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "snapshot", "index.json");
const DEFAULT_MILL_INDEX_URL = "https://raw.githubusercontent.com/goyoon2/weft-mill/main/index.json";

function fromLocal(path) {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

async function fromHttp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return await res.text();
}

const explicit = process.env.WEFT_SNAPSHOT_SRC;
const siblingMill = resolve(here, "..", "..", "..", "..", "weft-mill", "index.json");

let raw;
let origin;
if (explicit && (explicit.startsWith("http://") || explicit.startsWith("https://"))) {
  raw = await fromHttp(explicit);
  origin = explicit;
} else if (explicit) {
  raw = fromLocal(explicit);
  origin = explicit;
} else if ((raw = fromLocal(siblingMill))) {
  origin = siblingMill;
} else {
  raw = await fromHttp(DEFAULT_MILL_INDEX_URL);
  origin = DEFAULT_MILL_INDEX_URL;
}

if (!raw) {
  console.error(`refresh-snapshot: no catalog source found (tried ${explicit ?? siblingMill})`);
  process.exit(1);
}

// Validate it parses and has entries; normalize formatting.
const parsed = JSON.parse(raw);
const count = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
if (count === 0) {
  console.error("refresh-snapshot: catalog has no entries — refusing to write an empty snapshot");
  process.exit(1);
}
writeFileSync(out, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`refresh-snapshot: wrote ${count} entr${count === 1 ? "y" : "ies"} from ${origin}`);
