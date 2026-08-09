# Error codes

Every framework failure is an `UltimateError` carrying a stable `X_*` code, a concrete cause, and the exact command or edit that fixes it. Same content in the terminal, the dev overlay, the HTTP body, the MCP tool result and `--json`.

```text
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

```json
{"code":"X_DB_DRIFT","title":"schema differs from migrations","cause":"table \"posts\" has column \"publish_at\" not present in any migration","fix":"x db gen \"add publish_at\"","docs":"https://ultimate.dev/errors/X_DB_DRIFT"}
```

| Rule | Detail |
|---|---|
| Lookup | `x errors explain <CODE> --json`, or the MCP `errors.explain` tool — same content as this page |
| Uniqueness | one code is owned by exactly one package; a collision throws `X_ERROR_CODE_DUPLICATE` at registration |
| Stability | codes never change meaning. A renamed concept gets a new code and the old one stays documented |
| `fix` | always runnable or editable as written. If a fix reads "do the right thing", that is a bug — [file it](https://github.com/developerz-ai/ultimate/issues) |
| Bare `Error` | never thrown by the framework. Anything caught is normalised through `toUltimateError()` |

`As of 2026-07` this table tracks the codes registered in `packages/*/src/errors.ts`. See [Troubleshooting](Troubleshooting) for symptom-first triage and [CLI reference](CLI-Reference) for the commands named in the fixes.

## Core and runtime

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_ABORTED` | operation aborted | the request's `AbortSignal` fired: client disconnected or a deadline passed | none — stop work and return |
| `X_INTERNAL` | unexpected internal framework error | a non-Ultimate error escaped into framework code | fix the failure named in `cause`, then re-run |
| `X_INVARIANT` | invariant violated | framework state that "cannot happen" happened | report it with `x doctor --json` output attached |
| `X_UNREACHABLE` | unreachable branch was reached | an exhaustive `switch` met a value the type says cannot exist | narrow the union at the call site |
| `X_NOT_IMPLEMENTED` | this driver does not implement the requested feature | an interface-complete driver whose remote half is unwritten | use the default driver, or implement the named method |
| `X_NO_CONTEXT` | no request context is active | framework code called outside the ALS context | `runWithContext(createContext({ … }), fn)` |
| `X_SERVICE_MISSING` | service is not registered on the request context | `ctx.<service>` used without providing it | pass it in `createContext({ services: { … } })` |
| `X_SERVICE_DUPLICATE` | a service name is registered twice | two `defineService('name', ...)` calls used the same name | rename one of the two declarations |
| `X_ROLE_INVALID` | `ROLE` is not a known runtime role | typo or an old role name in the env | set `ROLE` to `web`, `sync`, `worker`, `scheduler`, `migrate` or `replicator` |
| `X_DRAINING` | process is draining and refuses new work | work arrived after SIGTERM | retry against another replica; the LB should already have removed this one |
| `X_SHUTDOWN_TIMEOUT` | graceful shutdown exceeded its deadline | an in-flight handler outlived `DRAIN_TIMEOUT` | raise `configureLifecycle({ deadlineMs })` or shorten the slow handler |
| `X_ID_INVALID` | value is not a valid id | a hand-built string passed where a typed id is required | generate ids with `uuid()` / `typedId<'post'>()` from `@ultimat3/core` |
| `X_CURSOR_INVALID` | pagination cursor is malformed, tampered with or from another query | signature mismatch — an edited cursor, or `ULTIMATE_CURSOR_SECRET` rotated — or a cursor built for a different query, filter or sort order | drop the cursor and request the first page (`after: null`) |
| `X_ERROR_CODE_DUPLICATE` | error code registered twice | two packages declared the same code | rename the colliding code in the registering package's `src/errors.ts` |

## Config and environment

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_CONFIG_INVALID` | `app.config.ts` is invalid | a field failed its schema, or a required field is missing | `x config show --json` and fix the named field; see [Configuration](Configuration) |
| `X_ENV_MISSING` | required environment variables are missing or invalid | a key absent at boot; validation runs before the server listens | `x env check --fix`, then set the keys it names |
| `X_BUN_VERSION` | Bun is older than the framework floor | Bun < 1.3 | `bun upgrade` |
| `X_NOT_IN_APP` | command must run inside an Ultimate app | no `app.config.ts` at or above the cwd | `x new myapp && cd myapp` |
| `X_PORT_IN_USE` | the dev port is taken | another `x dev` or an unrelated process holds it | `x dev --port 3001`, or stop the other process |

## Schema and validation

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_VALIDATION_FAILED` | value did not match its schema | a parse boundary rejected input | read `cause` for the failing path; correct the value or widen the schema deliberately |
| `X_SCHEMA_UNSUPPORTED` | the active schema provider cannot do this | a Standard Schema implementation without JSON Schema export | use ArkType (`t`), the blessed default |

## HTTP

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_ROUTE_NOT_FOUND` | no route matches this request | path typo, or the route was never generated | `x routes --json`, then `x g route <path>` |
| `X_METHOD_NOT_ALLOWED` | route exists but not for this method | GET against an action endpoint | call it with the method in `cause`, or add that method |
| `X_ROUTE_CONFLICT` | two routes claim the same path | a copied route file | `x routes --json`, then remove or rename one |
| `X_BODY_INVALID` | request body failed its schema | client sent the wrong shape | `x actions describe <name> --json`, then match the input schema |
| `X_UNAUTHENTICATED` | route requires an authenticated actor | no session cookie or bearer token | send credentials, or set the route's `auth` to `'public'` |
| `X_FORBIDDEN` | policy denied this actor | the actor exists but the policy said no | `x policy explain <path> --json` |
| `X_RATE_LIMITED` | rate limit exhausted for this key | bucket empty | retry after `Retry-After`, or raise `rateLimit.buckets` in `app.config.ts` |
| `X_BUILD_SKEW` | client build id does not match the server build id | a tab open across an incompatible deploy | reload; the SW fetches the new build manifest. See [PWA and offline](PWA-And-Offline) |
| `X_SERVER_NOT_STARTED` | server handle used before `start()` | reading `url()` too early in a test | `await createServer({ … }).start()` first |
| `X_PIPELINE_NO_RESPONSE` | a pipeline stage produced no response | a middleware returned `undefined` | return a `Response` from the stage or from the handler |
| `X_TIMEOUT` | the operation exceeded its deadline | a slow upstream inside a request | raise the route's timeout, or move the work into a `job` |

## Policy and authz

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_POLICY_DENIED` | policy denied this actor | the internal denial, surfaced as `X_FORBIDDEN` at the HTTP edge | `x policy explain <permission> --json` |
| `X_POLICY_MISSING` | an action was declared without a policy | a new action shipped with no `policy:` | add `policy: can('<resource>:<verb>')`, or `allow('public')` to say so explicitly |
| `X_PERMISSION_UNKNOWN` | permission string is not in the permission set | typo, or a permission never declared | add it to `definePermissions([…])` |
| `X_TENANCY_UNSCOPED` | a tenant-scoped query has no org predicate | a repo call that forgot the tenant | pass `{ orgId }`, or wrap the plan with `orgScoped(entity, orgId, plan)` |
| `X_ACTION_POLICY_MISSING` | an action was registered without a policy | build-time check on the action registry | add `policy: can('<name>')` to the declaration |
| `X_QUERY_POLICY_MISSING` | a query was registered without a policy | same, for reads | add `policy: can('<name>')` to the query |

## Auth and sessions

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_SESSION_EXPIRED` | session passed its idle or absolute expiry | `cause` names which of the two clocks ran out | sign in again, or raise `session.absoluteTtlMs` / `session.idleTtlMs` in `defineAuth` |
| `X_MFA_REQUIRED` | password proven, second factor outstanding | the user has TOTP enrolled | `POST /auth/mfa/verify { code }` with the 6-digit code, then retry |
| `X_OAUTH_STATE_INVALID` | state, nonce or PKCE verifier did not match | a replayed callback URL, a handshake that expired, or a token minted for another browser | restart the flow at `GET /auth/oauth/<provider>` — a callback URL is single-use |
| `X_OAUTH_EXCHANGE_FAILED` | the provider refused the exchange or returned no usable identity | wrong client secret, an unregistered `redirect_uri`, a spent code, or a missing scope | `cause` names the stage and the provider's own status; `meta.stage` is `token` or `userinfo` |
| `X_OAUTH_TOKEN_INVALID` | the id token failed its issuer, audience or expiry check | the client id in `.env` is not the one the authorize URL was built with, or this host's clock is skewed | match `<PROVIDER>_CLIENT_ID` to the id `beginOAuth()` used, then restart the flow |
| `X_PASSWORD_WEAK` | strength check rejected the password | too short, or a known-common password | choose a longer, uncommon password — or relax `defineAuth({ password: { minLength } })` |
| `X_ACCOUNT_LOCKED` | per-ip or per-account bucket is inside its lockout | repeated failed attempts | wait out the seconds named in `cause`, or raise `defineAuth({ rateLimit })` |
| `X_API_KEY_INVALID` | key unknown, revoked, expired or wrong | one shape for all four — a precise message is an enumeration oracle | `x auth keys list --json`, then issue a fresh key |

## Entity and database

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_DB_DRIFT` | schema differs from migrations | a column exists in code but in no migration | `x db gen "<describe the change>"` then `x db apply` |
| `X_ENTITY_DUPLICATE` | two entities claim the same name | copy-pasted `entity({ name })` | rename one; `x entities list --json` |
| `X_INVARIANT_VIOLATED` | a domain invariant rejected this row | a CHECK or a declared invariant failed | `x entity explain <entity> --json` to see the invariant and its SQL |
| `X_NOT_FOUND` | no row for that id | stale id, wrong tenant, or already deleted | confirm with `x db query "select id from <table> limit 5" --json` |
| `X_MIGRATE_CONCURRENT` | another version's migration is in flight | two deploys overlapped | wait for the running `ROLE=migrate` to exit, then redeploy |
| `X_DB_GEN_FAILED` / `X_DB_MIGRATE_FAILED` / `X_DB_BRANCH_FAILED` / `X_DB_STUDIO_FAILED` | the underlying `x db` step failed | Postgres rejected the statement, or the DB is unreachable | read `cause` — it carries the SQL error verbatim |

## Actions

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_ACTION_DUPLICATE` | two actions registered under one name | duplicate export names across features | rename one; names are global. `x actions list --json` |
| `X_INPUT_INVALID` | input failed the action's schema | wrong shape from a client or an agent | `x actions describe <name> --json` |
| `X_OUTPUT_INVALID` | the handler returned a value its `output` schema rejects | the handler drifted from the declared output | `x actions describe <name> --json`, then fix the handler or the schema |
| `X_ACTION_FOREIGN` | a value that is not an action was projected as one | a hand-rolled object with `kind: 'action'`, or an action from a duplicated copy of `@ultimat3/action` | declare it as `export const name = action({ input, output, policy, handle })` |
| `X_IDEMPOTENCY_CONFLICT` | idempotency key reused with a different payload, or still in flight | a retried request mutated its body | send a fresh `Idempotency-Key` for a different payload; otherwise retry after the first settles |
| `X_CONTRACT_DRIFT` | the published contract changed | input/output shape moved without a version bump | give new inputs a `.default()`, or bump the package version |
| `X_RPC_FAILED` | the typed client could not reach the action or the query | gateway, network, or a non-JSON response | check the gateway, then `x actions describe <name> --json` (`x queries describe` for a read) |

## Queries and live queries

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_QUERY_DUPLICATE` | two queries registered under one name | duplicated export | rename one; `x queries list --json` |
| `X_QUERY_FOREIGN` | a value that is not a query was projected as one | a hand-rolled object with `kind: 'query'`, or a query from a duplicated copy of `@ultimat3/query` | declare it as `export const name = query({ input, policy, sql })` |
| `X_QUERY_UNREGISTERED` | a query was projected before it was registered | `.tool()` / `.client()` / `.live()` on a read `registerQueries()` never named | `registerQueries(await import('./live'))` at boot, before serving reads |
| `X_MATCHER_UNSUPPORTED` | the live matcher cannot evaluate this SQL incrementally | a join, aggregate or unbounded predicate under `live: true` | simplify the `sql`, add `orderBy` + `limit`, or drop `live` |
| `X_CACHE_UNTAGGED_QUERY` | a cached query carries no tag | a query whose tables no tag covers | declare the tag on the entity; `x cache graph --json` |

## Jobs

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_IDEMPOTENCY_REQUIRED` | the job has no `idempotencyKey` | the field was omitted — normally a compile error, checked again at registration | add `idempotencyKey: (input) => '<stable>:' + input.id` |
| `X_JOB_DUPLICATE` | a live key already has a job | a second enqueue inside the dedupe window | pass `onConflict: 'dedupe'`, or make the key narrower |
| `X_STEP_DUPLICATE` | two `step.run` calls share a name | copy-paste inside `run()` | rename one — step names are the replay key |
| `X_JOB_MAX_ATTEMPTS` | the job exhausted its retries | a step kept failing | `x jobs show <id> --json` for the step trace, then `x jobs retry <id>` |
| `X_JOB_TIMEOUT` | a job exceeded its wall-clock limit | one long step | raise `timeout`, or split the work into more `step.run()` calls |
| `X_OUTBOX_NO_TX` | enqueue outside a transaction | `<job>.enqueue` called with no ambient tx | wrap in `ctx.tx(async (tx) => …)`, or enqueue with `{ outbox: false }` deliberately |
| `X_DRIVER_UNAVAILABLE` | the queue driver is unreachable | Redis/NATS down, or the URL is wrong | `x doctor --json`; check the driver URL in `app.config.ts` |

## Realtime

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_TOPIC_FORBIDDEN` | the actor may not subscribe to this topic | no guard, or the guard denied | `hub.guard('<topic>', ({ actor }) => …)` |
| `X_SUBSCRIPTION_LIMIT` | socket or tenant hit its subscription cap | a component subscribing in a loop | raise `realtime.limits.perSocket` / `perTenant`, or unsubscribe unused live queries |
| `X_PROTOCOL_VERSION` | client and sync node disagree on the wire protocol | a client from an older build | `x build` and redeploy the client; the node sends `update-available` before draining |
| `X_CURSOR_STALE` | the resume LSN is outside the change buffer | a long disconnect | pass `snapshot` to `resumeFrom()` so the fallback re-snapshots |
| `X_REBASE_CONFLICT` | a local mutation could not be rebased | server state moved incompatibly | set `conflict: 'server-wins'`, or return a row from `custom(merge)` |
| `X_TRANSPORT_UNAVAILABLE` | the fanout bus is unreachable | NATS/Redis down or misconfigured | `x doctor transport` — check `REALTIME_TRANSPORT_URL` |

## Cache

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_CACHE_TAG_UNKNOWN` | a tag no entity declared | typo in `invalidates: [tag.pots]` | `x manifest` to regenerate the tag graph, then fix the tag |
| `X_CACHE_TOO_LARGE` | one entry exceeds the tier's byte budget | caching a whole row set | raise `cache.<tier>.maxBytes`, or cache a projection |
| `X_CACHE_DRIVER_UNAVAILABLE` | a tier's backing store is missing | no Redis binding, no CDN token | provision the tier, or drop it from `app.config.ts` |

## Routes, render and budgets

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_ROUTE_MODE_INVALID` | render mode not allowed on this surface | `stream` on a `site/` route | use `static`, `isr` or `ssr` in `site/`; `stream`, `spa` or `ssr` in `app/` |
| `X_ROUTE_OFFLINE_MISSING` | the route's offline strategy is missing or contradictory | `precache` on an `ssr` route | set a compatible `offline`, or change the render mode |
| `X_ROUTE_META_MISSING` | required metadata missing | no `meta.title`, or no `description` on a `site/` route | add it to `meta` in the route file |
| `X_ROUTE_DUPLICATE` | two route files resolve to one URL | a copied page directory | delete or rename one |
| `X_SURFACE_BOUNDARY` | a surface imported across the hard boundary | `site/` reached `app/`, transitively | `x fix boundary <file>`, or move the shared module out of `shared/ui` |
| `X_BOUNDARY_SITE_TO_APP` | `site/` imported `app/` | the classic transitive import | the chain is printed in `cause`; break it at the named hop |
| `X_BOUNDARY_APP_TO_API` | `app/` imported `api/` at runtime | a value import instead of `import type` | use `import type`, and call the typed client |
| `X_BOUNDARY_ROUTE_TO_DB` | a route touched the database | SQL in a page file | move it into `repo.ts` and call a query |
| `X_BOUNDARY_SERVICE_TO_HTTP` | a service imported HTTP | request awareness inside business logic | take the values as arguments so a job can reuse the service |
| `X_BOUNDARY_SHARED_LEAF` | `shared/` imported a surface | `shared/` is a leaf | invert the dependency |
| `X_BUDGET_EXCEEDED` | a route blew its JS or LCP budget | a heavy transitive import | `x routes --json` for the chain; move it behind `hydrate: 'interaction'` or raise the budget deliberately |
| `X_BUDGET_UNMEASURED` | a route declares a JS or LCP budget the build never measured | the route is absent from `.x/build-stats.json` | `x build`, then `x verify` |
| `X_PRERENDER_FAILED` | a prerendered path threw during build | `prerender()` returned an id that no longer resolves | fix the data source, or narrow `prerender()` |

## SEO

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_SEO_META_MISSING` | a `site/` route is missing required metadata | no title, description or `og.image` | add it to `meta`; the file is named in `cause` |
| `X_SEO_META_TOO_LONG` | title or description exceeds what results render | a description over 160 chars | shorten it — `cause` carries the measured length |
| `X_SEO_DUPLICATE_META` | two routes share a title or description | copied metadata | make each page's meta unique |
| `X_SEO_CANONICAL_MISMATCH` | canonical URL does not match the route path | a hand-written canonical | delete it — canonicals come from the route table |
| `X_LD_INVALID` | JSON-LD node is missing a required schema.org field | an `ld.*` helper called with a partial object | supply the field named in `cause` |
| `X_SITEMAP_TOO_LARGE` | sitemap exceeds the 50,000-entry limit | too many prerendered URLs in one file | enable sitemap index splitting in `app.config.ts` |

## PWA and build skew

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_PWA_NO_OFFLINE_FALLBACK` | `pwa.offline.fallback` is not set | the required field was removed | set `pwa: { offline: { fallback: '/offline' } }` |
| `X_PWA_ICON_MISSING` | no source icon to generate from | the configured icon path does not exist | add an SVG or >=1024px PNG and point `pwa.icon` at it |
| `X_PWA_MANIFEST_INVALID` | the generated web manifest failed validation | a bad `start_url` or `scope` | fix the `pwa` block; `cause` names the field |
| `X_SW_SCOPE_INVALID` | the service-worker scope cannot serve the routes it precaches | a scope narrower than the app | serve `sw.js` from the app root |
| `X_SW_HAND_EDITED` | `sw.js` does not match its build checksum | someone edited a build artifact | `x build`; change the route's `offline` field instead |
| `X_SW_UNCACHEABLE` | offline strategy contradicts the render mode | `precache` on `ssr` | pick `network-only`, or change the render mode |
| `X_BUILD_ID_MISSING` | no immutable build ID | a build produced outside `x build` | build with `x build`; never use a timestamp or `latest` |
| `X_PWA_NO_ICON_SOURCE` | the CLI found no icon to generate the set from | same as `X_PWA_ICON_MISSING`, at build time | add the source icon, then `x build` |

## i18n, money, time

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_LOCALE_UNSUPPORTED` | locale is not in the supported set | a URL or header requesting an unconfigured locale | `x i18n add <locale>` |
| `X_CATALOG_MISSING_KEYS` | a catalog is missing keys used in source | a new `t()` key with no translation | `x i18n sync <locale>` |
| `X_CATALOG_INVALID` | a catalog entry is malformed | bad interpolation or a non-string value | `x i18n check --json` |
| `X_CURRENCY_UNKNOWN` | currency code not in the currency table | a typo, or a currency the table lacks | `x money add-currency <ISO> --exponent <n>` |
| `X_CURRENCY_MISMATCH` | two `Money` values in different currencies | adding EUR to USD | `convert(value, '<target>', rate)` first |
| `X_MONEY_NOT_INTEGER` | a `Money.minor` that is not an integer | a float leaked in | `fromDecimal('12.99', 'USD')`, or pass an explicit rounding mode |
| `X_ALLOCATION_INVALID` | split ratios or part count are unusable | zero parts, or all-zero ratios | pass a positive part count, or finite non-negative ratios |
| `X_RATE_MISSING` | no FX rate for the pair | no `RateProvider` registered | register one — there is no default, because a wrong rate is worse than a missing one |
| `X_TIMEZONE_INVALID` | not an IANA zone | `CET`, `+02:00`, or a typo | use `Europe/Berlin`, `America/New_York`, `UTC` |
| `X_INSTANT_INVALID` | not a parseable instant | a date string with no offset | pass ISO-8601 with `Z` or an offset |
| `X_DURATION_INVALID` | not a parseable duration | `'3 days'` | use `'3d'`, `'2h30m'`, `'250ms'`, or ISO-8601 `PT2H30M` |
| `X_CRON_INVALID` | not a parseable cron expression | wrong field count | 5 fields (`m h dom mon dow`) or 6 with seconds |
| `X_DST_AMBIGUOUS` | the local time occurs twice | a fall-back overlap | pass `{ overlap: 'first' }` or `{ overlap: 'second' }` |
| `X_DST_NONEXISTENT` | the local time does not exist | a spring-forward gap | pass `{ gap: 'next' }` or `{ gap: 'previous' }` |

## Mail

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_MAIL_LOCALE_MISSING` | `send()` was called without a locale | a JS caller, or a cast that dropped the required field | `send(mail, data, { to, locale: ctx.locale })` |
| `X_MAIL_TEMPLATE_UNKNOWN` | no mail is registered under that id | the module holding `defineMail({ id })` was never imported (also raised for an unregistered layout) | export the `defineMail` and import it at boot |
| `X_MAIL_DUPLICATE` | two mails claim the same id | a copy-pasted `defineMail` | rename one of the two declarations |
| `X_MAIL_TEXT_MISSING` | the rendered mail has no plain-text part | a template of images and buttons only | add a text-bearing block: `blocks.paragraph('mail.<id>.body')` |
| `X_MAIL_DRIVER_UNAVAILABLE` | no mail driver is configured | `setMailDriver` was never called | `setMailDriver(createMemoryDriver())` in dev, `createSmtpDriver({ url: env.SMTP_URL })` live |
| `X_MAIL_HEADER_INVALID` | a header value carries a line break | interpolated data with a CR/LF reached `Subject` — header injection | strip line breaks from the value before it reaches the header |
| `X_MAIL_SEND_FAILED` | the mail transport refused the message | a rejected recipient, bad credentials, a throttle, a dead socket | the `cause` names the stage, the provider's own status and whether a retry can help |

## MCP and AI

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_MCP_TOOL_UNKNOWN` | no such tool for this caller | a stale tool name, or one this caller may not see | call `tools/list` to read the catalog |
| `X_MCP_ARGS_INVALID` | tool arguments failed the input schema | guessed arguments | re-read `inputSchema` from `tools/list` and resend |
| `X_MCP_SCOPE_DENIED` | the connection's token does not carry the tool's scope | a read token calling a write tool | `x token grant <scope>`, then reconnect — scopes are fixed for the life of a connection |
| `X_MCP_QUERY_REJECTED` | `db.query` was not given one read-only statement | empty input, a batch, a non-read leading keyword, a mutating keyword anywhere at statement level (including a data-modifying CTE), a locking clause (`FOR UPDATE`/`FOR SHARE`), `EXPLAIN ANALYZE`, or a function that reaches outside the database (`pg_read_file`, `pg_sleep`, `dblink`, `lo_import`, …) | send exactly one **read-only** `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`TABLE`/`VALUES` statement. `db.query` has no write path at all: change data by calling an action exposed with `mcp: { expose: true }`, and change schema with `db.migrate` after `x db branch <name>` |
| `X_MCP_NOT_BRANCH_DB` | `db.migrate` was aimed at a database that is not a branch | a production-tagged target, or any shared/long-lived database | `x db branch <name>`, then retry `db.migrate`; production migrates through `ROLE=migrate` in the deploy hook, never through MCP |
| `X_MCP_PROTOCOL` | the MCP handshake or auth is wrong | missing bearer token, or a user-shaped actor | send `Authorization: Bearer <token>`; resolve MCP callers as agents |
| `X_MCP_TOOL_UNDECLARED` | `defineAppMcp` lists a primitive that declares no MCP exposure | an action or query named in `actions:`/`queries:` with no `mcp` block, or `mcp: { expose: false }` | add `mcp: { expose: true, description }` beside the primitive's policy — or drop it from the list and let `include: 'exposed'` project what opted in |
| `X_MCP_TOOL_UNSAFE` | an MCP tool declares no policy | a hand-written `tools:` entry written without `policy` | add `policy: '<resource>:<verb>'`, reusing the permission its action uses |
| `X_MCP_TOOL_DUPLICATE` | two primitives project to one MCP tool name | a `tools:` record key colliding with an exposed action, or an action and a query sharing a name | rename one — the tool name is the primitive's export name, or the `tools` record key |
| `X_AI_BUDGET_EXCEEDED` | a model call would exceed its budget | prompt too large, or cost cap reached | raise `ai.budget` for the scope, or shorten the prompt |
| `X_AI_GATEWAY_MISSING` | an `llm()` action ran with no gateway installed | boot never called `configureAi` | `configureAi({ gateway: createGateway({ providers: [new AnthropicProvider()] }) })` at boot |
| `X_AI_PROMPT_VERSION` | prompt version or slots are wrong | an edited prompt with no version bump, or a missing variable | bump the version in `definePrompt`, then `x manifest` |
| `X_AI_PROVIDER_UNAVAILABLE` | the model provider is unreachable | a non-2xx, an in-band `error` event, or a stream cut before `message_stop` | retry a 429/5xx (the gateway already does); fix the request a 4xx names |
| `X_AI_KEY_MISSING` | the provider API key is not set | `ANTHROPIC_API_KEY` / `EMBEDDINGS_API_KEY` unset and no `apiKey` passed | `export ANTHROPIC_API_KEY=<key>`, or pass `{ apiKey }` to the provider |
| `X_AI_REQUEST_INVALID` | the provider would reject this request | `thinking: 'disabled'` above `high` effort | use `effort: 'high'` or below, or leave thinking adaptive |
| `X_LLM_OUTPUT_INVALID` | structured output failed its schema on the answer and on the repair turn | the model would not produce the shape | describe the shape in the prompt template and bump its version, or widen `output` in the `llm()` declaration |
| `X_EVAL_THRESHOLD` | an eval scored below its tolerance | a prompt edit regressed cases against the recorded baseline | `x test <eval>` for per-case scores; `ULTIMATE_EVAL_RECORD=1 x test eval` to accept new numbers as a reviewed diff |
| `X_EVAL_BASELINE_MISSING` | an eval has no recorded baseline to gate against | a new eval, or a `baseline:` that is not `import.meta.resolve('./…')` | `ULTIMATE_EVAL_RECORD=1 x test eval`, then commit the baseline file |
| `X_EVAL_BASELINE_INVALID` | a recorded baseline cannot be read | a hand-edited or half-merged baseline file | `ULTIMATE_EVAL_RECORD=1 x test eval` to re-record it |
| `X_EVAL_MISSING` | a prompt has no eval | a `definePrompt` with no `defineEval` naming it | add `defineEval({ prompt, cases, scorers, tolerance, baseline })` beside the prompt |
| `X_VECTOR_DIM_MISMATCH` | embedding dimensions differ from the store | the embedder model changed | use the original embedder, or `x ai reindex` |
| `X_VECTOR_SCOPE_WIDENED` | a derived vector scope tried to leave its tenant | a handler re-scoped the store it was handed | derive from the unscoped store: `vectorStore.scoped({ tenant })` |

## Admin and manifest

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_ADMIN_ENTITY_UNKNOWN` | the admin references an entity that does not exist | a renamed entity | `x g entity <name>`, then `x manifest` |
| `X_ADMIN_POLICY_MISSING` | an admin-exposed subject has no policy | a screen added without authz | add `policy: can('<subject>')` to the definition |
| `X_ADMIN_FIELD_UNSUPPORTED` | a column type the admin cannot render | an exotic Postgres type | supply a custom field renderer, or hide the column |
| `X_ADMIN_DENIED` | the actor may not use this admin surface | missing `admin:*` permission | grant the permission through the normal policy layer |
| `X_ADMIN_TOOL_FORBIDDEN` | an admin MCP tool was called without permission | agent acting beyond its user | nothing to fix — the policy is correct |
| `X_DEV_DASHBOARD_IN_PROD` | `/_x` was mounted outside dev | the dev dashboard shipped in the image | delete the `/_x` mount from the production entrypoint |
| `X_MANIFEST_DRIFT` | `x.manifest.json` differs from the code | a primitive changed without regenerating | `x manifest` |
| `X_MANIFEST_STALE` | `openapi.json` is stale | the committed spec does not match the actions the code registers | `x manifest`, then commit |
| `X_MANIFEST_BREAKING` | a published contract was removed or narrowed | a breaking change with no version bump | bump the major version, or restore the contract |
| `X_AGENTS_MD_MISSING` | no `AGENTS.md` | the human-authored file was deleted | write it by hand — short: stack, commands, conventions |
| `X_AGENTS_MD_TOO_LARGE` | `AGENTS.md` grew past its cap | generated facts pasted into it | move facts into `x.manifest.json`; keep conventions only |

## Testing

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_TEST_DB_UNAVAILABLE` | no Postgres for the test template | nothing listening | run `x dev` (embedded Postgres), or set `TEST_DATABASE_URL` |
| `X_TEST_NETWORK_SEALED` | a test tried to reach the network | an unmocked external call | `mockFetch('<url>', …)`, or `allowHost('<host>')` if it must be real |
| `X_TEST_NONDETERMINISTIC` | a test read wall-clock time or unseeded randomness | `Date.now()` in the code under test | wrap in `frozenClock()` / `seededRandom()`, or remove the read |

## UI

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_TOKEN_UNKNOWN` | design token role does not exist | a typo, or a raw colour that was never a token | use a role from `@ultimat3/ui` tokens; see [Theming](Theming) |
| `X_THEME_INVALID` | theme is not `light` or `dark` | a bad `data-theme` value | set `light` or `dark`, or clear the attribute to follow the OS |
| `X_UI_RUNTIME_MISSING` | a host capability the component needs is absent | `IntersectionObserver` or `localStorage` unavailable | render the no-JS fallback path |
| `X_UI_INVALID_VALUE` | a formatting component received an unrenderable value | `NaN` money, or an invalid date | fix the value upstream; formatting never guesses |

## CLI and verify

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_CLI_UNKNOWN_COMMAND` | not a command | a typo | `x help` — the suggestion is in `fix` |
| `X_CLI_BAD_FLAG` | flag rejected | unknown flag, or a bad value | `x <command> --help` |
| `X_CLI_UNEXPECTED` | the CLI itself failed | a bug, or a broken environment | `x doctor --json` and attach it to an issue |
| `X_VERIFY_FAILED` | one or more verify steps failed | the gate is red | `x verify --json` — every step's findings arrive in one run |
| `X_TYPECHECK_FAILED` | `tsc` failed | a type error anywhere in the workspace | `bunx tsc -b --pretty false` |
| `X_LINT_FAILED` | Biome failed | `any`, a default export, a bare `Error`, a raw hex colour | `bunx biome check --write .` |
| `X_TEST_FAILED` | a test type failed | a red test | the `fix` is the exact `bun test …` invocation the step ran |
| `X_FILE_TOO_LONG` | a source file is over 500 lines | one file doing several jobs | split it; the `fix` names the file |
| `X_PACKAGE_SHAPE` | a workspace package is missing a contract file | a package added by hand | `bun run scripts/new-package.ts <pkg> --only <file>` |
| `X_APP_PACKAGE_INVALID` | the app's `package.json` has no usable `name`/`version` — the manifest never fabricates `app@0.0.0`, because its version is the compatibility gate | a malformed or hand-trimmed `package.json` | `bun pm pkg set name=<app> version=0.1.0` |
| `X_BUILD_FAILED` | `x build` failed | a static check or the bundler | read `cause`; the failing step is named |
| `X_DEPLOY_FAILED` | a deploy step failed | the compose/helm command exited non-zero | run the printed command directly for full output |
| `X_GENERATE_CONFLICT` | a generator would overwrite a file | the name is taken | `x g … --force`, or choose another name |
| `X_SCAFFOLD_PATH_ESCAPE` | a generated path resolves outside the scaffold sandbox | a `..` segment or an absolute path in a template's `GeneratedFile.path` | make the path relative to the app root with no `..`, then `bun test packages/cli/src/scaffold-typecheck.contract.test.ts` |

## Names used in the design docs

Some design docs predate the implementation. `As of 2026-07` these are the mappings; the right-hand column is what the framework actually throws.

| Design doc name | Implemented code |
|---|---|
| `X_JOB_NO_IDEMPOTENCY_KEY` | `X_IDEMPOTENCY_REQUIRED` |
| `X_JOB_DUPLICATE_STEP` | `X_STEP_DUPLICATE` |
| `X_JOB_STEP_FAILED` | `X_JOB_MAX_ATTEMPTS` (retries exhausted) or `X_JOB_TIMEOUT` |
| `X_SEO_NO_TITLE` / `X_SEO_NO_DESCRIPTION` | `X_SEO_META_MISSING` |
| `X_BOUNDARY_VIOLATION` | `X_BOUNDARY_SITE_TO_APP` and the other `X_BOUNDARY_*` codes |
| `X_TEST_NETWORK_EGRESS` | `X_TEST_NETWORK_SEALED` |
| `X_LIVE_QUERY_LIMIT` | `X_SUBSCRIPTION_LIMIT` |
| `X_ENV_INVALID` | `X_ENV_MISSING` |
| `X_CACHE_UNTAGGED_QUERY` | reported by `x verify` as part of the cache-graph check |

New codes are added in the owning package's `src/errors.ts` and registered through `registerErrorCodes()`; add the row here in the same pull request — see [Contributing](Contributing).
