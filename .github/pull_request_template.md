<!--
The engine repo (the pnpm workspace). For catalog/pattern changes, open the PR on weft-mill.
Fill in the sections below.
-->

## Summary

<!-- What changed and why. -->

## Type of change

- [ ] Bug fix
- [ ] New feature / behavior change
- [ ] New or changed CLI adapter (`@weft/adapters`)
- [ ] Refactor / internal (no behavior change)
- [ ] Docs / chore

## Affected packages

- [ ] `@symploke-ai/weft` (CLI)
- [ ] `@weft/core` (resolve / plan / place / merge / receipts / ops)
- [ ] `@weft/adapters` (CliAdapter seam + per-CLI adapters)
- [ ] `@weft/loom` (pattern → spool builder)
- [ ] `@weft/schema` (types / zod / hashing / substitution)

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (added/updated tests for the change)
- [ ] No machine-specific absolute paths can leak through capture/normalization
- [ ] Manifest + mill data are still treated as untrusted (no new trust delegated to them)
- [ ] `install` stays the exact reverse of `uninstall`; `upgrade` is clean
- [ ] If this changes a spool's shape, the mill needs a rebuild — noted below

## Notes

<!-- Mill rebuild needed? Follow-up on weft-mill? Anything reviewers should know. -->
