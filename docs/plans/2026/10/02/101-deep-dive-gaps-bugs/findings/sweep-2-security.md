# Sweep 2 — security (areas sweep 1 left unexamined)

> Findings for [`../overview.md`](../overview.md). Read-only audit at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `scraping`, `ai`, `jobs` operator surface, `notify` inbox, `realtime` replication / NATS /
> presence, `pwa`, `flags`, S3 driver, CDN purge, `entity` preload / views, `db` branch / replica,
> the Postgres limiter stores, the Helm chart, both tracked apps' auth, a ReDoS survey.
> Tally: critical 0 · high 2 · medium 6 · low 10. CONFIRMED = executed against `packages/*/src`.
> Stated at the level needed to fix and test. No reproduction strings.
> **No authorization or tenancy bypass was found in the scoped packages.** Both highs are a control
> that exists on one surface and is structurally absent on another.

## High

| # | Axis | Where | Defect | Precondition → impact | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|---|
| H1 | secrets in error strings | `packages/ai/src/tools.ts:206` (`describeFailure`), `packages/mcp/src/framework-error.ts:57`, `packages/mcp/src/server.ts:458`. The control they lack: `packages/http/src/problem-meta.ts:56,136` (`hasPublicCause`) | HTTP blanks the `cause` of every 5xx code not on a public list; the MCP error data and the agent `tool_result` carry `cause` and `fix` for any coded error | an authenticated MCP caller, or a user who can run an `agent()` action whose tool fails at the database → `X_DB_STATEMENT_FAILED`'s cause (the server message plus the statement, `packages/db/src/errors.ts:243`) reaches the remote client; on the agent path it is also sent to the model provider — an exposure the app cannot recall | CONFIRMED | move the public-cause predicate into `core`; all three renderers ask it; a hidden cause becomes code + a fixed sentence | `packages/ai/src/tools.test.ts`, `packages/mcp/src/server.test.ts`, the verdict `packages/http/src/problem-redaction.test.ts` pins |
| H2 | authn / limiter | `packages/auth/src/auth.ts:285` (assert) → `:296` (KDF) → `:303` (record); `rate-limit.ts`, `rate-limit-postgres.ts` | login lockout is check-then-act across the KDF — same defect as [`sweep-2-concurrency.md`](sweep-2-concurrency.md) row 4, here with the Postgres store: two separate statements, the advisory lock released when the first autocommits | unauthenticated, N parallel logins on one account → N guesses per window instead of `maxAttempts`. Org and IP buckets race the same way | CONFIRMED (40 concurrent, `maxAttempts: 5`) | the limiter becomes a reservation: count atomically before the KDF, refund on success — `SQL_RATE_LIMIT_TAKE` (`packages/http/src/rate-limit-postgres.ts`) | `packages/auth/src/auth-lockout.test.ts`, `rate-limit-postgres.live.test.ts` |

## Medium

| # | Axis | Where | Defect | Precondition → impact | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|---|
| M1 | cost exhaustion | `packages/ai/src/llm.ts:264`, `agent.ts:276`, `gateway.ts:119` (`callLedger` builds a ledger with no `actorKey` / `orgKey`) | gateway `actor` / `org` token ceilings are inert on `llm()` and `agent()` — checked only when a key is present (`budget.ts:195`); only a hand-written `gateway.scope()` sets one | any user who may call such an action → unbounded spend against a declared per-user / per-tenant cap | CONFIRMED | derive the keys from `ctx.actor` in `llm()` / `agent()`, as `actorScope()` does for the cache (`llm-cache.ts`) | `packages/ai/src/llm.test.ts`, `agent.test.ts` |
| M2 | cost exhaustion | `packages/ai/src/hive.ts:134` | `hive()` roots on `new BudgetLedger({ limits: {} })` — every gateway ceiling dropped for member calls. Exact location for [`sweep-1-tier-4.md`](sweep-1-tier-4.md) row 1 (cited there as `:72`, approximate) | caller of a hive action → no `tokensIn` / `request` / `costPerCall`, times the member count | CONFIRMED (mechanism) | `currentBudget() ?? gateway.callLedger?.() ?? …`, the line `agent.ts:274-277` has | `packages/ai/src/hive.test.ts` |
| M3 | SSRF | `packages/scraping/src/robots-fetch.ts:87` | the robots read follows redirects off the allow list — the one request on this leg not walked hop by hop. Upgrades [`sweep-2-admin-testing-scraping-scripts.md`](sweep-2-admin-testing-scraping-scripts.md) Low from PLAUSIBLE | an allow-listed site answers `/robots.txt` with a redirect → a blind GET from the worker to any address. Reachability, not read-back | CONFIRMED | `redirect: 'manual'` + the per-hop `screen` of `packages/scraping/src/http.ts:254`; a redirect off the list reads as "no robots" | `packages/scraping/src/robots-fetch.test.ts` |
| M4 | SSRF | `packages/scraping/src/cdp-arm.ts:124` | `allowHosts` is armed on the one page `opened()` creates — new targets, service workers, sockets unhandled. The package's table says "enforced, never advisory" | script on a scraped page opens a new target → requests leave the screened one | PLAUSIBLE, low — no browser run; `cdp-fake.ts` does not model new targets | arm (or refuse) every new target at the browser level; an address-class floor (L1) | `packages/scraping/src/driver-cdp.test.ts` |
| M5 | resource exhaustion | `packages/storage/src/grant.ts:96-107`, `driver-s3.ts:405`, `:282`, `attachment.ts:146` | on the S3 driver the grant's `maxBytes` is enforced by nothing; `get()` buffers the whole object. Acknowledged in a comment (`driver.ts:86-94`); no `wiki/Known-Gaps.md` row. **Narrows a sweep-1 "not a problem" line** — `upload.ts:216` re-checks at confirmation; `promoteAttachment` does not | an authenticated user with an upload grant on an S3 disk → objects far past the policy; a later server `get()` buffers one whole | CONFIRMED (reading; no S3) | `promoteAttachment` takes the policy, refuses / deletes on `stat().size`; `get()` takes a cap as `put()` does (`maxPutBytes`, `driver-s3.ts:207`) | `packages/storage/src/attachment.test.ts`, `driver-parity.test.ts` |
| M6 | resource exhaustion — an app as evidence | `dummy/social-media-clone/apps/web/app/auth/service.ts:33,101` | the deployed demo's sign-in keeps an unbounded map keyed on the submitted handle; no lockout; the captcha is off when its secret is unset | unauthenticated → heap growth chosen by the caller. Framework angle: the app hand-rolls sessions and never calls `login()` — see [`sweep-2-architecture.md`](sweep-2-architecture.md) H5; `examples/dummy` mounts no sign-in route. Neither tracked app exercises the framework's credential flow | CONFIRMED (reading) | `createAuthLimiter` (`packages/auth/src/rate-limit.ts`), or make `login()` usable for a handle-keyed app | `dummy/social-media-clone/apps/web/app/auth/service.test.ts` |

## Low

| # | Where | Defect | Verdict |
|---|---|---|---|
| L1 | `packages/core/src/host-rules.ts:70` | host rules match names only — no address-class floor, no DNS pin; an allow-listed name resolving inward reaches private ranges. Fix: `classifyAddress` + pinning, as `packages/jobs/src/webhook-target.ts` | reading |
| L2 | `packages/realtime/src/pg-connection.ts:222,228`, `pg-tls.ts:41` | the replication client answers cleartext and MD5 auth requests; default `sslmode` is `prefer`. Fix: refuse both on a non-TLS session unless opted in | reading |
| L3 | `packages/entity/src/preload.ts:78-95` | a `hasMany` preload pages until exhausted — no per-parent or total cap | reading |
| L4 | `packages/pwa/src/push.ts:195-198` | `notificationclick` opens any absolute URL the payload carries — no same-origin check | reading |
| L5 | `packages/ai/src/remote-embedder.ts:135` | a non-2xx body quoted into the error without the `withoutKey` scrub (`error-body.ts`) | reading |
| L6 | `packages/ai/src/llm.ts:451` | `parseJsonish` is quadratic on an unterminated fence followed by whitespace — 32k chars, 0.9 s; bounded by `maxTokens`; model-controlled | CONFIRMED |
| L7 | `packages/entity/src/memory-match.ts:158` | only runs of `%` are collapsed; separated wildcards still explode. Memory driver only; needs an app forwarding a raw LIKE pattern | CONFIRMED |
| L8 | `packages/cache/src/cdn.ts:46-48` | emitted `Surrogate-Key` / `Cache-Tag` joined unvalidated; purge refuses a key with whitespace or a comma (`purge-http.ts`) — such a row is tagged and can never be purged. Fix: `assertPurgeableKeys` at emission | reading |
| L9 | `docker/helm/templates/_helpers.tpl:88` | one secret is `envFrom`'d into every role and the migrate job; no NetworkPolicy template; `/tmp` `emptyDir` has no `sizeLimit` | reading |
| L10 | `dummy/social-media-clone/apps/web/shared/session.ts:53,60` | the session reader falls back from the `__Host-` cookie to an unprefixed name; `decodeURIComponent` on a malformed value throws inside the authenticator | reading |

## Checked and sound (do not re-open)

- LLM tool calls — `packages/ai/src/tools.ts:116` calls `invoke` with `ctx.actor`; the tool's own policy and schema run; the model cannot name an actor.
- Gateway exact cache (key is the whole request); semantic cache scope `[kind, id, orgId]`.
- Webhook SSRF and signing — resolve, classify every address, pin, `redirect: 'manual'`. Nit: a 6to4 address embedding a private v4 classifies `public` (low confidence).
- Jobs operator across tenants — `jobRowScope` merged into list, detail, bulk; `job-where.ts` intersects.
- pg driver SQL — every interpolation is a module constant.
- Export — formula lead characters neutralised.
- Replication slot / publication names — `assertIdentifier`; SCRAM verifies the server signature.
- NATS subjects (`[A-Za-z0-9_-]+`), KV keys (base64url), presence joined after the channel guard.
- Offline queue replay as another actor — keyed by principal, wiped on rescope (but the in-flight pass: [`sweep-2-realtime.md`](sweep-2-realtime.md) row 4).
- SharedWorker — same-origin; name carries principal and build.
- Service worker — `guarded()` never stores `private` / `no-store`. Residual: a session that expires rather than signs out leaves its partition readable offline.
- Flags — server-side evaluation. CDN purge credentials — headers only.
- Preload / aggregate crossing a tenant or soft-delete — same repo, `scopedPlan`; sealed columns refuse order, filter, group, aggregate.
- Inbox — every statement predicated on `recipient`. Branch and read-only role SQL.
- ReDoS survey — `t.email`, mail `ADDRESS_SPEC`, `statement-excerpt`, route-path patterns linear; `SEMVER` reads the package manifest only.

## Leads not chased

- An ungated page whose loader personalises on `ctx.actor` is `public, s-maxage` (`packages/cli/src/runtime-render.ts:350-356`).
- A SharedWorker scoped to one principal redialling with another's cookie after a sign-in in another tab.

## Still not examined

- `scraping`: `auth`, `event-prompt`, `cdp-target` past line 200, `html-target`, the watchdog.
- `ai`: provider wire parsers, SSE reader, `vector` / `pg-vector` bodies, evals.
- `jobs`: `redact-input`; `realtime`: `pg-socket` framing limits, `local-store-idb`; `db`: `replica-client` routing body.
- `entity`: `pg-sql-aggregate` identifier quoting, `bulk-write`.
- Nothing needing a real browser, S3, NATS or Postgres was run.
