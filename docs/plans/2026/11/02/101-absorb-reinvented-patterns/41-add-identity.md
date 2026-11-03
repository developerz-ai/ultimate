# 41 — Identity: an authorization server, third-party grants, more purposes, a fake provider

> Part of [`overview.md`](overview.md). Depends on: [`11-core-outbound.md`](11-core-outbound.md) (`dial: 'public'`), [`27-mcp-dual-era.md`](27-mcp-dual-era.md) (the wrapper's wire), [`08-testing-mock-fetch.md`](08-testing-mock-fetch.md). Tier: 2 (`auth`), 4 (`mcp`), 5 (`testing`, `cli`). **Decided: build it, reversing the boundary at `packages/mcp/src/app-tools.ts:174` ("the authorization server … is the app's own routes").**

## Why
| Gap | Evidence |
|---|---|
| A remote client cannot connect | `defineAppMcp({ oauth })` advertises an authorization server and stops (`mcp/src/app-tools.ts:174`, `oauth-metadata.ts:4`, `wiki/MCP-And-AI.md:280`). Measured, four copies: 1,636 LOC (on this framework), 1,068, 1,139, 1,548. A fifth adopter runs it as a separate service. Each holds the same rules: exact redirect match, S256 only, single-use codes, refresh rotation with replay revocation, RFC 8707 resource binding, RFC 9207 `iss`. Fixed by RFCs, the same for a bank and a blog, easy to get wrong. The `2026-07-28` revision moves them again, and each copy pays that separately |
| The server must not be MCP's alone | a team with a public API, integrations or a CLI needs the same RFC wire. `bearerMount` takes any resolver (`http/src/bearer-mount.ts:39`) yet has no standard one |
| No machine or CLI grant | a partner's nightly sync has no person to consent, so it gets a static API key (`auth/src/api-keys.ts:64`) with no expiry unless someone sets one. A CLI on a headless box cannot open a redirect |
| Two verification purposes, closed | `VERIFICATION_PURPOSES` (`auth/src/verify.ts:27`, `auth/src/auth.ts:85`). The store takes any string (`builtin-adapter.ts:355`). Invite, email change, account deletion each hand-roll hashing, single use and constant-time compare |
| Sign-in tests need a provider | `auth/src/oauth-login-fixture.ts` is private; `wiki/Testing.md` forbids the network. Two adopters wrote a fake, each with its own signing keys and discovery document |

Stays the app's (axiom 8): the consent page, who may consent or be a client, which scopes a person may grant, step-up, token lifetimes, what a subject becomes as an `Actor`. Not here: token exchange, whose shape differs per federation, and an admin screen for clients.

## Decisions
| Question | Answer |
|---|---|
| Home | `auth`, from birth. No `mcp` implementation exists to move. `mcp` holds only the `resource`-binding wrapper |
| Shapes across `auth → http` | sideways, so forbidden. `routes` are plain objects of the shape `runtime.routes` takes, and `oauthBearerResolver` returns a function matching `BearerResolver` by structure. `auth` imports nothing from `http`. A contract test assigns both to the real types |
| Mount | `routes` spread into `runtime.routes` (`wiki/MCP-And-AI.md:249`), public, no cookie authenticator. No new mount, no second path |
| Tokens | opaque and stored hashed, never a JWT, so `revoke` holds at once |

## Files to change
- `packages/auth/src/authorization-server.ts` (new) — `authorizationServer`.
- `packages/auth/src/authorization-server-routes.ts` (new) — RFC 8414 document, `POST /oauth/token`, `/oauth/register`, `/oauth/device`; RFC 6749 `{ error, error_description }`.
- `packages/auth/src/authorization-server-request.ts`, `-clients.ts` (new) — pure: screen a request; registered and metadata-document clients.
- `packages/auth/src/authorization-server-store.ts`, `-postgres.ts`, `-schema.ts` (new) — the shape of `mcp/src/confirmation-store.ts`, `confirmation-postgres.ts`, `confirmation-schema.ts`, device codes included.
- `packages/auth/src/grant-client-credentials.ts`, `grant-device.ts` (new) — RFC 6749 §4.4, RFC 8628.
- `packages/auth/src/token-endpoints.ts` (new) — RFC 7009 revocation, RFC 7662 introspection.
- `packages/auth/src/oauth-bearer-resolver.ts` (new) — `oauthBearerResolver(server, { actor })`.
- `packages/auth/src/verify.ts:27,32,38`, `auth.ts:85` — `defineVerificationPurpose`.
- `packages/mcp/src/oauth-server.ts` (new), `packages/mcp/package.json` — `mcpAuthorizationServer`, the `resource`-binding wrapper; `@ultimat3/auth`, a downward edge.
- `packages/testing/src/fake-identity-provider.ts` (new); `testing/src/index.ts`.
- `packages/cli/src/framework-schema.ts:148` — the tables' row, device codes included, applied by the boot.
- `examples/dummy/` — `bearerMount` with `oauthBearerResolver`; one custom purpose (member invite); `fakeIdentityProvider` in the sign-in test.
- `wiki/Auth.md`, `wiki/MCP-And-AI.md:280`, `wiki/Testing.md`, `docs/history/mcp.md`, `packages/{auth,mcp,testing}/README.md`, `CLAUDE.md`, `wiki/Error-Codes.md`.

## Steps
1. `authorizationServer({ issuer, store, consentPath, lifetimes, scopes, registration?, grants? })` returns `{ routes, readRequest, approve, deny, resolve, revoke, purge }`. `lifetimes: { accessSeconds, refreshIdleDays }` is required: a retention window is app-chosen. `grants` defaults to `['authorization_code', 'refresh_token']`; each further grant is named.
2. Consent is an ordinary page at `consentPath`. It calls `readRequest(url)`: `{ client, scopes, resource, redirectUri }`, or a refusal to show. An unknown client or unregistered redirect is shown and never redirected to (RFC 6749 §4.1.2.1). Its action calls `approve({ subject, request, scopes })` and gets the redirect URL carrying `code` and `iss`. `deny` likewise.
3. Rules, each with a test: redirect URIs match byte for byte; S256 only; a code lives 2 minutes and is stored hashed; a replayed code revokes what it minted; refresh rotates and a replay of any retired one revokes the grant; `resource` binds the grant; `scopes` narrows what a client asked for.
4. Clients. `registration: 'metadata-document'` (default): a `client_id` that is an https URL is fetched through `outbound({ dial: 'public' })`, size-capped and cached. `'dynamic'` adds RFC 7591 for the clients still using it, on a rate limit.
5. `client_credentials`: confidential clients only, secret stored hashed, no refresh token, subject is the client. Scopes from the client's registered set, narrowed by request. `lifetimes.clientSeconds` required.
6. Device flow: `POST /oauth/device` answers codes and `verification_uri`. The verification page is the app's, like consent. Polling faster than `interval` gets `slow_down`; approve, deny and expiry per the RFC. User code hashed, 8 characters from a no-lookalike alphabet, rate limited.
7. Revocation answers 200 for an unknown token (RFC 7009 §2.2). Introspection requires client auth and answers `{ active: false }` with nothing else for anything not owned by that resource. `revoke({ subject, clientId? })` holds at once.
8. `resolve(token)` → `{ subject, scopes, clientId } | null`. `oauthBearerResolver(server, { actor })`: `actor` is required and builds the `Actor` per call, so a removed member loses access with no sweep. `bearerMount({ resolve })` then enforces mount scopes as it does. MCP's `resolveToken` takes the same.
9. `purge({ before })`: the app schedules it in its own `task`. Nothing here runs on a timer.
10. `mcpAuthorizationServer(options)` is `authorizationServer` plus `resource` binding and `mcp.auth.*` audit. No second implementation.
11. `defineVerificationPurpose({ name, template, ttlMs, identifier? })`, returning `{ issue, consume }` built on the existing internals. `email-verify` and `password-reset` become two instances, so one code path. A name duplicated is refused. Re-consuming stays refused.
12. `fakeIdentityProvider({ issuer?, users, clock? })`: discovery document, JWKS from a generated key, `/authorize` auto-approving as a chosen user, `/token`, `/userinfo`, served through `mockFetch` (08) with no socket. `tamper({ wrongAudience, expired, wrongKey, noEmailVerified })` makes the failures that matter testable. Production import refused, as testing's are.

## Error codes
`bun run new-error-code` for each new row, `--package auth` unless noted. No `X_MCP_OAUTH_*`: the server is `auth`'s.

| Code | When | Fix |
|---|---|---|
| `X_AUTH_SERVER_INVALID` (new, off-socket) | bad `issuer`, `consentPath` or `lifetimes`; a grant missing its lifetime or store method | names the field |
| `X_AUTH_CONSENT_INVALID` (new, 422) | `approve` handed a request `readRequest` would refuse | re-read with `readRequest(url)` and show its refusal |
| `X_AUTH_GRANT_DISABLED` (new, off-socket, logged) | a grant not in `grants` | add it to `grants` |
| `X_VERIFICATION_PURPOSE_INVALID` (new, off-socket) | duplicate name, or no template | rename, or add `template` |
| `X_VERIFICATION_PURPOSE_UNKNOWN` (new, 400) | a consume naming an undeclared purpose | `defineVerificationPurpose` at boot |
| RFC 6749 errors | wire of `/oauth/*` | fixed by the RFC, no `X_` code on the wire; logged under the codes above and, through the wrapper, `onAudit`'s `mcp.auth.*` |

## Tests
- `packages/auth/src/authorization-server-request.test.ts`: redirect variants refused, `plain` refused, scope narrowing, resource mismatch `invalid_target`.
- `packages/auth/src/authorization-server.test.ts`: the whole flow; code replay revokes; retired-refresh replay revokes; idle expiry on an injected `Clock`.
- `packages/auth/src/authorization-server-store.contract.test.ts`: memory and Postgres answer alike; two racing redemptions spend one code.
- `packages/auth/src/grant-client-credentials.test.ts`: secret wrong refused; narrowed scope; no refresh token.
- `packages/auth/src/grant-device.test.ts` on an injected `Clock`: `authorization_pending`, `slow_down`, expired, denied, approved once.
- `packages/auth/src/token-endpoints.test.ts`: revoked token dead at once; another resource's token `active: false`.
- `packages/auth/src/verify.test.ts`: a custom purpose is single use and cannot consume another purpose's token. The existing two still pass unchanged.
- `packages/testing/src/fake-identity-provider.test.ts`: real `verifyIdToken` (`auth/src/id-token.ts:141`) accepts its token and each `tamper` is refused with the right code.
- `packages/mcp/src/oauth-server.contract.test.ts`: a client discovers from the 401, registers, consents, exchanges, calls `tools/call`.
- `packages/auth/src/authorization-server.contract.test.ts`: the `examples/dummy` mount reached with a client-credentials token; `routes` and the resolver assign to the real `http` types.
- `bun test packages/auth/src/grant-device.test.ts`

## Semver
**Breaking, two rows.** New framework tables, the device table among them, land in every app's committed dump, so `drift` is red (`X_SCHEMA_DUMP_DRIFT`) until regenerated. `VerificationPurpose` widens to `string`: a compile break for an exhaustive `switch`. `oauth:` and a hand-written server keep working.
Upgrading: "`x db gen`, commit `packages/db/schema/`." "`VerificationPurpose` is open; add a default arm to a `switch` over it."

## Done when
- A scaffolded app connects from the 401 to a `tools/call` with one `mcpAuthorizationServer` call and one consent page.
- An MCP client and a partner's machine client authenticate against one server in one contract test.
- Racing code redemptions spend one code on Postgres.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
