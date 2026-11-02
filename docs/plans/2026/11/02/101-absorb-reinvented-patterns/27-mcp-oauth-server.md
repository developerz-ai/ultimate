# 27 — MCP: the authorization server's wire, with consent left to the app

> Part of [`overview.md`](overview.md). Depends on: [`11-core-outbound.md`](11-core-outbound.md) (`dial: 'public'`), [`27-mcp-dual-era.md`](27-mcp-dual-era.md). Tier: 4 (`mcp`), importing 2 (`auth`). **OWNER DECISION: a subsystem, reversing the boundary stated at `packages/mcp/src/app-tools.ts:174` ("the authorization server … is the app's own routes"). Not built until the owner says so.**

## Why
`defineAppMcp({ oauth })` advertises an authorization server and stops (`packages/mcp/src/app-tools.ts:174`, `oauth-metadata.ts:4`, `wiki/MCP-And-AI.md:280`). A remote client cannot connect until the app writes one. Measured, four copies: 1,636 LOC (on this framework), 1,068, 1,139, 1,548. A fifth adopter runs it as a separate service. Every copy holds the same rules: exact redirect match, S256 only, single-use codes, refresh rotation with replay revocation, RFC 8707 resource binding, RFC 9207 `iss`.

These are fixed by RFCs, the same for a bank and a blog, and easy to get wrong. The `2026-07-28` revision moves them again: dynamic registration deprecated for client metadata documents, `iss` recommended. Each copy pays that separately.

Stays the app's (axiom 8): the consent page, who may consent, which scopes a person may grant, populations, step-up, token lifetimes, and what a subject becomes as an `Actor`.

## Files to change
- `packages/mcp/src/oauth-server.ts` (new) — `mcpAuthorizationServer`.
- `packages/mcp/src/oauth-server-routes.ts` (new) — RFC 8414 document, `POST /oauth/token`, `POST /oauth/register`; RFC 6749 `{ error, error_description }`.
- `packages/mcp/src/oauth-server-request.ts` (new) — pure: reads and screens an authorization request.
- `packages/mcp/src/oauth-server-clients.ts` (new) — registered clients and metadata-document clients.
- `packages/mcp/src/oauth-server-store.ts`, `oauth-server-postgres.ts`, `oauth-server-schema.ts` (new) — the shape of `confirmation-store.ts`, `confirmation-postgres.ts`, `confirmation-schema.ts`.
- `packages/cli/src/framework-schema.ts:148` — the tables' row, applied by the boot.
- `packages/mcp/package.json` — `@ultimat3/auth`, a downward edge (`sha256Hex`, `issueApiKey`).
- `packages/mcp/src/index.ts`, `packages/mcp/README.md`, `packages/mcp/CLAUDE.md`, `docs/history/mcp.md`, `wiki/MCP-And-AI.md:280`, `wiki/Error-Codes.md`.

## Steps
1. `mcpAuthorizationServer({ issuer, store, consentPath, lifetimes: { accessSeconds, refreshIdleDays }, scopes, registration? })` returns `{ routes, readRequest, approve, deny, resolve, revoke, purge }`. `lifetimes` is required: a retention window is app-chosen.
2. `routes` spread into `runtime.routes` (`wiki/MCP-And-AI.md:249`). Each is public, with no cookie authenticator. No new mount, no second path.
3. Consent is an ordinary page at `consentPath`. It calls `readRequest(url)`: `{ client, scopes, resource, redirectUri }`, or a refusal to show. An unknown client or unregistered redirect is shown and never redirected to (RFC 6749 §4.1.2.1). Its action calls `approve({ subject, request, scopes })` and gets the redirect URL carrying `code` and `iss`. `deny` likewise.
4. Rules, each with a test: redirect URIs match byte for byte; S256 only; a code lives 2 minutes and is stored hashed; a replayed code revokes what it minted; refresh rotates and a replay of any retired one revokes the grant; `resource` binds the grant; `scopes` narrows what a client asked for.
5. Clients. `registration: 'metadata-document'` (default): a `client_id` that is an https URL is fetched through `outbound({ dial: 'public' })`, size-capped and cached. `'dynamic'` adds RFC 7591 for the clients still using it, with its route on a rate limit.
6. `resolve(token)` → `{ subject, scopes, clientId } | null`, for the app's `resolveToken`, which builds the `Actor` and re-reads membership per call. So a removed member loses access with no token sweep.
7. `purge({ before })`: the app schedules it in its own `task`. Nothing here runs on a timer.
8. Tokens opaque and stored hashed; never a JWT, so `revoke({ subject, clientId? })` holds at once.
9. Not shipped: client credentials grant, device flow, token exchange, an admin screen. No adopter uses them.
10. Use: a new `packages/mcp/src/oauth-server.contract.test.ts` app. Both tracked apps declare `defineAppMcp` (`dummy/social-media-clone/packages/mcp/src/index.ts:20`, `examples/dummy/packages/mcp/src/tools.ts:50`), neither with `oauth`; `examples/dummy` gains this only if the owner wants a consent page in the reference app. This is no primitive.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_MCP_OAUTH_SERVER_INVALID` (new, off-socket) | bad `issuer`, `consentPath` or `lifetimes` at definition | names the field. `bun run new-error-code X_MCP_OAUTH_SERVER_INVALID --package mcp --title '…' --cause '…' --fix '…' --off-socket` |
| `X_MCP_OAUTH_CONSENT_INVALID` (new) | `approve` handed a request `readRequest` would refuse | re-read with `readRequest(url)` and show its refusal. `--status 422` |
| RFC 6749 errors | wire of `/oauth/token`, `/oauth/register` | fixed by the RFC, no `X_` code on the wire; logged under the two codes above and through `onAudit`'s `mcp.auth.*` |

## Tests
- `packages/mcp/src/oauth-server-request.test.ts` (unit): redirect variants refused, `plain` refused, scope narrowing, resource mismatch `invalid_target`.
- `packages/mcp/src/oauth-server.test.ts` (unit): the whole flow; code replay revokes; retired-refresh replay revokes; idle expiry on an injected `Clock`.
- `packages/mcp/src/oauth-server-store.contract.test.ts` (contract): memory and Postgres answer alike; two racing redemptions spend one code.
- `packages/mcp/src/oauth-server.contract.test.ts` (contract): a client discovers from the 401, registers, consents, exchanges, calls `tools/call`.
- `bun test packages/mcp/src/oauth-server.test.ts`

## Semver
**Breaking, one row.** New exports, but new framework tables land in every app's committed dump, so `drift` is red (`X_SCHEMA_DUMP_DRIFT`) until regenerated. `oauth:` and a hand-written server keep working.
Upgrading: "`x db gen`, commit `packages/db/schema/`."

## Done when
- A scaffolded app connects from the 401 to a `tools/call` with one `mcpAuthorizationServer` call and one consent page.
- Racing code redemptions spend one code on Postgres.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
