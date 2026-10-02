# Sweep 1 — security
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only audit at `2ea5eb17` (23.0.0), As of 2026-10.
> Axes: authz, tenancy, authn, injection, crypto and secrets, resource exhaustion, supply chain.
> Tally: critical 0 · high 2 · medium 10 · low 10. CONFIRMED = executed against `packages/*/src` or
> pinned by an existing test. PLAUSIBLE = read, not run.
> Stated at the level needed to fix and test. No reproduction strings.
> **No surface was found where an action, query, MCP tool, live query or admin screen reaches a
> handler without its policy running.**

## High

| # | Axis | Where | Defect | Precondition → impact | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|---|
| H1 | authn / authz | `packages/auth/src/api-keys.ts:92-109`, `revocation.ts:84-95` | `verifyApiKey` never looks at the owning user; `disableUser` revokes sessions only | a user minted a key, then was disabled → the key still resolves to its full permissions. The session surface checks `disabledAt` (`auth.ts:362`); the bearer mount and MCP do not | CONFIRMED | `verifyApiKey` loads the owner when `record.userId !== null`, refuses if missing or disabled; `disableUser` revokes the user's keys | `packages/auth/src/revocation.test.ts`, `api-keys.test.ts` |
| H2 | authz / tenancy | `packages/realtime/src/channel.ts:294-306`, `errors.ts:59-62` | on re-authorization a topic is dropped only for `X_FORBIDDEN`, `X_UNAUTHENTICATED`, `TopicForbiddenError`; any other throw keeps the socket subscribed | an open socket whose actor lost or changed its org, on a channel whose `row` loader reads a tenant-scoped entity → the loader throws `X_TENANCY_ACTOR_ORG_REQUIRED` / `_MISMATCH` on every pass; the removed member keeps receiving that org's `records` frames until the socket closes. Channels have no per-row gate (live queries do, `live-query.ts:325-339`) | keep-on-failure CONFIRMED (pinned by `channel-concurrency.test.ts:381`); trigger PLAUSIBLE | on a non-denial guard failure stop delivering for the topic until a pass succeeds (the live-query "desynced" pattern), or treat `X_TENANCY_*` as denials | `packages/realtime/src/channel-concurrency.test.ts`, `sync-node-auth.test.ts` |

## Medium

| # | Axis | Where | Defect | Precondition → impact | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|---|
| M1 | authn | `packages/auth/src/privileges.ts:48-74` | a `passwordHash` change rotates only the session passed in | a stolen session survives the victim's password change or reset | CONFIRMED | `deleteOtherSessions(userId, keep)` (`session.ts:205`), or `deleteSessionsForUser` with no session | `packages/auth/src/privileges.test.ts` |
| M2 | secrets | `packages/core/src/logger.ts:63-92`, `packages/action/src/audit-input.ts:71` | redaction is an exact-key list; compound credential names pass | an action with `audit: true` carrying `currentPassword`, `newPassword`, `mfaSecret`, `totpCode`, `recoveryCode`, `resetToken` → persisted in clear in the audit table. `passwordHash`, `tokenHash`, `keyHash` not listed either (reading) | CONFIRMED | add the framework's own field names; match on stem / suffix | `packages/action/src/audit-input.test.ts`, `packages/core/src/logger.test.ts` |
| M3 | injection (dev surface) | `packages/cli/src/dev-dashboard.ts:61-72,225-232`, `packages/admin/src/dev/panel-db.ts:156-178` | the dev dashboard's SQL panel runs guard-approved SQL through plain `db.query` — no read-only transaction, no role, no timeout — on a GET, `auth: 'public'` route. The MCP twin has all three (`packages/db/src/readonly-query.ts:125-141`) | `x dev` running and a page in the developer's browser issuing the request → blind execution with the app's database credentials | missing guards CONFIRMED; cross-site trigger PLAUSIBLE | route `runSql` through `readOnlyQuery`; take the statement by POST | `packages/cli/src/dev-dashboard.test.ts`, `packages/admin/src/dev/panel-db.test.ts` |
| M4 | injection | `packages/mcp/src/readonly-sql.ts:147-165,216-228,343` | the function denylist is bypassable: Unicode-escaped quoted identifiers are not decoded before the scan; the XML query-execution function family is not listed | a caller with `db:read` on the dev MCP server → the SELECT-only role layer is lost inside the transaction. `READ ONLY` still holds — not a write | CONFIRMED (parser + PGlite) | refuse Unicode-escaped identifiers outright; add the `query_to_xml*`, `cursor_to_xml`, `table_to_xml`, `schema_to_xml`, `database_to_xml` family | `packages/mcp/src/readonly-sql.test.ts`, `packages/db/src/readonly-query.test.ts` |
| M5 | resource exhaustion | `packages/http/src/stages.ts:209-226` (order `pipeline.ts:56-65`), `packages/mcp/src/transport-http.ts:196-201` | the `auth` stage answers 401 before `rate-limit` runs — failed-credential requests to `auth: 'required'` routes are never metered | unauthenticated: 12 requests against a capacity-3 bucket → twelve 401s, twelve `authenticate()` store reads. Bearer mount and MCP the same | CONFIRMED | spend an IP-keyed bucket before `authenticate`, or on the 401 path | `packages/http/src/pipeline.test.ts`, `packages/mcp/src/transport-http.test.ts` |
| M6 | authn | `packages/http/src/peer-identity.ts:89-95`, `forwarded.ts:34-44` | `x-forwarded-client-cert` trusted at the hop index configured for `x-forwarded-for` | `trustProxy: true` behind a proxy that appends XFF but passes the cert header through, and an app mapping `ctx.peer` to a service actor → a client-sent header sets `ctx.peer.spiffeId` | CONFIRMED (function level) | a separate explicit opt-in (`trustClientCertHeader`), default off | `packages/http/src/peer-identity.test.ts` |
| M7 | authn / CSRF | `packages/realtime/src/sync-origin.ts:25` | the WebSocket upgrade accepts any Origin whose hostname equals the request's — scheme and port ignored; HTTP CSRF compares exact origins (`packages/http/src/csrf.ts:68-74`) | attacker content on the same host at another port or on plain http → the socket opens as the victim (cookies are not port-scoped) | CONFIRMED | compare full origins against `selfOrigin` plus `allowedOrigins` | `packages/realtime/src/sync-upgrade-origin.test.ts` |
| M8 | resource exhaustion | `packages/auth/src/auth.ts:292-293,305`, `rate-limit.ts:56-62` | failed logins count against an org-wide bucket asserted before password verification | unauthenticated attacker knowing ~20 emails in one org → every member locked out, correct password included; the lock reveals org membership | PLAUSIBLE | the org bucket becomes a signal, not a hard refusal for correct credentials | `packages/auth/src/auth.test.ts` |
| M9 | authn | `packages/auth/src/errors.ts:176-182`, `auth.ts:338`, `mfa.ts:164-191` | no second-factor completion ships: `X_MFA_REQUIRED` hands back `meta.userId` and its `fix:` tells the app to call `verifyTotp` then `createSession`; nothing binds step two to a passed step one; `verifyTotp` has no attempt limiter | an app implementing step two as the fix text says → six-digit brute force without the password | PLAUSIBLE | ship `completeMfa(auth, challengeToken, code)` over a short-lived signed challenge and `auth.limiter` | `packages/auth/src/mfa.test.ts` |
| M10 | supply chain | `.github/workflows/release.yml:28-31,66-74,117,169-181` | the publish gate is a job inside the ref being published; `npm-publish` has no required reviewers (root `CLAUDE.md`) | ability to push a `v*` tag → the tagged commit supplies its own `release.yml` and `scripts/release.ts`; provenance binds to the workflow filename, not its content. Blast radius: every consumer of the 31 packages. Also `:117` interpolates a tag-derived output into `run:` where every other step uses `env:` | PLAUSIBLE | enforce the gate outside the tagged ref (tag ruleset or required reviewer) — **owner decision, it reverses the 2026-09-05 one**; pass `version` via `env:` | `scripts/release-workflow.ts` shape check |

## Low

| # | Where | Defect | Verdict |
|---|---|---|---|
| L1 | `packages/ai/src/vector-scope.ts:20`, `pg-vector.ts:63`, `pg-vector-sql.ts:33` | a vector store is `UNSCOPED` until `.scoped({tenant})`; a forgotten call searches every tenant. Entities derive the tenant from the ambient actor | PLAUSIBLE |
| L2 | `packages/core/src/seal.ts:90-112`, `seal-keys.ts:50-59` | one AES-GCM key serves every sealed column, both IV modes and the secrets store; deterministic IVs are a 96-bit truncated HMAC — one shared nonce budget. Fix: a subkey per purpose | PLAUSIBLE |
| L3 | `packages/auth/src/policy-bridge.ts:72-95` | API-key and workload-token scopes become `permissions` verbatim, wildcards included, never intersected with the owner's grants | CONFIRMED |
| L4 | `packages/auth/src/tables.ts:41` | `x_users.mfa_secret` is plaintext (acknowledged in the header). Fix: seal with `purpose: 'auth:x_users.mfa_secret'` | reading |
| L5 | `ci.yml`, `wiki.yml`, `registry-audit.yml`, `deploy-social-demo.yml:79`; `docker/Dockerfile` | actions tag-pinned where `release.yml` SHA-pins; base images by tag; the demo deploy's `workflow_dispatch` builds any selected ref and pushes `:latest` | reading |
| L6 | `packages/cli/src/runtime-storage.ts:183-190`, `runtime-assets.ts:70-77` | stored objects served inline from the app origin with the stored content type, no `Content-Disposition`, no sandbox. Safe at the default image-only policy | reading |
| L7 | `packages/http/src/server.ts:292-297` | `/healthz`, `/readyz` bypass the pipeline (no rate limit); expose `buildId`, `inflight`, dependency check names | reading |
| L8 | `packages/auth/src/oauth-route.ts:134-156,247-250` | OAuth route errors return `cause` / `fix` publicly (one reports the configured secret's length); `redirect_uri` is Host-derived when `APP_URL` is unset | reading |
| L9 | `x dev` | binds `localhost` but checks no `Host` — DNS rebinding makes `/_x/*` readable cross-origin | PLAUSIBLE |
| L10 | `packages/query/src/page-controls.ts:28`, `pagination.ts:84-85` | `_first` up to 10,000 overrides a declared `.limit()` (same root as [`sweep-1-tiers-2-3.md`](sweep-1-tiers-2-3.md) row 5) | reading |

## Checked and sound (do not re-open)

- Action surfaces — HTTP, MCP, job handle, LLM tool (`packages/ai/src/tools.ts:116`), bearer mount all end in `invoke` → `guardBeforeInput` + `guard`.
- Query surfaces — HTTP, MCP, live all pass `sourceFor` / `guard`; the two `unenforced` sites return SQL text, never rows.
- MCP exposure — `expose === true` only; hidden and absent tools answer identically; app tools need a `policy` (`X_MCP_TOOL_UNSAFE`).
- Live-query windows — per-tenant id, service actor carrying only that org, per-subscriber row gate, forged cursors cold-start.
- Entity tenancy — every plan through `scopedPlan` (`packages/entity/src/plan.ts:147`); upsert refuses a conflict target without the tenant column.
- Admin — screens, CRUD, search, lookup, actions, MCP tools all call `decideOperation` / `decideAction`; rows load through `findRow`.
- CSRF exemptions; a cross-site `Authorization` header needs a preflight.
- Unsigned id token from the token endpoint over TLS — OIDC Core §3.1.3.7; claims still checked.
- OAuth account pre-hijack closed; state and PKCE verifier in an HMAC'd `__Host-` cookie.
- Signed URLs; uploads (size cap before read, sniffed type, decompression bombs).
- SQL injection — `sql` tag binds; `identifier()` refuses quotes and whitespace.
- Render escaping; mail CR/LF and STARTTLS; outbound webhooks (pinned address, private ranges refused, `redirect: 'manual'`).
- Prototype pollution — `Object.create(null)` + `Object.hasOwn`.
- Error bodies — 5xx cause hidden in production (but see `fix`, [`sweep-2-entity-http-action-query-policy.md`](sweep-2-entity-http-action-query-policy.md) row 3).
- Unbounded maps — rate-limit store, auth limiter, TOTP replay guard, ISR store, live entries all capped.
- Docker / compose — non-root, read-only rootfs, `cap_drop: ALL`; no `pull_request_target`.

## Not examined — handed to sweep 2

- `scraping` browser SSRF; `ai` provider, gateway, hive, prompt assembly.
- `jobs` operator surface, drivers, export; `notify` inbox reads.
- `realtime` replication client, NATS transport, presence, client / SharedWorker.
- `pwa` service-worker caching; `flags`; S3 signing; CDN purge drivers; Helm templates.
- `entity` sealed-repo, relations, aggregates, views; `db` branch, replica routing.
- The Postgres rate-limit and auth-limiter stores; the tracked apps' own auth code; a systematic ReDoS survey.
