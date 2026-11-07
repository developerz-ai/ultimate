# @postly/mcp

The app's own MCP surface. Wired in by `app.config.ts` (`mcp.server`).

## Boundary

| May import | Must never |
|---|---|
| `@ultimat3/mcp` (`t` included — never `@ultimat3/schema` past it), `@postly/core`, `@postly/domain` | `apps/*` at runtime, `@postly/db` |
| `import type` from the app's `Api` for tool typing | a second authz path, a service account, a "trusted" mode |

Actions reach this surface because they declare `mcp: { expose: true }`, not because this package
imports them.

## Files

| File | Owns |
|---|---|
| `src/tools.ts` | the three app-specific read tools, `POSTLY_RECIPES` + the server declaration. `postlyMcp({ tools })` takes the tools only the app can build (`apps/web/mcp-tools.ts`'s `jobTool()`); a name this package already uses is `X_MCP_TOOL_DUPLICATE` |
| `src/quotes.ts` | the per-caller catalog: `quote_<plan>` per plan the acting org can move to, `runtimeTool()`s borrowing `org:administer`, owners only |
| `src/tenants.ts` | `postlyTenant(memberships)`: one token per PERSON, the org named per call as `org`; on when the app hands `postlyMcp({ memberships })` |
| `src/tenant.contract.test.ts` | one token over this app's own endpoint: Acme then Tinta, `X_MCP_TENANT_REQUIRED`, a foreign org = a hidden tool, per-org quotes |
| `src/index.ts` | public exports |
| `src/errors.ts` | `X_MCP_TOOL_UNSAFE` |
| `src/tools.test.ts` | tool/action parity and the policy-identity assertion |
| `src/recipes-replay.contract.test.ts` | every recipe followed through the server by an org owner (`replayRecipes`) |
| `src/remote-self.contract.test.ts` | `mcpTools()` against this app's own MCP route: lock, call, the three refusals |

## Commands

| Task | Command |
|---|---|
| list tools | `x mcp tools --json` |
| test | `bun test packages/mcp` |

## Conventions

- One tool, one question. A tool returning "everything about an org" is three tools.
- Tool names are `postly.<verb><Noun>`, matching the action name where one exists.
- Descriptions say what it does *and* whether it costs money or sends mail.

## Gotchas

- A tool with no `policy` throws `X_MCP_TOOL_UNSAFE` at boot, not at call time.
- `planQuote` must never charge; the test asserts the billing driver is untouched.
