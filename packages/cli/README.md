# @symploke-ai/weft

A Homebrew-style package manager for AI-tool **harnesses** — bundles of skills, agents, commands,
hooks, and MCP servers for AI coding CLIs (Claude Code, Codex, Gemini, Cursor, opencode).

```sh
npm install -g @symploke-ai/weft

weft catalog              # browse every harness in the catalog (works instantly, offline)
weft search planner       # find harnesses (typo-tolerant)
weft install gsd-core     # pick a CLI + scope and merge the pre-built files in
weft list                 # what's installed where
weft update               # refresh the catalog from the mill
weft upgrade gsd-core     # move to a newer version
weft uninstall gsd-core   # exact reverse of install
```

The catalog is served from the [`weft-mill`](https://github.com/goyoon2/weft-mill) registry — `weft`
ships a snapshot so `weft catalog` works the moment you install it, then auto-refreshes from the mill
in the background. No clone, no config. Set `WEFT_NO_AUTO_UPDATE=1` to pin the snapshot, or
`WEFT_INDEX_URL` / `WEFT_MILL_DIR` to point at a different mill.

See the [project README](https://github.com/goyoon2/weft#readme) for the full design.
