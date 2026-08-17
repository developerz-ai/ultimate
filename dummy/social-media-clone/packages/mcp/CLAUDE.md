# @social-media-clone/mcp — CLAUDE.md

The app's own MCP tools.

- Gate: `x verify` from the repo root — this package has no gate of its own.
- Exports: `src/index.ts`, named exports only, no `export *`.
- Imports: `@ultimat3/*` and this app's own `@social-media-clone/*` packages, **never a sibling
  app**. `x verify`'s `boundaries` step cannot see this — `readAppSources` globs
  `apps/*/{site,app,api,shared}/**` and never `packages/**` — so the rule is enforced by
  `src/index.test.ts`, which scans every package's source for a specifier that resolves into
  `apps/`. This module broke it until 2026-08 (`@social-media-clone/web/api/health`).
- **`appMcp()` is a function, not a constant.** `include: 'exposed'` reads the action/query
  registry *where it is called*, and that registry is filled by the app's own boot scan. A
  module-scope `defineAppMcp()` snapshots whatever happened to be registered at import time — which
  is what made the upward import above look necessary.
- The catalog is proved by a boot, not by a unit test: `src/index.contract.test.ts` runs `loadApp`
  and asserts the real actions project.
