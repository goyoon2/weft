# weft

A Homebrew-style package manager for AI-tool **harnesses** (bundles of skills, agents,
commands, hooks, and MCP servers for AI coding CLIs).

```sh
weft search gsd          # find harnesses (typo-tolerant)
weft install gsd-core    # pick CLI + scope, merge pre-built files in
weft list                # what's installed where
weft update              # refresh the catalog
weft upgrade gsd-core    # move to a newer version
weft uninstall gsd-core  # exact reverse of install
```

## Concepts

| weft | Homebrew analogue | what it is |
|---|---|---|
| **harness** | — | the real thing you install (e.g. `gsd-core`) |
| **mill** | homebrew-core | the registry repo (`weft-mill`) holding patterns |
| **pattern** | formula | a harness recipe in the mill (`patterns/<id>.yaml`) |
| **spool** | bottle | a pre-built, normalized, ready-to-merge snapshot per `(harness, version, cli, scope)` |
| **index** | — | the catalog `weft update` downloads |
| **receipt** | INSTALL_RECEIPT | the exact record of one install, under `~/.weft/` |

The mill's CI pre-builds spools so the user's machine **never runs a harness's own
installer** — weft only places verified files and merges pre-computed config fragments,
tracking provenance so `uninstall`/`upgrade` are exact.

## Layout

This is a pnpm workspace:

- `@weft/schema` — types, zod validators, hashing, placeholder substitution
- `@weft/adapters` — the `CliAdapter` seam + the Claude Code adapter
- `@weft/loom` — the spool builder (`pattern` → `spool`)
- `@weft/core` — resolve, plan, transactional place/merge, receipts, ops
- `@goyoon/weft` — the `weft` CLI

The registry data lives in the sibling [`weft-mill`](../weft-mill) repo.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm weft -- search gsd     # run the CLI from source
```
