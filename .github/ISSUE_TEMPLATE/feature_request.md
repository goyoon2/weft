---
name: Feature / change request
about: Propose a change to the engine — CLI UX, resolution, adapters, spool building.
title: "feat: "
labels: enhancement
---

<!--
Engine changes only. To get a new *harness* into the catalog, open a "New harness"
request on weft-mill (link shown when you start a new issue here). To support a new
AI CLI, that's a new adapter — use this template.
-->

## Problem

<!-- What's awkward or impossible today? -->

## Proposal

<!-- What should weft do instead? -->

## Which area

- [ ] CLI / UX (`@weft-ai/weft`)
- [ ] resolve / plan / place / merge / receipts (`@weft/core`)
- [ ] new or changed CLI adapter (`@weft/adapters`)
- [ ] spool building / pattern features (`@weft/loom`)
- [ ] schema / validation (`@weft/schema`)

## Notes

<!--
Anything affecting the invariants worth calling out:
- security — the manifest/mill are untrusted input; does this widen that surface?
- reversibility — does install stay an exact reverse of uninstall?
- a harness's own installer must still never run on the user's machine.
-->
