# 10 — Admin over MCP: names, read-only actions, scopes, surface

> Part of [`overview.md`](overview.md). Depends on: 07. Tier: 5.

Rule: the admin catalog projects onto MCP with the same naming, scope and surface rules as any app
tool. There is no admin-only dialect.

As of 2026-09-22:
- tools are named `admin.action.<name>` (`packages/admin/src/mcp-tools.ts:155,190`) while app tools
  use the export name;
- every admin action requires `admin:write`, or `admin:destroy` when destructive
  (`action-gate.ts:37`), so a read-shaped action such as "export CSV" or "verify chain" cannot be
  granted to a read-only staff role;
- `adminMcp()` resolves every token to `scopes: new Set()` (`mcp.ts:363`), so the scope gate is
  unusable;
- `defineAppMcp` is called without `surface` or `path` (`mcp.ts:347-352`), so it collides with the
  app's `/mcp`.

## Files to change
- `packages/admin/src/registry.ts:155` (`AdminAction`) — `readonly: true`, a read-shaped admin action. `permissionsForAction` (`action-gate.ts:34-38`) returns `[ADMIN_READ, action.permission]` for it. A `readonly` action that is also `destructive` is refused at definition time.
- `packages/admin/src/mcp-tools.ts:152-160,186-195` — tool name = `action.name` for global actions and `<resource>.<action.name>` for resource actions. The same for CRUD tools: `<resource>.list`, `.show`, `.update`, `.delete`, `search`. The `admin.` prefix is gone. **BREAKING — 21.0.0.**
- `packages/admin/src/mcp.ts:340-365` — `AdminMcpOptions`:
  - `surface` (default `'admin'`) and `path` (default `${basePath}/mcp`), both passed to `defineAppMcp`;
  - `scopes?`, a map forwarded to `defineAppMcp.scopes`;
  - `resolveToken` returns `actor.scopes`/permissions as the MCP scopes instead of the empty set. `opts.actor` already returns roles; extend its return with `scopes?: readonly string[]`;
  - `onAudit`, forwarded.
- `packages/admin/README.md`, `wiki/Admin-Dashboard.md` — tool-name table, `readonly`, surface.
- `CHANGELOG.md` `[Unreleased]` — `BREAKING —` admin MCP tool names. `wiki/Upgrading.md` 21.0.0 gets a rename table (old to new).

## Steps
1. Add `readonly` to `AdminAction`, then the permission derivation, then the refusal.
2. Rename tools, with a test pinning the catalog names of the admin fixture.
3. Surface, path, scopes and audit passthrough.

## Tests
- `bun test packages/admin/src/mcp-tools.test.ts packages/admin/src/mcp.test.ts packages/admin/src/action-gate.test.ts`.
- A `readonly` action is callable by an actor holding only `admin:read`, and a normal action is not.
- `adminMcp()` and an app `defineAppMcp()` mounted together give disjoint catalogs, and neither contains the other's tools.
- A token with scope `admin:read` is `X_MCP_SCOPE_DENIED` on a write tool.

## Done when
- The admin catalog can be served on `/admin/mcp` beside the app's `/mcp`, with read-only staff tokens and scope denials that work.
