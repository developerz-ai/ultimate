# @social-media-clone/mcp — CLAUDE.md

The app's own MCP tools.

- Gate: `x verify` from the repo root — this package has no gate of its own.
- Exports: `src/index.ts`, named exports only, no `export *`.
- Imports: `@ultimat3/*` and this app's own `@social-media-clone/*` packages, never a sibling app.
