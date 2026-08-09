# @ultimat3/cli — boundary

Tier 5. May import tiers 0–4. Nothing imports this except `create-ultimate`.

| Rule | Detail |
|---|---|
| Entry | `src/bin.ts` (`#!/usr/bin/env bun`) — argv, stdout, exit code only |
| I/O | only `dispatch.ts` renders or exits; commands return `CommandResult` |
| `--json` | every command, no exceptions — same data as the human render |
| Errors | `src/errors.ts`, subclass `UltimateError`, never a bare `Error` |
| Subprocesses | only through `exec.ts`, so a test can inject a fake `Runner` |
| Templates | `templates/*.ts` return strings; no fixture files on disk |
| Strings | `messages.ts` flat catalog, missing key renders `⟦key⟧` |
| Facts | load the app (`app-load.ts`), then project it — never parse source for primitives |

Every fact the CLI reports comes from a framework package: the manifest from
`@ultimat3/manifest`, `openapi.json` from `@ultimat3/action`, the route table from
`@ultimat3/render`, budget units from `@ultimat3/render`. A check that reimplements one of
those here is the bug, not the fix.

## `x dev` boots the app; it does not simulate one

| File | Job |
|---|---|
| `dev-services.ts` | resolve which service each binding points at — embedded or external |
| `dev-runtime.ts` | start them and install the ambient accessors (`db()`, `jobDriver()`, storage, transport) |
| `dev-render.ts` | one HTTP route per registered `route`, through render's own mode function |
| `dev-hooks.ts` | the pipeline's `authorize` seam, decided from the app's own `Policy` objects |
| `dev-roles.ts` | `--role` selection plus start/stop for `web`, `sync`, `worker`, `scheduler` |
| `cmd-dev.ts` | boot order, `/_x`, the file watcher |

The roles live in `@ultimat3/core` (`ROLES`, `isRole`), never in a second list here. A dev-only
driver, a dev-only authorizer or a dev-only queue is the bug this design exists to prevent — the
only thing dev changes is which driver is behind an interface.

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

Adding a command: write `cmd-<name>.ts` exporting a `CliCommand`, register it in `registry.ts`,
add its message keys to `messages.ts`. Help and parsing derive from the spec automatically.
