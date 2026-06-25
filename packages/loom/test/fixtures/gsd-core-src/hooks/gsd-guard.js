#!/usr/bin/env node
// gsd guard hook. Self-references the plugin root, which weft must rewrite.
const root = process.env.CLAUDE_PLUGIN_ROOT || "${CLAUDE_PLUGIN_ROOT}";
console.error("gsd-guard running from", root);
