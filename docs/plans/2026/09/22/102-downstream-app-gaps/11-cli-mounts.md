# 11 — CLI: mount `api/**/route.ts` and every MCP surface

> Part of [`overview.md`](overview.md). Depends on: 05, 07 (and 10 for the admin surface test). Tier: 5 (plus one tier-0 key deletion that must land atomically, noted below).

Rule: `apiRoutes()` (`packages/cli/src/api-routes.ts:14-16`) stays the ONE list both boots mount
(`serve.ts:386-387`, `dev-route-table.ts:79`). It gains api route files. `mountAppMcp` mounts every
surface, not the first file found.

## Files to change
- `packages/cli/src/app-load.ts:160-172,219-230` — a module under `apps/*/api/**/route.ts` goes through `apiRouteHandlers(file, module)` (slice 05), with its path from render's `routePathFromFile` (`packages/render/src/registry.ts:101-127`), into a CLI-owned `apiFileRegistry`.
  - It is registered on first import and on reload, following `reloadRoute`'s hash rule.
  - A method export with no `defineApiRoute` config is a finding at the file (`X_API_ROUTE_UNDECLARED`), and the boot fails like any `findingFrom(error)`.
- `packages/cli/src/api-routes.ts:14-16` — `apiRoutes()` returns actions, queries **and** `apiFileRegistry.routes()`.
  - A method+path pair appearing twice (for example an action deriving `POST /api/payments/confirm` next to `api/payments/confirm/route.ts`) is `X_API_ROUTE_CONFLICT`. The fix line names both files.
  - Because `apiRoutes()` is the one list, `app-openapi.ts` sees them too. Raw routes appear in OpenAPI with `requestBody: {}` and the `why` as the description.
- `packages/cli/src/app-manifest.ts:88` area, `x routes` — list api routes with `auth`, `policy`, `rateLimit`, `why`. Regenerate `framework.manifest.json` with `bun run manifest`.
- `packages/cli/src/app-mcp.ts:19-138` — rewrite `appMcpMount`:
  - collect **every** `AppMcp`-shaped export from every `apps/*/mcp.ts`;
  - mount each at `appMcp.path` (slice 07);
  - two with the same `path` or `surface` is `X_MCP_SURFACE_DUPLICATE`, naming both files;
  - `/_x` and the boot line print every mounted surface.

  This deletes the "first sorted file wins" rule (`:104-127`), which let `apps/admin/mcp.ts` silently hijack `/mcp`.
- `packages/core/src/config.ts:158-161,292,432` — **delete `ai.mcp.path`** in the same PR. The path is on the `AppMcp` (default `/mcp`, `mcp/src/app-tools.ts:79-80`), and two sources is the bug this slice removes. `ai.mcp.expose` stays the switch. `BREAKING —` entry; `wiki/Upgrading.md`: "move `ai.mcp.path` into `defineAppMcp({ path })`". Also drop `path` from the scaffold template (`templates/scaffold-repo.ts:225`).
- `packages/cli/src/framework-schema.ts:34` — add `{ pkg: '@ultimat3/mcp', tables: ['x_mcp_pending_calls'], ddl: [SQL_MCP_PENDING_TABLE] }` (slice 07).
- `packages/cli/src/generate-files.ts:85` (`assertSurfaceSupported`), `templates/route.ts` — `x g route <name> --surface api` emits a `defineApiRoute` skeleton with a `POST` that calls `verifyHmacSignature`. `templates/route.ts` has no api branch today; read `assertSurfaceSupported` for what it does with `route` + `api`, and replace that behaviour.
- `examples/dummy/apps/web/api/webhooks/demo/route.ts` (new) — the reference app carries one raw route, so `scripts/reference-app-gate.ts` proves the mount in both boots.

## Steps
1. Build the api file registry and add it to `apiRoutes()`, then the conflict check, then manifest and OpenAPI rows.
2. Mount N MCP surfaces, delete the first-wins rule, and delete the config key.
3. Add the pending-calls DDL, then the generator branch, then the example route.

## Tests
- `bun test packages/cli/src/api-routes.test.ts packages/cli/src/app-load.test.ts packages/cli/src/app-mcp.test.ts packages/cli/src/serve.test.ts`.
- A fixture app with `apps/web/api/hooks/x/route.ts` exporting `POST`:
  - `x dev` and `serve()` both answer 202;
  - the handler sees `bodyBytes()` equal to the sent bytes and a custom header;
  - without `config` the boot reports `X_API_ROUTE_UNDECLARED`.
- `apps/web/mcp.ts` (`/mcp`) and `apps/admin/mcp.ts` (`adminMcp`, `/admin/mcp`) both mount, and each `tools/list` is disjoint. Two surfaces sharing `/mcp` fail boot with `X_MCP_SURFACE_DUPLICATE`.
- `serve.live.test.ts`: a raw route behind the real pipeline keeps security headers and rate limit.

## Done when
- The http README's webhook example, copied verbatim into a fresh scaffold, answers under `x dev` and in the container.
- `bun run scripts/reference-app-gate.ts` is green with the example route.
