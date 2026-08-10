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
| `src/tools.ts` | the three app-specific read tools + the server declaration |
| `src/index.ts` | public exports |
| `src/errors.ts` | `X_MCP_TOOL_UNSAFE` |
| `src/tools.test.ts` | tool/action parity and the policy-identity assertion |

## Commands

| Task | Command |
|---|---|
| list tools | `x mcp ls --json` |
| generate docs | `x mcp doc --json` |
| test | `bun test packages/mcp` |

## Conventions

- One tool, one question. A tool returning "everything about an org" is three tools.
- Tool names are `postly.<verb><Noun>`, matching the action name where one exists.
- Descriptions say what it does *and* whether it costs money or sends mail.

## Gotchas

- A tool with no `policy` throws `X_MCP_TOOL_UNSAFE` at boot, not at call time.
- `planQuote` must never charge; the test asserts the billing driver is untouched.
