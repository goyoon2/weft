---
name: Bug report
about: The weft CLI did the wrong thing (install / upgrade / uninstall / resolve / adapter).
title: "bug: "
labels: bug
---

<!--
This is the ENGINE repo. If a specific *harness* installs the wrong files or its catalog
entry is stale, that's a catalog issue — file it on weft-mill instead (see the link when
you open a new issue). File here when weft's own logic is at fault.
-->

## What happened

<!-- One or two sentences. -->

## Command + environment

```
$ weft <command...>

weft version:   <weft --version>
OS:             <macOS 15 / Ubuntu 24.04 / ...>
target CLI:     <claude-code / codex / gemini / opencode / cursor>
scope:          <global / local>
harness:        <id@version, if relevant>
```

## Expected vs actual

- **Expected:**
- **Actual:**

## Output / receipt

<!--
Paste the failing output. For an install/upgrade/uninstall bug, the receipt under
`~/.weft/` (or the relevant fragment) pins down exactly what was placed/merged.
-->

```
```

## Which area (best guess, optional)

- [ ] CLI / UX (`@symploke-ai/weft`)
- [ ] resolve / plan / place / merge / receipts (`@weft/core`)
- [ ] a CLI adapter — path mapping, config merge (`@weft/adapters`)
- [ ] spool building from a pattern (`@weft/loom`)
- [ ] schema / validation / hashing / substitution (`@weft/schema`)
