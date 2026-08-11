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
| Registration | a code exists when its owning package calls `registerErrorCodes()`. That one call is what makes it explainable, unique and documented-or-fail — a code emitted as a `Finding` rather than thrown is registered the same way |
| Enforcement | the `errors` step of `x verify` fails on an empty or advice-only `fix` (`X_ERROR_FIX_INVALID`), on a declared code with no row on this page (`X_ERROR_CODE_UNDOCUMENTED`), and on a row this page presents as live that no package registers (`X_ERROR_CODE_UNREGISTERED`) |

`As of 2026-08` every code above [Reserved codes](#reserved-codes) resolves through `x errors explain`, with one exception the gate knows about: this repository's own gate scripts (`X_BOUNDARY_VIOLATION`, `X_ROADMAP_*`, `X_REFERENCE_APP_*`, `X_SETUP_INSTALL_FAILED`, `X_ADMIN_FLATTENER_VIOLATION`) never ship, so no package may own them. See [Troubleshooting](Troubleshooting) for symptom-first triage and [CLI reference](CLI-Reference) for the commands named in the fixes.

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
| `X_CURSOR_SECRET_DEV` | cursors are signed with the shipped development key | `ULTIMATE_CURSOR_SECRET` is unset in a production environment, so the signing key is the constant published in `@ultimat3/core` and a client can forge a page position. Reported by `x doctor`, never thrown | `export ULTIMATE_CURSOR_SECRET="$(openssl rand -hex 32)"` |
| `X_ERROR_CODE_DUPLICATE` | error code registered twice | two packages declared the same code | rename the colliding code in the registering package's `src/errors.ts` |
| `X_REGISTRAR_MISSING` | no registrar is loaded for a primitive kind | the owning package is absent from the graph, so nothing announced a registrar — `defineApi({ queries })` without `@ultimat3/query`. `meta.kind` names the kind, and the owner is `@ultimat3/<kind>`; importing it is what announces | `bun add @ultimat3/<kind>` |
| `X_REGISTRAR_CONFLICT` | two different registrars are loaded for one primitive kind | two copies of `@ultimat3/<kind>` in the dependency tree, each with its own registry, so half the primitives register where nothing reads them. `bun pm why @ultimat3/<kind>` names the dependents when ranges genuinely disagree | `bun update @ultimat3/<kind>` |

## Images

One pipeline in `@ultimat3/core` serves `storage`, `seo` and `pwa`. It **decodes and encodes PNG and JPEG only**; WebP, AVIF, GIF and SVG are identified and measured — enough to inline `width`/`height` and keep CLS at 0 — but never synthesised. A variant in one of those formats comes from a CDN or an `ImageTransformDriver`, never from a silent passthrough.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_IMAGE_UNSUPPORTED` | the built-in image pipeline cannot read or write this format | a WebP/AVIF source, a request for an AVIF variant, or a colour that is not hex or `transparent` | `transformImageBytes(bytes, { format: 'png' })` (or `'jpeg'`), or pass an `ImageTransformDriver` that produces the format — `meta.format` names the one refused |
| `X_IMAGE_DECODE_FAILED` | image bytes are malformed, truncated or internally inconsistent | a partial upload, a corrupted file, or a header that disagrees with the data that follows | `file <path>` to confirm the type, then re-export the image and retry |
| `X_IMAGE_TOO_LARGE` | image exceeds the pipeline pixel ceiling | a header declaring more than 64 megapixels — usually a decompression bomb, occasionally a real scan | `transformImageBytes(bytes, { width: 4000 })` before it reaches the pipeline, or raise `MAX_IMAGE_PIXELS` deliberately |

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
| `X_SCHEMA_UNSUPPORTED` | the active schema provider cannot do this | a Standard Schema implementation without JSON Schema export | drop the `configureSchemaProvider()` call and use `t`, the shipped dependency-free builtin provider |

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

## Policy and authz

A denial is `X_FORBIDDEN`, above — `@ultimat3/policy` owns it and every surface adapter throws it, so there is one code for "the policy said no" wherever it was decided.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_POLICY_MISSING` | an action was declared without a policy | a new action shipped with no `policy:` | add `policy: can('<resource>:<verb>')`, or `allow('public')` to say so explicitly |
| `X_PERMISSION_UNKNOWN` | permission string is not in the permission set | typo, or a permission never declared | add it to `definePermissions([…])` |
| `X_TENANCY_UNSCOPED` | a tenant-scoped query has no org predicate | a repo call that forgot the tenant | pass `{ orgId }`, or wrap the plan with `orgScoped(entity, orgId, plan)` |
| `X_ACTION_POLICY_MISSING` | an action was registered without a policy | build-time check on the action registry | add `policy: can('<name>')` to the declaration |
| `X_QUERY_POLICY_MISSING` | a query was registered without a policy | same, for reads | add `policy: can('<name>')` to the query |
| `X_QUERY_NOT_PAGEABLE` | a read returned rows with no id, so a cursor cannot name a position | a projection or aggregate that drops the primary key — the id is the tiebreak that makes the sort order total | return the key from the query's `sql:`, e.g. `db.posts.select({ id: true, … })` |

## Auth and sessions

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_SESSION_EXPIRED` | session passed its idle or absolute expiry | `cause` names which of the two clocks ran out | `POST /auth/sign-in { email, password }` for a fresh session, or raise `session.absoluteTtlMs` / `session.idleTtlMs` in `defineAuth` |
| `X_MFA_REQUIRED` | password proven, second factor outstanding | the user has TOTP enrolled | `POST /auth/mfa/verify { code }` with the 6-digit code, then retry |
| `X_OAUTH_STATE_INVALID` | state, nonce or PKCE verifier did not match | a replayed callback URL, a handshake that expired, or a token minted for another browser | restart the flow at `GET /auth/oauth/<provider>` — a callback URL is single-use |
| `X_OAUTH_EXCHANGE_FAILED` | the provider refused the exchange or returned no usable identity | wrong client secret, an unregistered `redirect_uri`, a spent code, or a missing scope | `meta.stage` is `token` or `userinfo`: for `token`, match `<PROVIDER>_CLIENT_SECRET` and the registered `redirect_uri`, then `x doctor --json`; for `userinfo`, restart at `GET /auth/oauth/<provider>` |
| `X_OAUTH_TOKEN_INVALID` | the id token failed its issuer, audience or expiry check | the client id in `.env` is not the one the authorize URL was built with, or this host's clock is skewed | match `<PROVIDER>_CLIENT_ID` to the id `beginOAuth()` used, then restart the flow |
| `X_PASSWORD_WEAK` | strength check rejected the password | too short, or a known-common password | choose a longer, uncommon password — or relax `defineAuth({ password: { minLength } })` |
| `X_ACCOUNT_LOCKED` | per-ip or per-account bucket is inside its lockout | repeated failed attempts | `x auth unlock <key>` — `cause` names the key and the remaining seconds — or raise `defineAuth({ rateLimit })` |
| `X_API_KEY_INVALID` | key unknown, revoked, expired or wrong | one shape for all four — a precise message is an enumeration oracle | `x auth keys list --json`, then issue a fresh key |
| `X_AUTH_WRITE_FAILED` | an adapter write returned no row, so it cannot be confirmed | an `insert … returning *` wrote nothing — the table is missing its migration, or a trigger or RLS policy swallowed the row | `x db apply`, then confirm the table with `x db query "select 1 from x_users limit 1" --json` |

## Entity and database

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_DB_DRIFT` | schema differs from migrations | a column exists in code but in no migration | `x db gen "<describe the change>"` then `x db apply` |
| `X_ENTITY_DUPLICATE` | two entities claim the same name | copy-pasted `entity({ name })` | rename one; `x entities list --json` |
| `X_INVARIANT_VIOLATED` | a domain invariant rejected this row | a CHECK or a declared invariant failed | `x entity explain <entity> --json` to see the invariant and its SQL |
| `X_NOT_FOUND` | no row for that id | stale id, wrong tenant, or already deleted | confirm with `x db query "select id from <table> limit 5" --json` |
| `X_DB_UNAVAILABLE` | cannot reach the database | nothing listening on `DATABASE_URL`, a statement the embedded driver refused, or `@electric-sql/pglite` not installed for a `pglite://` url | set `DATABASE_URL` to a reachable Postgres, or `x dev` for the embedded PGlite — `bun add @electric-sql/pglite` when the url is `pglite://` |
| `X_MIGRATION_CONFLICT` | the migration ledger disagrees with this build | a ledger row from an app version this build does not ship, or an applied migration whose file was edited so its checksum moved | `x db status --json` — then deploy the version `cause` names, or `x db gen "fix <migration>"`. Never edit an applied migration |
| `X_MIGRATION_IRREVERSIBLE` | this migration cannot be reversed without data loss | a generated plan that drops a column or a table | `x db gen "<name>" --allow-destructive`, or keep the column and deprecate it |
| `X_BRANCH_EXISTS` | that branch database already exists | `x db branch create <name>` twice — or a drop aimed at the database this session is connected to | `x db branch drop <name>`, then re-create, or pick another name. To drop the connected one, reconnect elsewhere first: `DATABASE_URL=.../postgres` |
| `X_SQL_UNSAFE` | SQL was built by string interpolation | a non-scalar interpolated into a `sql` template, or an identifier or branch name that is not `[a-z0-9_-]+` | pass a scalar (it becomes `$n`), a nested `sql` fragment, or wrap audited SQL in `raw()` — `cause` numbers the interpolation |
| `X_READONLY_VIOLATION` | a mutating statement reached a read-only client | an INSERT/UPDATE/DELETE sent through `readOnly(db())` | use `db()` instead of `readOnly(db())`, or rewrite the statement as a SELECT |
| `X_DB_GEN_FAILED` / `X_DB_MIGRATE_FAILED` / `X_DB_BRANCH_FAILED` / `X_DB_STUDIO_FAILED` | the underlying `x db` step failed | Postgres rejected the statement, or the DB is unreachable | read `cause` — it carries the SQL error verbatim |

## Actions

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_ACTION_DUPLICATE` | two actions registered under one name | duplicate export names across features | rename one; names are global. `x actions list --json` |
| `X_INPUT_INVALID` | input failed the action's schema | wrong shape from a client or an agent | `x actions describe <name> --json` |
| `X_OUTPUT_INVALID` | the handler returned a value its `output` schema rejects | the handler drifted from the declared output | `x actions describe <name> --json`, then fix the handler or the schema |
| `X_ACTION_FOREIGN` | a value that is not an action was projected as one | a hand-rolled object with `kind: 'action'`, or an action from a duplicated copy of `@ultimat3/action` | declare it as `export const name = action({ input, output, policy, handle })` |
| `X_ACTION_UNREGISTERED` | an action was projected before it was registered, so it has no name | `.tool()` / `.client()` / `.job()` / `.openapi()` on an action `registerActions()` never named | `registerActions(await import('./actions'))` at boot, before mounting routes |
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

## Jobs

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_IDEMPOTENCY_REQUIRED` | the job has no `idempotencyKey` | the field was omitted — normally a compile error, checked again at registration | add `idempotencyKey: (input) => '<stable>:' + input.id` |
| `X_JOB_DUPLICATE` | a name or a live key already has a job | a second enqueue inside the dedupe window, or a second job/task registered under a name already taken | pass `onConflict: 'dedupe'` or make the key narrower; for a name clash, rename one export |
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
| `X_TRANSPORT_PROTOCOL` | the bus does not speak the protocol this build speaks | nats-server older than 2.11, JetStream not enabled, or something that is not NATS on the port | run `nats:2.11-alpine` or newer with `-js`; reconnecting cannot fix it, so this never retries |
| `X_REPLICATION_FAILED` | the replication connection was refused | `wal_level` not `logical`, no publication, a slot another replicator holds, wrong credentials | the message names the object; the fix is the exact `ALTER SYSTEM` / `CREATE PUBLICATION` / `pg_drop_replication_slot` statement |
| `X_REPLICATION_PROTOCOL` | the WAL stream cannot be decoded | a server or `pgoutput` version this build does not speak, or a proxy on the replication port | `x doctor db` — point the URL at postgres itself, on a server ≥ 14 |
| `X_LIVE_CLIENT_MISSING` | a realtime hook ran with no `LiveClient` registered | `useLive` / `useConnection` / `useMutation` / `useMutationQueue` on a page whose entry never registered one | `setLiveClient(new LiveClient({ signal: createSignal, connect, buildId }))` in the app entry, above the first render |

## Cache

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_CACHE_TAG_UNKNOWN` | a tag no entity declared | typo in `invalidates: [tag.pots]` | `x manifest` to regenerate the tag graph, then fix the tag |
| `X_CACHE_TOO_LARGE` | one entry exceeds the tier's byte budget | caching a whole row set | raise `cache.<tier>.maxBytes`, or cache a projection |
| `X_CACHE_DRIVER_UNAVAILABLE` | a tier's backing store is missing | no Redis binding, no CDN token | provision the tier, or drop it from `app.config.ts` |

## Storage

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_STORAGE_CHECKSUM_MISMATCH` | bytes do not match the declared checksum | a truncated upload, or a sha256 computed over different bytes than the ones sent | recompute the checksum over the exact bytes you send, or omit it and let the driver hash |
| `X_STORAGE_DISK_UNKNOWN` | no disk with that name is configured | `disk('<name>')` for a disk `storage.disks` never declared | add `"<name>"` to `storage.disks` in `app.config.ts`, or call one of the names `cause` lists |
| `X_STORAGE_NOT_FOUND` | no object at that key | a stale key, the wrong disk, or an object already deleted | list the prefix and compare: `await disk('<disk>').list({ prefix: '<dir>' })` |
| `X_STORAGE_PATH_UNSAFE` | object key escapes its prefix | an absolute key, a `..` segment, or a backslash | build the key with `scopedKey(orgId, ...parts)` — relative, forward slashes, no `..` |
| `X_STORAGE_TOO_LARGE` | payload exceeds the upload size limit | a file over the policy's `maxBytes`; `cause` carries both numbers | `uploadPolicy({ maxBytes: <bytes> })` for a higher limit, or compress the file first |
| `X_STORAGE_TYPE_REJECTED` | content type is not allowed for this upload | a type absent from `allowedContentTypes`, or magic bytes that disagree with the declared `Content-Type` — the bytes win | add the declared type to `allowedContentTypes` in the upload policy, or re-upload with the `Content-Type` `cause` sniffed |

## Routes, render and budgets

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_ROUTE_MODE_INVALID` | render mode not allowed on this surface | `stream` on a `site/` route | use `static`, `isr` or `ssr` in `site/`; `stream`, `spa` or `ssr` in `app/` |
| `X_ROUTE_OFFLINE_MISSING` | the route's offline strategy is missing or contradictory | `precache` on an `ssr` route | set a compatible `offline`, or change the render mode |
| `X_ROUTE_META_MISSING` | required metadata missing | no `meta.title`, or no `description` on a `site/` route | add it to `meta` in the route file |
| `X_ROUTE_UNNORMALIZED` | a route was registered without `defineRoute` | `registerRoute({ config })` was handed the author's own object, so `meta` and `budget` were never normalized and every descriptor reader would read them wrong | wrap it: `registerRoute({ file, config: defineRoute({ … }) })` |
| `X_ROUTE_DUPLICATE` | two route files resolve to one URL | a copied page directory | delete or rename one |
| `X_ROUTE_FILE_INVALID` | a route file is not named for its surface | `site/pricing.tsx` or `site/blog/index.tsx` instead of `<dir>/page.tsx` | `mkdir -p <dir> && git mv <file> <dir>/page.tsx` — `route.ts` under `api/` |
| `X_SURFACE_BOUNDARY` | a surface imported across the hard boundary | `site/` reached `app/`, transitively | `x fix boundary <file>`, or move the shared module out of `shared/ui` |
| `X_BOUNDARY_SITE_TO_APP` | `site/` imported `app/` | the classic transitive import | the chain is printed in `cause`; break it at the named hop |
| `X_BOUNDARY_APP_TO_API` | `app/` imported `api/` at runtime | a value import instead of `import type` | use `import type`, and call the typed client |
| `X_BOUNDARY_ROUTE_TO_DB` | a route touched the database | SQL in a page file | move it into `repo.ts` and call a query |
| `X_BOUNDARY_SERVICE_TO_HTTP` | a service imported HTTP | request awareness inside business logic | take the values as arguments so a job can reuse the service |
| `X_BOUNDARY_SHARED_LEAF` | `shared/` imported a surface | `shared/` is a leaf | invert the dependency |
| `X_ADMIN_FLATTENER_VIOLATION` | a production `@ultimat3/admin` file read `$meta` or called `$describe()` directly | a new admin module reached past `entity-columns.ts` for column facts | take `AdminColumnFacts` from `entity-columns.ts` instead |
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
| `X_SEO_BUDGET_EXCEEDED` | route exceeded its performance budget | a `js`/`css`/`lcp`/`cls`/`inp` budget broken in the SEO report | `x routes --json` for the route's budget, then cut the regression `cause` names |
| `X_SITEMAP_TOO_LARGE` | sitemap exceeds the 50,000-entry limit | too many prerendered URLs in one file | enable sitemap index splitting in `app.config.ts` |

## PWA and build skew

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_PWA_NO_OFFLINE_FALLBACK` | `pwa.offline.fallback` is not set | the required field was removed | set `pwa: { offline: { fallback: '/offline' } }` |
| `X_PWA_ICON_MISSING` | no source icon to generate from | the configured icon path does not exist | add an SVG or >=1024px PNG and point `pwa.icon` at it |
| `X_PWA_MANIFEST_INVALID` | the generated web manifest failed validation | a bad `start_url` or `scope` | fix the `pwa` block; `cause` names the field |
| `X_SW_SCOPE_INVALID` | the service-worker scope cannot serve the routes it precaches | a scope narrower than the app | serve `sw.js` from the app root |
| `X_BUILD_ID_MISSING` | no immutable build ID | a build produced outside `x build` | build with `x build`; never use a timestamp or `latest` |

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
| `X_SCHEDULE_INVALID` | a wall-clock field is out of range | `hour: 24` or `minute: -1` in a schedule spec — `cause` names the field and its range | pass an integer inside the range `cause` prints; wall-clock fields are never wrapped or clamped, because a silently shifted schedule is worse than a failed one |
| `X_DST_AMBIGUOUS` | the local time occurs twice | a fall-back overlap | pass `{ overlap: 'first' }` or `{ overlap: 'second' }` |
| `X_DST_NONEXISTENT` | the local time does not exist | a spring-forward gap | pass `{ gap: 'next' }` or `{ gap: 'previous' }` |
| `X_LOCALE_INVALID` | not a well-formed BCP 47 tag | `en_US`, `''`, or a raw `Accept-Language` value reaching `describeCron` | pass `en`, `en-GB`, `de-DE` — screen header input with `Intl.DateTimeFormat.supportedLocalesOf([tag])` |

## Mail

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_MAIL_LOCALE_MISSING` | `send()` was called without a locale | a JS caller, or a cast that dropped the required field | `send(mail, data, { to, locale: ctx.locale })` |
| `X_MAIL_TEMPLATE_UNKNOWN` | no mail is registered under that id | the module holding `defineMail({ id })` was never imported (also raised for an unregistered layout) | export the `defineMail` and import it at boot |
| `X_MAIL_DUPLICATE` | two mails claim the same id | a copy-pasted `defineMail` | rename one of the two declarations |
| `X_MAIL_TEXT_MISSING` | the rendered mail has no plain-text part | a template of images and buttons only | add a text-bearing block: `blocks.paragraph('mail.<id>.body')` |
| `X_MAIL_DRIVER_UNAVAILABLE` | no mail driver is configured | `setMailDriver` was never called | `setMailDriver(createMemoryDriver())` in dev, `createSmtpDriver({ url: env.SMTP_URL })` live |
| `X_MAIL_HEADER_INVALID` | a header value carries a line break | interpolated data with a CR/LF reached `Subject` — header injection | reject the value at its own boundary — `t.string().pattern(/^[^\r\n]*$/)` on the field that feeds the header — then re-send. Never strip the break: a silently rewritten header hides the injection attempt |
| `X_MAIL_SEND_FAILED` | the mail transport refused the message | a rejected recipient, bad credentials, a throttle, a dead socket, or a peer that never completes a reply | `meta.retryable === true` → requeue with `sendMailJob`; `false` → fix what `meta.stage` names, then `x doctor --json`. `meta.stage` is the `SendStage` union in `packages/mail/src/errors.ts`: `auth` → `SMTP_URL` credentials, `tls` → `openssl s_client -connect <host>:465` for the implicit-TLS certificate, `starttls` → `openssl s_client -starttls smtp -connect <host>:587`, `recipient` → the address, `reply` → point `SMTP_URL` at the SMTP port itself, since a proxy or an HTTP port answers like this |

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
| `X_AI_REQUEST_INVALID` | the provider would reject this request | a reasoning control the chosen model does not have — `effort` or adaptive `thinking` on a pre-4.6 model, or `thinking: 'disabled'` above a model's effort cap | set `model:` on the `llm()` declaration to one whose `MODELS` row has the control, or drop `effort`/`thinking` from `definePrompt` — editing the template alone leaves the control in the request |
| `X_LLM_OUTPUT_INVALID` | structured output failed its schema on the answer and on the repair turn | the model would not produce the shape | describe the shape in the prompt template and bump its version, or widen `output` in the `llm()` declaration |
| `X_LLM_REFUSED` | the model declined the request | the provider's safety classifiers refused; `stopDetails.category` names why | set `model:` on the `llm()` declaration to another blessed model (the thrown `fix:` names one), or edit the template in `definePrompt` and bump its version |
| `X_LLM_TRUNCATED` | the answer hit its `maxTokens` ceiling before it was complete | the ceiling is below what the output schema asks for | set `maxTokens:` on the `llm()` declaration to double the ceiling the `fix:` names, or drop fields from its `output` schema |
| `X_EVAL_THRESHOLD` | an eval scored below its tolerance | a prompt edit regressed cases against the recorded baseline | `x test <eval>` for per-case scores; `ULTIMATE_EVAL_RECORD=1 x test eval` to accept new numbers as a reviewed diff |
| `X_EVAL_BASELINE_MISSING` | an eval has no recorded baseline to gate against | a new eval, or a `baseline:` that is not `import.meta.resolve('./…')` | `ULTIMATE_EVAL_RECORD=1 x test eval`, then commit the baseline file |
| `X_EVAL_BASELINE_INVALID` | a recorded baseline cannot be read | a hand-edited or half-merged baseline file | `ULTIMATE_EVAL_RECORD=1 x test eval` to re-record it |
| `X_EVAL_MISSING` | a prompt has no eval | a `definePrompt` with no `defineEval` naming it | add `defineEval({ prompt, cases, scorers, tolerance, baseline })` beside the prompt |
| `X_EVAL_RECORDING` | the gate ran with baseline recording switched on | `ULTIMATE_EVAL_RECORD` was exported in the shell, or set on the CI job, that ran `x verify` | `env -u ULTIMATE_EVAL_RECORD x verify` — record with `ULTIMATE_EVAL_RECORD=1 x test eval` instead |
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
| `X_ADMIN_INVALID` | an admin tool's arguments failed the resource schema | the agent built a row from a stale tool schema | `x manifest`, then re-read the tool's JSON Schema from `tools/list` |
| `X_DEV_DASHBOARD_IN_PROD` | `/_x` was mounted outside dev | the dev dashboard shipped in the image | delete the `/_x` mount from the production entrypoint |
| `X_MANIFEST_DRIFT` | a committed manifest differs from the code | a primitive changed without regenerating, or the file was hand-edited so its `buildId` no longer hashes its own contents | `x manifest` — `bun run manifest` for this repo's own `framework.manifest.json` |
| `X_MANIFEST_STALE` | `openapi.json` is stale | the committed spec does not match the actions the code registers | `x manifest`, then commit |
| `X_MANIFEST_BREAKING` | a published contract was removed or narrowed | a breaking change with no version bump | bump the major version, or restore the contract |
| `X_AGENTS_MD_MISSING` | no `AGENTS.md` | the human-authored file was deleted | write it by hand — short: stack, commands, conventions |
| `X_AGENTS_MD_TOO_LARGE` | `AGENTS.md` grew past its cap | generated facts pasted into it | move facts into `x.manifest.json`; keep conventions only |

## Testing

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_TEST_DB_UNAVAILABLE` | no Postgres for the test template | nothing listening | run `x dev` (embedded Postgres), or set `TEST_DATABASE_URL` |
| `X_TEST_FIXTURE_UNAVAILABLE` | a declared fixture has no driver in this process | destructuring `page`, `budget`, `signIn`, `deploy` or `subscribe` with no browser or replicator installed | `defineFixtures({ <name>: () => yourDriver() })` in the test preload — `cause` names what the fixture needs |
| `X_TEST_FIXTURE_UNKNOWN` | a test requested a fixture nobody registered | a destructured fixture name no `defineFixtures` call declares | `defineFixtures({ <name>: () => buildIt() })` at test setup — `cause` lists the registered names |
| `X_TEST_NETWORK_OFFLINE` | the test network is offline | a request made after `network.offline()` or `network.drop()` | `network.online()` before the call — or assert the offline path instead of the request |
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
| `X_TEST_NO_FILES` | the test selection matched no files | a type or `--filter` that matches nothing, or `x test` run outside the app | drop the filter (`x test`), or point it at the right root: `x test --cwd <repo root>`. A green run over zero files is the most expensive false pass |
| `X_TEST_SHARD_FAILED` | a test shard exited non-zero | a red test inside one worker of a sharded run | the `fix` replays that shard alone, carrying the whole selection that produced it: `x test <type> [--filter <text>] [--sample <n>] --workers <n> --worker <i>`. Dropping `--sample` would reshard a different corpus, so the fix keeps it |
| `X_FILE_TOO_LONG` | a source file is over 500 lines | one file doing several jobs | split it; the `fix` names the file |
| `X_PACKAGE_SHAPE` | a workspace package is missing a contract file | a package added by hand | `bun run scripts/new-package.ts <pkg> --only <file>` |
| `X_ERROR_FIX_INVALID` | an error's fix line is not a runnable instruction | the `errors` step read a `fix:` that is empty, or one that advises (`check`, `make sure`, `try`, `see the docs`) with no command, call or file path in it | the `fix` names the offending `<file>:<line>` — rewrite that `fix:` as a runnable command, a call, or an edit naming a file |
| `X_ERROR_CODE_UNDOCUMENTED` | a shipped error code has no row in the error reference | a package declared an `X_*` code and the same pull request never added its row | add a row for the code to `wiki/Error-Codes.md` — this page |
| `X_ERROR_CODE_UNREGISTERED` | the error reference documents a code no package registers | a row written for a code that was renamed, never built, or emitted as a `Finding` without a `registerErrorCodes()` call | register it in the owning package's `src/errors.ts`, or move its row under [Reserved codes](#reserved-codes) |
| `X_APP_PACKAGE_INVALID` | the app's `package.json` has no usable `name`/`version` — the manifest never fabricates `app@0.0.0`, because its version is the compatibility gate | a malformed or hand-trimmed `package.json` | `bun pm pkg set name=<app> version=0.1.0` |
| `X_BUILD_FAILED` | `x build` failed | a static check or the bundler | read `cause`; the failing step is named |
| `X_DEPLOY_FAILED` | a deploy step failed | the compose/helm command exited non-zero | run the printed command directly for full output |
| `X_SETUP_INSTALL_FAILED` | `bun install` failed during `bin/setup` | a conflicted lockfile, or a half-written `node_modules` | `rm -rf node_modules bun.lock && bun install` |
| `X_RELEASE_VERSION_SKEW` | a workspace is not at the lockstep version | a package bumped on its own, or a release that stopped half-way | `bun run scripts/release.ts --bump patch --dry-run --json` to see the realignment, then run it without `--dry-run` and review the `package.json` diff |
| `X_GENERATE_CONFLICT` | a generator would overwrite a file | the name is taken | `x g … --force`, or choose another name |
| `X_GENERATE_JSON_INVALID` | a generator's own `merge: 'json'` output does not parse as a JSON object | a bug in the template that produced it — never a file already on disk, which `X_GENERATE_CONFLICT` covers | fix the template that emits it, then `bun test packages/cli/src/cmd-generate.test.ts` |
| `X_SCAFFOLD_PATH_ESCAPE` | a generated path resolves outside the scaffold sandbox | a `..` segment or an absolute path in a template's `GeneratedFile.path` | make the path relative to the app root with no `..`, then `bun test packages/cli/src/scaffold-typecheck.contract.test.ts` |
| `X_NOT_IMPLEMENTED` | a planned command, or a driver whose remote half is unwritten | one of the commands in [CLI reference](CLI-Reference)'s planned table | the `fix` names the closest shipped command — never "not a command", which would send you looking for a typo |
| `X_ERROR_CODE_UNKNOWN` | no package registered this error code | a typo, or a code from a package this process could not import | `x errors list --json` — the nearest real code is in `fix`, and `data.unavailable` names any package that would not load |
| `X_DECLARATION_UNKNOWN` | no declaration with this name is registered | a typo, or a module that never imported | `x actions list --json` (or `queries` / `entities`); the nearest real name is in `fix` |
| `X_JOB_UNKNOWN` | the queue holds no job with this id | a stale id, or a job already reaped | `x jobs ls --json` |
| `X_FIX_TARGET_UNKNOWN` | the named file is not one of the app's source files | a path outside `apps/*/{site,app,api,shared}`, or a typo | `x fix boundary <nearest real path>` — `fix` carries it |
| `X_ROADMAP_FILE_MISSING` | `docs/idea/14-roadmap.md` does not exist, so no status or artifact can be checked | the roadmap was deleted or moved — every other roadmap rule would otherwise pass silently | `git checkout -- docs/idea/14-roadmap.md` |
| `X_ROADMAP_STATUS_MISSING` | a milestone has no row, or its row's status cell holds neither ✅ nor 🚧 | `docs/idea/14-roadmap.md` edited without keeping the marker | put ✅ or 🚧 in the second cell of the row `fix` names, then `bun run scripts/roadmap.ts --json` |
| `X_ROADMAP_MILESTONE_UNVERIFIED` | a milestone the table marks ✅ is missing a package or file its own **Ships** column names | the artifact was deleted or renamed after the milestone was marked shipped | `git checkout -- <the paths in `fix`>`, or put 🚧 in that row's status cell |
| `X_REFERENCE_APP_REGRESSED` | a step of `examples/dummy`'s own gate that was passing now fails — or the gate produced no step table at all | a framework change broke the reference app, and the step is not one of the pinned entries in `EXPECTED_RED` | `cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify` |
| `X_REFERENCE_APP_PIN_STALE` | a step pinned as failing in `EXPECTED_RED` now passes | the app was repaired and the pin was not lowered — the ratchet only shrinks | delete the named entries from `EXPECTED_RED` in `scripts/reference-app-gate.ts` |
| `X_REFERENCE_APP_UNREFERENCED` | `examples/dummy` typechecks but the root `tsconfig.json` does not reference it | the app came off the `typecheck` pin without joining the root `tsc -b` solution, so the packages' emitted `.d.ts` are never proved consumable | add `{ "path": "./examples/dummy" }` to the `references` array in `tsconfig.json` |

## Reserved codes

Everything above this heading is live: `x errors explain <CODE>` answers for it today, and the `errors` step fails the build if it does not (`X_ERROR_CODE_UNREGISTERED`). Everything below is documented for a different reason and is deliberately outside that rule.

### Not thrown yet

Reserved, not registered. The name is spoken for — the design docs use it and no future code may reuse it — but nothing raises it in this build, so `x errors explain` refuses it. The right-hand column is what actually happens today.

| Reserved code | What happens today |
|---|---|
| `X_TIMEOUT` | no deadline is enforced per request. A cancelled request is `X_ABORTED`; a job past its deadline is `X_JOB_TIMEOUT`. `@ultimat3/http` already maps the code to 504 for the build that raises it |
| `X_MIGRATE_CONCURRENT` | `ROLE=migrate` takes no advisory lock, so two overlapping deploys both migrate. Serialise them in the deploy pipeline until this ships — roadmap milestone 11 |
| `X_SW_HAND_EDITED` | `sw.js` carries no checksum, so a hand edit survives `x build` and is silently overwritten on the next one |
| `X_SW_UNCACHEABLE` | an `offline` strategy contradicting the route's `render` mode is accepted; `X_SW_SCOPE_INVALID` covers only the scope half |
| `X_CACHE_UNTAGGED_QUERY` | a query no tag covers is cached and never invalidated. `X_CACHE_TAG_UNKNOWN` catches the opposite mistake — a tag no entity declared |

### Names used in the design docs

Some design docs predate the implementation. `As of 2026-08` these are the mappings; the right-hand column is what the framework actually throws. The old name stays here because a code never changes meaning — a renamed concept gets a new code and the old one keeps its row.

| Design doc name | Implemented code |
|---|---|
| `X_JOB_NO_IDEMPOTENCY_KEY` | `X_IDEMPOTENCY_REQUIRED` |
| `X_JOB_DUPLICATE_STEP` | `X_STEP_DUPLICATE` |
| `X_JOB_STEP_FAILED` | `X_JOB_MAX_ATTEMPTS` (retries exhausted) or `X_JOB_TIMEOUT` |
| `X_SEO_NO_TITLE` / `X_SEO_NO_DESCRIPTION` | `X_SEO_META_MISSING` |
| `X_BUDGET_EXCEEDED` thrown by `@ultimat3/seo` | `X_SEO_BUDGET_EXCEEDED` — `X_BUDGET_EXCEEDED` is `@ultimat3/render`'s, and one code is owned by exactly one package |
| `X_POLICY_DENIED` | `X_FORBIDDEN`, wherever in the stack the policy decided |
| `X_PWA_NO_ICON_SOURCE` / `X_PWA_NO_FALLBACK` | `X_PWA_ICON_MISSING` / `X_PWA_NO_OFFLINE_FALLBACK` — `x doctor` reports the package's own codes, never a CLI twin of them |
| `X_BOUNDARY_VIOLATION` | `X_BOUNDARY_SITE_TO_APP` and the other `X_BOUNDARY_*` codes. The bare name is still this repo's own tier-table finding, above |
| `X_TEST_NETWORK_EGRESS` | `X_TEST_NETWORK_SEALED` |
| `X_LIVE_QUERY_LIMIT` | `X_SUBSCRIPTION_LIMIT` |
| `X_ENV_INVALID` | `X_ENV_MISSING` |

New codes are added in the owning package's `src/errors.ts` and registered through `registerErrorCodes()`; add the row here in the same pull request, or the `errors` step of `x verify` fails the build with `X_ERROR_CODE_UNDOCUMENTED` — see [Contributing](Contributing).
