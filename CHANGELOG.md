# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Pin `@ultimat3/*` exactly; a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers.

## [Unreleased]

### Fixed

- **`docker-compose.prod.yml` no longer publishes a host port and asks for three binders of it.**
  `web` shipped `ports: ['3000:3000']` beside `deploy: { replicas: 3 }` and `sync` had the same
  shape — one host port has exactly one binder, so the second container dies on
  `Bind for 0.0.0.0:3000 failed: port is already allocated`, reproduced with Docker rather than
  reasoned about. Both roles are `replicas: 1` in all four files now: the framework's, both tracked
  apps', and the one `x new` writes. That makes the rung-1 ceiling **declared** rather than
  discovered at the second container — it is not lifted, and each file's header names the two ways
  up: delete the `ports:` lines and put your own reverse proxy on the compose network, or climb to
  `docker/helm`, which already carries a per-role HPA and an Ingress. The framework ships neither
  proxy; one in the compose file is a dependency every app inherits and a second answer to "how
  does traffic reach a role" beside the chart's Ingress. `docs/ops/README.md` carries the table.

- **`sync`'s `PORT` named a port the process never opens, in compose and in the chart.** The role
  binds `PORT + 1`, so `PORT: 3001` opened 3002 while the compose file published 3001 — a mapping
  to a socket nothing in the container ever bound. Compose now sets `PORT: 3000` and publishes
  `3001:3001`. The chart had the worse half of the same defect: `roles.sync.port` was rendered into
  **both** `PORT` and `containerPort`, so the readiness probe polled a socket nobody bound and the
  rollout never completed. `_helpers.tpl` derives the env as `port - 1` for that one role, so
  `values.yaml` still holds one number — the port the role listens on — and the two cannot drift.

- **The chart's Ingress routed `/_sync`; the sync node serves `/_x/sync`.** Every websocket fell
  through to the `/` rule and reached `web`, which answers no upgrade. The path is now the one
  `createSyncNode` matches on.

- **A typed client is not a thenable.** `rpc` and `queryClient` are `Proxy` objects that answer any string property with a call method, `then` included — so `await client`, `Promise.resolve(client)` and returning one from an `async` function each read `then`, got a function back, and were resolved by calling it: a POST to an action named `then`, or a GET of `/_x/query/then`, with the await settling on that response instead of the client. Both proxies now answer `undefined` for `then` — the one name the language reserves at this seam — and both test files pin `await client === client` with a fetch that counts its calls. The symbol assertion that stood there covered `Symbol.toPrimitive` and `Symbol.iterator` and could not have caught a plain string key.

- **The digest's window is calendar arithmetic at both ends, and its slots come from the occurrence.** Two defects in `examples/dummy`'s nightly digest, both of them a day of milliseconds standing in for a day. The delivery loaded `slotAt - 86_400_000`, while consecutive 09:00 slots are 23 hours apart on spring-forward and 25 on autumn-back: in Madrid on 2026-03-29 the window opened an hour *before* the previous digest closed and mailed that hour's posts twice, and an autumn transition left an hour that reached no digest at all. It now opens at `previousDigestAt(slotAt, zone)` — new in `@postly/core`, the mirror of `nextDigestAt` and the same `fromZoned` arithmetic — and the `postly.digestPreview` MCP tool, which promises "the same window", was computing the old one. The fan-out's slots were derived from `ctx.now()`, which runs on every attempt while only the enqueues already stored replay: an attempt taken after a zone's 09:00 had passed rolled that zone into tomorrow, so groups the first attempt had not reached were enqueued as a *different* digest — a next-day `slotAt` and `localDate` under a step name carrying no date to catch it. The base is now midnight UTC of `input.runDate`, the occurrence the task fired for, identical on every attempt.

- **Four call sites in the reference app that a review found before a user did.** `signedAvatarUrl` read one page of `disk().list()` and picked the newest key in it — S3 truncates at 1000 — so a member who re-uploaded past a page boundary kept rendering whichever avatar landed on page one; it now follows the cursor to the end, folding a page at a time rather than collecting every key to choose one. `toggleDigestOptIn`'s `custom()` resolver returned the whole optimistic row whenever the server was opted in, reverting a theme, a locale or a role changed on another device while the toggle sat in the offline queue; it now starts from the server row and resolves the one field it is about. `app/feed/page.tsx` fetched `feedActivity` inside an `async` component wrapped in a `<Suspense>` shim that ignored its `fallback` — nothing splits a page into holes yet, so the shell waited for the count anyway and the skeleton never rendered; the read moved to the route's `load()`, where every other read in the app lives, and the shim is deleted rather than left as a boundary that boundaries nothing. And because a query declares no output schema, a `Date` column arrives from the client as the ISO string `JSON.stringify` wrote: `site/blog/[slug]/page.tsx` called `.toISOString()` on it while rendering JSON-LD. The blog routes and the post page rehydrate at their loader through `shared/wire.ts`; the client's own header and the wiki now say what the wire hands back.

- **The reference app's pages pass the inputs their reads require and render the rows they were given.** Four call-site classes in `examples/dummy`, all of them the app calling a real API wrongly rather than the API being wrong. **Missing required input:** `app/posts/[id]/page.tsx` read `postById({ postId })` without the `orgId` `postRead` decides on — the org now comes off the actor, because `/posts/{id}` carries no tenant and a foreign id must read as absent; `app/feed/page.tsx` rendered `<LikeButton>` with no `orgId`, which `postLike` needs in the mutator's input so an offline queue replayed hours later still reaches the rule. **Wrong row shape:** the blog index fed `{ slug, updatedAt }` rows to `toCardPost`, which needs a title, an excerpt and a byline — there is now a `publicPosts` read behind it, `publicPostSlugs` going back to being only what its name says, the prerender enumeration; and `site/blog/[slug]/page.tsx` read `updatedAt` off a `PostView` that excludes it, so the JSON-LD's `dateModified` is gone (`ld.Article` defaults it to `datePublished`) and `datePublished` is an ISO string rather than a `Date`. **UUID in a name slot:** `app/posts/mail.ts` and `app/digest/mail.ts` interpolated `member.orgId` into `{org}` — a UUID where the reader expects their organisation's name — so both payloads now carry the org's name, top-level, which is the only level `renderMail` interpolates a subject from. **Hardcoded strings:** `'Postly'` in two JSON-LD nodes and two breadcrumbs is `t('common.appName')`, and `priceCurrency: 'USD'` on the landing and pricing pages is resolved from the URL by one shared rule both `meta` and the page body read, so structured data cannot quote a currency the visitor was never shown. Alongside them, in the same expressions: `ld` takes an array, `canonical` is its own key and not a field on `alternates`, `robots` is a `RobotsDirectives` object and not the string `'noindex'`, `ld.SoftwareApplication` requires `operatingSystem`, `ld.Product` takes one offer (so a pricing page with three plans emits three products), an offer's `price` is a decimal string, and `defineRoute` has no `feed:` key — the blog index declared three feed formats and emitted none. The app's typecheck baseline drops from 184 errors to 165.

- **The reference app's posts repository runs on the entity API that exists.** `examples/dummy`'s `apps/web/app/posts/repo.ts` was written against `.join()`, `.with()`, `.returning()`, `.onConflictDoNothing()` and `.returningInserted()` — five builder methods `@ultimat3/entity`'s `Table`/`ReadBuilder` has never had — so every function in it threw at the builder before a driver ever saw a statement, and the file carried 18 of the app's typecheck errors. Rewritten on the real surface: `authorName` is `preload('author')`, one extra `where id in (…)` for a whole page rather than a join that does not exist; an idempotent like is `upsertAll([row], { onConflict: ['postId', 'memberId'], onMatch: 'nothing' })`, whose empty result IS "that like was already there"; an unlike is `deleteWhere`, the only write path a composite primary key has; the recount is `count()` + `update(id, patch, { orgId })`; and the feed's projection is `select()`. `andWhere('publishedAt', '>=', since)` named an operator that does not exist and is now `'gte'`. `publishPost`'s policy row loader is scoped to the org its own input names instead of reading `posts` unscoped — `postPublish` denies a null row exactly as it denies a row from another org, so the scope decides nothing the rule did not already decide, and `X_TENANCY_UNSCOPED` no longer refuses the read before the guard runs. The app's typecheck baseline drops from 202 errors to 184 and five pinned-red tests turn green, `contract · every post action passes the contract an action owes` among them. One gap is left in the file, and it is now the only one: the public blog resolves `/blog/{slug}` with no tenant anywhere in the URL — which is why `post_slug_unique` is global — so `publishedBySlug` and `publishedSlugs` read a tenant-columned entity with no org predicate, and a deliberately cross-tenant read has no escape hatch.

- **One SQL scanner under the splitter, the read-only guards and the destructive rail.** `stripSqlNoise()` blanked spans by a sequence of replacements, comments first — so the `--` in `select '--'; delete from posts` read as a line comment and the `delete` was erased before `inspectStatement()` ever saw it, letting a mutating fragment through `readOnly(client, { seal: false })`. It now walks the same left-to-right lexer `statementsOf()` uses (new internal `sql-scan.ts`), where a `--` inside a literal is data because the literal is scanned first. Two more from the same lexer: a `$tag$` immediately after an identifier is no longer read as a dollar-quote opener — `$` is legal in a name after the first character, so `select foo$tag$; select 2;` is two statements and used to go out as one send — and `hasDestructiveMarker()` now finds `-- destructive: true` only as a **top-level line comment**, never inside a `/* … */` or a dollar-quoted body where a regex over the raw file matched it and bought an unmarked destructive migration past `x verify`.

- **A migration snapshot is the newest migration's, or there is none.** `declaredSchema()` returned the newest snapshot it could find, so a later migration written without one silently answered with an obsolete schema: `0001` records `posts`, `0002` adds a column by hand, and drift reported the column the database correctly holds as `unexpected-column`, fixed by generating a migration that already exists. It now returns `SchemaDescription | undefined` — the newest migration's snapshot, or nothing. `checkDrift()` reports that as an `unknown-schema` difference instead of `ok: true`, and `x db gen` refuses with the new `X_MIGRATION_SNAPSHOT_MISSING` rather than diffing against the empty schema, which would have emitted `create table` for every table the database already holds.

- **A generated index keeps its predicate and its direction, and a changed one is rebuilt.** The migration snapshot recorded an index's name, columns and uniqueness and dropped `where` and `order`, while the diff treated a matching *name* as a matching definition — so narrowing an index to a predicate or reversing it to `desc` generated an empty migration and the database kept serving the old one. The snapshot now carries all five fields and `x db gen` emits `drop index` + `create index` for any of them moving, since Postgres has no `alter index` for a column list, a uniqueness, a predicate or a direction.

- **`introspect()` reads a composite foreign key as one ordered pairing, not a cross product.** The catalog query matched `conkey` and `confkey` independently — `sa.attnum = any(c.conkey)`, `ta.attnum = any(c.confkey)` — so a two-column key joined four ways and `array_agg` emitted four source columns against four referenced ones, duplicated and misaligned. `compareForeignKeys` then read a correct database as `missing-foreign-key`, and the admin schema view and the MCP `schema.describe` tool both showed a key that does not exist. Both arrays are now unnested together (`unnest(c.conkey, c.confkey) with ordinality`) and ordered by that shared key position, so `references t (y, x)` no longer describes itself as `references t (x, y)`. Only a real engine can tell the two queries apart; the new `introspect-embedded.test.ts` boots PGlite and asserts the pair comes back whole.

- **`introspect()` reads an index's columns in index key order.** They were ordered by `attnum`, so a composite index on `(created_at, org_id)` whose columns were declared the other way round in the table came back reversed — a description that reads correct and compares wrong. It now orders by `indkey`, drops `INCLUDE` payload columns, and carries the index's predicate and direction alongside.

- **Drift compares the indexes migrations declare, not columns alone.** `compareTable` read column names only, so a dropped index or a composite index rebuilt with its columns transposed answered `ok: true`. It now reports `missing-index` and `changed-index` for indexes a snapshot names. A live index no migration declares is deliberately not reported — Postgres creates one per primary key and per unique constraint — and the predicate and direction are not compared, because the catalog returns its own rewriting of an expression and a text comparison would call two identical indexes drift. Named in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **Drift compares the foreign keys migrations declare.** `snapshotOf()` recorded `foreignKeys: []` beside an `up` that emitted `references "orgs" ("id")` — a snapshot denying a constraint its own migration creates — so `compareTable` had nothing to compare and `alter table "posts" drop constraint "posts_org_id_fkey"` on the database answered `ok: true`. A snapshot now records every key its `references()` columns write, and one the catalog does not hold is `missing-foreign-key`. Matched on **where the key points** and never on its name, because Postgres names an inline clause `posts_org_id_fkey` and a hand-written migration may have said `constraint fk_posts_org` — the same key under another name is the same key. `on delete` is not compared: the catalog spells it as one character and no generated clause declares one. A key the database has and no migration declares is not drift, for the reason index comparison gives. Named in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **`ROLE=migrate` exits non-zero on post-migration drift.** `runMigrations` logged the first difference and `runRole` returned success, so a release phase completed over a schema nobody can reconstruct. `x db migrate` and `ROLE=migrate` are still the same function call; the role entrypoint now throws the first difference, because the exit code is the only channel a release phase has.

- **A snapshot sidecar is validated, not asserted.** `readMigrations` checked that `tables` was an array and cast the rest, so `{"tables":[null]}` — valid JSON — became a `SchemaDescription` the diff then threw on. Every nested field is parsed by the new `parseSnapshot()` in `@ultimat3/db`; a file that does not describe a schema is *absent*, which the reader already handles.

- **A ledger the MCP host cannot read is not an empty ledger.** `db.migrate`'s dry run mapped every `readLedger()` failure to `[]`, so a permission denied or an unreachable server reported every migration as pending. Only Postgres' `undefined_table` does that now, through the new `isLedgerMissing()`; everything else propagates.

- **`scripts/stdout-truncation.test.ts` no longer asserts a race.** The premise case measured a naive `process.stdout.write` against a reader draining concurrently, and on a fast runner the whole payload landed by luck — a flaky gate step. It now writes past any kernel buffer and reads nothing until the child has exited, so what `process.exit()` discarded was genuinely discarded.

### Changed

- **BREAKING — one `resolveEnvironment`, and it is `@ultimat3/core`'s.** The name existed in
  `@ultimat3/core` and `@ultimat3/seo` with different parameters and different return unions — an
  axiom-1 violation the 1.1.0 notes named and deferred, because unifying two shipped public APIs is
  a major. This is the major. `@ultimat3/seo` now exports neither `resolveEnvironment` nor the type
  `SeoEnvironment`; `ULTIMATE_ENV` has exactly one reader, and the seo package owns only what an
  unreadable environment means for a crawler.

  | Was | Now |
  |---|---|
  | `import { resolveEnvironment } from '@ultimat3/seo'` | `import { resolveEnvironment } from '@ultimat3/core'` — an options object, `resolveEnvironment({ env })`, never a positional env record, and it **throws** `X_ENVIRONMENT_INVALID` on a typo'd `ULTIMATE_ENV` instead of failing closed |
  | a caller that must answer rather than fail | `tryResolveEnvironment()`, and supply your own fallback — `tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT` |
  | `import type { SeoEnvironment } from '@ultimat3/seo'` | `import type { Environment } from '@ultimat3/core'` |
  | `buildRobots({ environment: 'preview' })` | `buildRobots({ environment: 'staging' })` |
  | `isIndexable('preview')` | `isIndexable('staging')` |

  `isIndexable()` and `RobotsConfig.environment` take `Environment`, so `'staging'` is accepted and
  `'preview'` is a compile error. **No `robots.txt` body changes**: neither spelling was ever
  indexable, and only the `# environment:` comment line moves.

  `tryResolveEnvironment()` is new in `@ultimat3/core` and exists for one reason worth stating.
  `ULTIMATE_ENV` is **not** in the env schema, so nothing validates it at boot and nothing in a web
  container's boot path resolves the environment unconditionally — a `robots.txt` render is
  routinely its first reader. A typo would otherwise 500 the one response whose body was already
  going to be `Disallow: /`. It resolves identically to `resolveEnvironment()` for every other
  input and returns `undefined` for exactly the one case that throws, so the key still has one
  reader and only the failure policy differs. It names no fallback of its own; the caller does.

- **BREAKING — the NATS wire client is `nats@2.29.3`, behind the transport seam that did not
  move.** `@ultimat3/realtime` hand-rolled the protocol: `nats-protocol.ts`, `nats-commands.ts`,
  `nats-socket.ts` and `nats-connection.ts` — 1,019 LOC of framing, parser, PING/PONG, TLS upgrade,
  inbox muxing and reconnect, with zero integration benefit, plus a 431-line fake nats-server to
  test them. All of it is deleted. The criterion is
  [`docs/idea/18-build-vs-wrap.md`](docs/idea/18-build-vs-wrap.md): own what must join the
  transaction, context and error machinery; wrap a wire protocol with a dominant maintained client,
  because an agent knows that client's semantics from training and can never know a
  reimplementation. `nats` is the first external runtime dependency any `@ultimat3/*` package has
  taken, pinned exact, importable from exactly one file (`nats-lib-client.ts`) — every other file
  is written against the port in `nats-client.ts`.

  What did not change is the point: `Transport`, `NatsTransport`, `NatsTransportOptions` and
  `selectTransport` are the same seam, and `presence.live.test.ts` passes **unmodified** against a
  real nats-server. What did: reconnect and re-subscription are the library's, so the transport
  keeps no subscription bookkeeping at all — our thundering-herd jitter is handed down as its
  `reconnectDelayHandler`, and the JetStream KV layer stays ours because this client's KV
  abstraction expresses neither per-message TTL (`Nats-TTL`) nor a batch `multi_last` direct get.
  The test seam moved up one level, from an injected byte stream to an injected client:

  ```ts
  new NatsTransport({ url, bucket, open: (target) => Promise.resolve(stream) });  // before
  new NatsTransport({ url, bucket, connect: fakeNatsConnect(broker) });           // after
  ```

  Removed exports: `NatsConnection`, `NatsConnectionOptions`, `NatsConnectOptions`,
  `NatsProtocolParser`, `NatsOperation`, `NatsServerInfo`, `NatsStream`, `natsStreamOver`,
  `bunNatsStream`, `FakeNatsServer`, `fakeNatsStream`. Added: `NatsClient`, `NatsConnect`,
  `NatsClientOptions`, `NatsRequestOptions`, `NatsRequestManyOptions`, `openNatsClient`,
  `FakeNatsBroker`, `fakeNatsConnect`. `NatsHeaders`, `NatsMessage`, `NatsMessageHandler`,
  `NatsSubscription`, `NatsTarget` and `parseNatsUrl` keep their names and move to
  `nats-client.ts`.

- **BREAKING — `@ultimat3/cli` exports `checkSourceDrift`, not `checkDrift`.** Two functions named
  `checkDrift` answered two different questions; the name now says which is which. `@ultimat3/db`'s
  `checkDrift()` keeps its name and its meaning — the live database against the ledger, the
  post-migrate verification. `@ultimat3/cli`'s becomes `checkSourceDrift()` — the entity source
  hashed against what `x db gen` recorded, no database, which is what `x verify`'s `drift` step
  needs to run in CI. `recordedHashes`, `schemaHash` and `writeSchemaHash` are unchanged.

  ```ts
  import { checkDrift } from '@ultimat3/cli';        // before
  import { checkSourceDrift } from '@ultimat3/cli';  // after — same signature, same findings
  ```

  Nothing an app writes calls either: both are the CLI's own step implementations. The defect
  behind the rename is below under *Fixed*.

- **BREAKING — `invariants` is a function, and `invariant()` takes a built expression.** `invariants: (c) => [...]` receives the column proxy once, so `invariant(name, expr)` no longer carries a `(c) => Expr` builder of its own. The array form is gone; there is one way to write a rule.

  The defect it fixes: `InvariantColumns` was an index-signature type, so under `noUncheckedIndexedAccess` every `c.title` was `ColumnExpr | undefined` and **every** entity `x new`, `x g entity` and `x g resource` write failed `typecheck` until the author added `!`. Typing the proxy from the declared columns only reaches `c` when the whole `invariants` argument is context-sensitive — a per-element `invariant(name, build)` is a call TypeScript checks before `entity()`'s `C` is fixed. `InvariantColumns<C>` is now a mapped type over `C`, so `c.title` is a `ColumnExpr` and `c.titel` is `TS2551: Property 'titel' does not exist … Did you mean 'title'?`. `unique()` and `satisfies()` take `keyof C & string`, so a typo in a column *list* is caught too.

  Before:

  ```ts
  invariants: [
    invariant('post_title_not_blank', (c) => c.title!.trimmed().minLength(1)),
    invariant('post_price_non_negative', (c) => c.price!.minor.atLeast(0)),
  ],
  ```

  After:

  ```ts
  invariants: (c) => [
    invariant('post_title_not_blank', c.title.trimmed().minLength(1)),
    invariant('post_price_non_negative', c.price.minor.atLeast(0)),
  ],
  ```

  Mechanical migration: move the `[` to after `(c) => `, drop each `(c) =>` inside `invariant()`, drop every `!`. `indexes[].where` is unchanged — it was already a callback, and its `c` is now typed too. Nothing else changes: a rule still runs in the app on every write **and** emits its `CHECK`/`UNIQUE` through `toSql()`, and an untranslatable JS predicate still reports `kind: 'assert'` with `sql: null`. The runtime Proxy stays, so a JS caller still gets `no column "titel"; declared columns are …` at declaration time.

- **BREAKING — the framework's version is a call, not a constant.** `FRAMEWORK_VERSION` is gone; `frameworkVersion()` from `@ultimat3/core` replaces it, and `@ultimat3/mcp`'s `DEFAULT_SERVER_INFO` becomes `defaultServerInfo()` and `@ultimat3/cli`'s `CLI_VERSION` becomes `cliVersion()` for the same reason — a constant holding the result is the module-scope read again, one import away.

  ```ts
  import { FRAMEWORK_VERSION } from '@ultimat3/core';   // before
  import { frameworkVersion } from '@ultimat3/core';    // after — call it: frameworkVersion()
  ```

  The defect it fixes is below under *Fixed*: read at module scope, the version resolved before `main` in every process that imported core, so `x build --target binary` produced an executable that threw at import. Resolution order is manifest → build define → throw, and the throw is unchanged in the case it was written for: a manifest that exists and declares no semver is still a broken publish, still `X_INVARIANT`, define or no define. The value is resolved once and cached, so a call site pays one `existsSync` for the process.

- **`x verify` counts skips apart from passes, and names them.** A step with nothing to check here is recorded green so the run continues, and the summary counted it among the passes — so a repo whose `job` and `eval` suites do not exist printed the same `all 17 steps passed` as a repo where both ran. The line is now `12 of 17 steps passed in 53224ms — 5 skipped: job, eval, drift, contract-diff, budgets` in this repo, and `14 of 17 steps passed in 11153ms — 3 skipped: e2e, contract-diff, roadmap` in the scaffolded app of [tutorial 2](https://github.com/developerz-ai/ultimate/wiki/Tutorial-02-First-Feature); `all {n} steps passed` survives only when nothing was skipped. `--json` gains `data.skipped`, the list of names beside `data.failed` (`steps[].skipped` is unchanged). Exit codes are untouched: a skipped step is still not a failure — it is now just impossible to mistake one for a passing one.

### Added

- **`queryClient` — the map-wide typed read client, the mirror of `rpc`.** `@ultimat3/query` shipped
  `.client({ baseUrl })`, which needs the query object — so the one surface that most needs a typed
  read could not have one: a `site/` route importing a feature's `live.ts` to reach it is
  `X_BOUNDARY_VIOLATION`, and the reference app had all seven of its read call sites taken off the
  **action** client instead, where none of those names exist. `queryClient<Api['queries']>({ baseUrl })`
  binds every registered read off the `Api` **type** alone, exactly as `rpc<Api['actions']>` binds
  every write. Both spellings proxy to `queryClientMethodFor`, so a read has one URL however it is
  addressed.

  ```ts
  // apps/web/shared/client.ts — two registries, two clients, one origin
  export const client = rpc<Api['actions']>({ baseUrl });          // writes
  export const queries = queryClient<Api['queries']>({ baseUrl }); // reads
  ```

- **`backfill()` — one pass over a table, declared as a `job`.** `@ultimat3/jobs` gains a factory, not a ninth primitive: a backfill is durable work with an input schema, a retry policy, an idempotency key and a queue, so `backfill({ name, source, batch, handle })` *returns* a `JobHandle` and inherits `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row with no line of its own. Same rule `llm()` follows: a new capability arrives as a factory over an existing primitive.

  ```ts
  export const rewriteSlugs = backfill({
    name: 'rewrite-slugs',
    batch: 1_000,
    source: () => db.posts.where({ published: true }),
    async handle({ rows }) {
      await db.posts.upsertAll(rows.map(slugged), { onConflict: ['id'] });
    },
  });
  ```

  `source` is read through `inBatches()` — one statement per page, keyset, never OFFSET — and every page is handled inside its own `step.run`, named `batch:0`, `batch:1`, … So a run killed mid-pass resumes on the page it stopped at: the completed steps replay from storage without touching the database, and the iteration is opened at the cursor they leave behind. What a step persists is that cursor and a row count, **never the page** — `steps.ts` hands a completed step's output back for the whole run, so checkpointing rows would retain every row already processed until the job ended. The body is handed no `step` for the same reason step names are positional: a name minted inside it would collide with itself on the second batch. `idempotencyKey` is the backfill's name, so re-enqueueing a live pass is the same pass.

  **`handle` is at least once, and that is a requirement on the handler.** It runs *before* its checkpoint lands, so an attempt killed, cancelled or lease-expired between the last row and the step record hands the same page to the next attempt: write through `upsertAll`, `updateWhere` or a statement whose second run changes nothing, never `count + 1` and never an unguarded external side effect. The order is the only one that is safe — a checkpoint written first would report a page as swept that no attempt ever wrote, and a lost page is unrecoverable where a repeated one is a handler's problem to be idempotent about.

  **`x_backfills` records what has already been swept**, the twin of `x_migrations` one level up: name, definition checksum, status, app version, rows processed, last cursor, started/completed. It ships in the same DDL as `x_jobs` and `x_job_steps` and hangs off the queue driver as `driver.backfills`, so a ledger a pass cannot write is a queue it could not have been claimed from — and a driver without one runs backfills with no bookkeeping rather than refusing them, exactly as `introspect` already degrades. Re-enqueueing a **completed** name is a no-op with a report (`{ skipped: true, previousRunId }`) — no statement, no body call, no row. `enqueue({ force: true })` sweeps again and writes a **new** row: reruns are history, never an edit of the row they rerun. A definition whose checksum moved since the completed pass **warns** and still does not run, because this checksum is over function source text, which a bundler can move without a line of behaviour changing — where `@ultimat3/db`'s `auditLedger` throws on the same fact, since SQL text is what it applied.

  The row is a **report**, never a resume source: where a resumed pass restarts is decided by the step checkpoints and by nothing else. A retry adopts its own row (`started_at` is when the pass began, not this attempt) and clears `completed_at`, which `finish` stamps for `failed` as well as for `completed` — every surface projects that column, so a running pass keeping it would render with a completion time in the past. An attempt that failed is recorded as `failed` with its cursor kept, because where a pass stopped is the first thing anyone asks about one.

  **A backfill is throttled, and the default is slow.** `rate` is batches per second and defaults to `DEFAULT_BACKFILL_RATE` (5) — 5,000 rows/sec at the default batch, one statement every 200ms, so the pool spends the rest of each interval serving the requests the app is still taking. There is **no unthrottled mode**: to sweep faster you raise the number, and a rate above what the batches can achieve simply produces no wait. The pause is spent **inside** each batch's `step.run`, which is what stops a resumed attempt from re-paying the throttle of the five hundred batches it is replaying, and it unwinds on the run's cancellation (`X_ABORTED`) rather than sitting in a timer nobody is waiting for. `rate` is not part of the definition checksum, for the reason `batch` is not: pacing is tuning, and changing it does not make a completed sweep a different sweep.

  **Progress is readable from three surfaces, all reading the one ledger.** `x db backfill --list` prints it (`--name`, `--status`, `--limit`, and `--json` carrying the same rows); `x jobs ls` reports the passes **in flight** with rows-so-far and cursor, and `x jobs show <id>` carries the ledger row for that run under `backfill`; `/_x`'s jobs panel carries the whole ledger plus a live count. One projection behind all of them — `inspectBackfills()` in `@ultimat3/jobs` — so the dashboard renders what `--json` prints. `x db backfill` without `--list` is refused with the command that works, because `x db backfill <name>` will one day *run* a pass and a bare invocation that quietly listed would be a silent no-op the day it lands.

- **`appVersion()` in `@ultimat3/core`.** One reader for `APP_VERSION`, defaulting to `dev`. It was spelled inside `@ultimat3/db`'s `runningAppVersion`, which now delegates — `x_migrations.app_version` and `x_backfills.app_version` are two durable columns an operator reads side by side, `@ultimat3/jobs` cannot reach `db` for the answer, and two packages defaulting the key their own way would put two names on one build.

- **The destructive-SQL rail: a migration that destroys data must say so, and `x verify` refuses one that does not.** `x db gen` now writes `-- destructive: true` into any migration whose `up` drops a table, drops a column, truncates or retypes; `x verify`'s `drift` step reads the committed files back and fails an unmarked one with the new `X_MIGRATION_DESTRUCTIVE`. The strong-migrations idea, enforced rather than documented — a drop is allowed, an *undeclared* drop is not.

  ```text
  X_MIGRATION_DESTRUCTIVE: this migration destroys data and does not say so
    cause: packages/db/migrations/0002_drop_legacy.sql drops a column and does not declare it:
           alter table "posts" drop column "legacy"
    fix:   add the line "-- destructive: true" to packages/db/migrations/0002_drop_legacy.sql,
           or regenerate it: x db gen "<name>" --allow-destructive
  ```

  One classifier decides for both halves (`@ultimat3/db`'s new `destructive.ts`, exported as `destructiveStatements()`, `hasDestructiveMarker()`, `isDestructive()` and `DESTRUCTIVE_MARKER`), so the generator cannot write a file that fails its own gate. Four rules: only `up` is judged — reversing a `create table` is a `drop table`, and marking every `down` marks nothing; the kind list is closed at four — `drop constraint`/`default`/`not null` and `drop index` are rebuildable and excluded by name; the decision runs over comment- and literal-blanked text, so `-- drop table users` is prose and `values ('drop table users')` is data; and the marker is a whole line, so a file merely mentioning it has declared nothing.

  `X_MIGRATION_DESTRUCTIVE` is not a second spelling of `X_MIGRATION_IRREVERSIBLE`. Irreversible refuses to *generate* a plan whose `down` cannot restore the rows, with `--allow-destructive` as the override. Destructive refuses to *ship* a plan whose `up` destroys them without saying so — which is why a column retype, reversible in DDL and gated by no flag, is now marked though it is never refused. Mark a migration before it is applied: the marker is SQL the checksum covers, so adding it to an applied file is an edit, and `X_MIGRATION_CONFLICT` correctly says so. Existing migrations are unaffected — the reference app's `0001_init` creates and drops nothing.

  `GeneratedMigration` gains a `destructive: boolean` field. `stripSqlNoise()` moves from `readonly.ts` to its own `sql-noise.ts` — same export, same behaviour, now shared by three guards without putting the error registry in an import cycle.

- **`job_leases_lost_total{queue}` — a counter for jobs the queue took back while they were still running.** Declared beside the other runtime series in `@ultimat3/core` (`leasesLost`, `recordLeaseLost(queue)`) and emitted from one place, the worker's lease heartbeat. Alert on any non-zero rate: it is the one queue failure that at-least-once delivery cannot paper over, and until now it was invisible. See the `Fixed` entry below.
- **Realtime subscription handles are `Disposable` — `using sub = client.useLive(...)` unsubscribes on scope exit.** `LiveHandle` (`useLive`'s return, and `LiveRows` one layer up through the `useLive` hook) and `Unsubscribe` (`client.subscribe(topic, handler)`'s return) now carry `[Symbol.dispose]`, wired to the exact same function `unsubscribe` already was — never a second teardown implementation to drift from it. Purely additive: `unsubscribe()` and the callable topic-unsubscribe function both still work exactly as before, so no call site needs to change. Pinned in `packages/realtime/src/type-pins.ts` so a future refactor that drops the member fails the build rather than a call site months later.
- **`findById` batches itself — one microtask of point lookups is one `where "id" in (…)`.** A page that resolves an author per row sent one `select … where "id" = $1` per row. Inside a request, `postgresRepo()` now collects the lookups issued in the same microtask and sends one statement for all of them:

  ```ts
  // One statement, not one per post. findById's signature and its meaning are unchanged.
  const authors = await Promise.all(posts.map((post) => users.findById(post.authorId, { orgId })));
  ```

  No `dataloader()`, no `batch()`, nothing to opt into: the capability lives inside the method that already exists, which is the only place it can reach code already written. The batch is keyed by context identity — a `WeakMap`, so it dies with the request, the shape `@ultimat3/query`'s request memo has one tier up — and by a scope key covering every input to the statement except the id, so another tenant, another soft-delete visibility, another projection, another entity or another client is a different statement and never joins one. What goes out is the statement each single lookup would have been served by, `in` instead of `=`: the tenant predicate and the `deleted_at is null` clause are inside it, so an id whose row is missing, soft-deleted or another tenant's still reads as `null`. Past 500 ids it becomes several whole statements rather than one Postgres refuses for its bind count, and it declines outright — sending exactly what it always sent — with no request in scope (a job, a script), on a composite primary key, or on a scope it cannot compare. The window is one microtask and closes before the statement is sent, so a sequential `for … of` loop shares nothing through this path — what batches one is the sibling preload below. Proved against a real Postgres in `pg-driver.live.test.ts`: five lookups, one statement, the same five answers.
- **A `for … of` loop over a page is two statements — the sibling-aware preload.** A microtask window cannot see a sequential loop: its `await` closes the window before the next lookup exists. `findMany` now leaves its page's foreign key **values** behind for the request, so the first `findById` for any one of them resolves that key for **every** row of the page in one statement and the rest of the loop is served from memory. On by default; `postgresDriver({ jitPreload: false })` is the one switch that turns it off, where the driver is already constructed — not an `app.config.ts` key, because nothing reads config at the seam that builds a repository and a switch the framework cannot read is a switch that does nothing:

  ```ts
  const page = await posts.findMany({ orgId });
  for (const post of page.rows) {
    // Two statements for the whole loop: the page, then one `select … where "id" in (…)` over
    // every author on it. Every lookup after the first is memory.
    const author = await users.findById(post.authorId, { orgId });
  }
  ```

  Nothing new to write — the relation is the `references()` already declared, and `findById` keeps its signature, so the fix reaches loops that are already written. The scope guard is a security boundary, not a tuning knob: a preloaded row is served only to a lookup with the same scope key the batch above uses (tenant predicate, soft-delete visibility, projection, entity), the same client, and no write to that entity since — anything else reads the statement it always read. The preload statement is that same statement widened to the page's ids, so its tenant predicate and `deleted_at is null` clause are in the SQL Postgres runs; a page's ids can therefore never resolve rows outside the reader's own scope. The index holds values and not rows, keyed by context identity, so it pins nothing and dies with the request; a page of a hundred rows by one author is still one bind; a nullable key that resolved to nothing is not a row to go looking for; past 500 ids it becomes whole statements; and with no request in scope (a job, a script) a page leaves nothing behind at all.
- **`preload(name)` — the join a `for … of` loop would have earned, without writing the loop.** The two paths above catch a lookup pattern already written; `preload()` is the same join, named on the chain instead of triggered by a loop:

  ```ts
  export const db = database({ orgs, posts, members });

  // Two statements: the page, then one `select … where "id" in (…)` over its authors.
  const page = await db.posts.where({ orgId }).preload('author').page();
  page.rows[0].author;        // the member row, or null — always present
  ```

  One vocabulary, `preload('<relation>')` — no `include`, `join` or `with`, and nothing new to declare: the name is the `references()` already written, resolved by `relationNamed()` when `preload()` is called, so an unknown one is `X_PRELOAD_UNKNOWN_RELATION` on the chain and not a page later. A `belongsTo` attaches the row or `null`, a `hasMany` an array — always present, so "no author" and "nobody preloaded the author" never read the same. Several `preload()` calls resolve concurrently, never one after the other, and naming one relation twice is one statement; keys are chunked at `MAX_IDS_PER_STATEMENT` (500) exactly as a coalesced point read already is, so past 500 keys a relation costs several statements rather than one Postgres refuses for its bind count, and a relation with more rows than one page holds costs another keyset page rather than a silent truncation. The page's own tenant predicate carries onto the related read only when the other entity's tenant column has the same name — a value that scopes one entity is a guess on another, and a guess here is a cross-tenant read — so a differently-named tenant column carries nothing, and carrying nothing is not silent: the related read builds its own plan and `assertScoped` refuses it there as `X_TENANCY_UNSCOPED`. The related read is `findMany`, so `deleted_at is null` applies exactly as it does anywhere else. Attached to a copy of each row — `{ ...row }`, because the in-memory driver hands back the row it stores — after `select()`, which is widened internally with the relation's local key so a projection can drop neither the key a preload reads nor the relation it attaches; `plan().select` reports the widened list. `page()`, `all()` and `one()` preload; `count()` and `plan()` do not, since a count reads no rows. A table reaches only the entities its own `database()` call named, through the driver that call was given, so a preload against memory means what a preload against Postgres means — a relation whose other end is outside the set is `X_INVARIANT_VIOLATED` naming the `database({ … })` call that fixes it, and `tableFor(entity, repo)` built by hand reaches no other table. `preload('author')` returns `ReadBuilder<Row & { readonly author: unknown }>` — `unknown`, not a generated type, because the name is a string resolved at runtime and the row on the other side is parsed by its own entity.
- **`insertAll(rows)` and `upsertAll(rows, { onConflict })` — the write loop, as one statement.** Three bullets above make a read loop stop being N statements; a loop of `insert()` calls still was. Both land on `Repo`, on `Table` and on **both** drivers:

  ```ts
  // One `insert into … values (…), (…), (…) returning *`, not three round trips.
  await db.tags.insertAll(names.map((name) => ({ orgId, name })));

  // The like nobody can like twice, without a read to find out first.
  await db.likes.upsertAll(rows, { onConflict: ['orgId', 'postId', 'memberId'], onMatch: 'nothing' });
  ```

  `insertStatement` builds every insert in the framework now, one row or ten thousand, so `insertAll([row])` compiles to the text `insert(row)` always compiled to and there is no second builder for the two to drift apart in. Rows are `Insertable`, parsed by `$parse` exactly as one row is — declared defaults are filled here, not by the caller — and `upsertAll` also stamps `onUpdateNow()` columns through `touch()`, the one place that happens, because an upsert that lands on a stored row *is* an update. The result is the rows the call actually **wrote**: under `onMatch: 'nothing'` a row already stored is skipped and absent, which is what `returning *` says on the server and is therefore how a caller counts what it inserted. A collision overwrites every column in the batch except three closed sets — the conflict target, which is how the stored row was found, the primary key, which is where it lives, and the soft-delete stamp, which is whether the row is there at all; moving either of the first two would move a row nobody asked to move and every foreign key pointing at that id would miss it, and writing the third would bring back a row the app had deleted. A soft-deleted row still occupies its conflict target — the unique index it collides with is not partial — so `excluded."deleted_at"` is the resurrection `update(id, patch)` and `updateWhere` both refuse by carrying `deleted_at is null`, which an `on conflict` clause cannot carry; it is dropped from the set list rather than refused, because `$parse` fills `deletedAt: null` into every row before the plan is built, so that value is the framework's and not the caller's. `insertAll` is untouched: a row that collides with nothing writes the stamp it carries, exactly as `insert` does. Past Postgres's 65535 bind parameters the batch becomes several whole statements rather than one the server refuses, so an all-or-nothing caller wraps the call in `withTransaction`. Four refusals precede the statement, each of them a `42P10`, a cross-tenant write or a silent surprise otherwise: a conflict target no declared unique constraint matches, a target that omits the tenant column under `onMatch: 'update'` (`X_TENANCY_UNSCOPED` — another tenant's row would match and be rewritten, so an updating upsert must be scoped by the constraint itself), a batch that repeats one conflict target under `'update'` (Postgres answers that `ON CONFLICT DO UPDATE command cannot affect row a second time`), and a batch whose rows name different columns under `'update'`, where `excluded.<column>` is that column's default and not "leave it alone". The in-memory driver answers all four the same way and judges the whole batch before storing any of it, so a test that passes against memory still says something about Postgres — including `NULLS DISTINCT`: a null in the conflict target collides with nothing, there and here.
- **`inBatches(size)` — reading a whole table is a terminal on the chain, not a loop around `page()`.** A page is bounded on purpose, so every backfill, export and reindex hand-rolled the cursor loop, and the hand-rolled ones are where an `offset` creeps back in. `ReadBuilder` now ends in one:

  ```ts
  // One statement per batch, one page of rows in memory at a time.
  for await (const batch of db.posts.where({ orgId }).preload('author').inBatches(500)) {
    await search.index(batch);
  }

  // Stopping early keeps the position, so a job resumes where it ran out of time.
  await using batches = db.posts.where({ orgId }).after(checkpoint).inBatches(500);
  for await (const batch of batches) {
    await search.index(batch);
    if (ctx.clock.now() > deadline) break;
  }
  await db.checkpoints.update(id, { cursor: batches.cursor });
  ```

  A batch **is** the page `page()` would have returned at that position — same filters, same tenancy, same soft-delete visibility, same `select()`, same `preload()` — so there is no second read path to learn or to drift, and both drivers inherit it from the one they already share. The handle is the iteration: `break`, `return`, a throw and `await using` all stop the *next* statement (`close()` is the generator's own `return()`, so it is idempotent by construction), a second `for await` continues it rather than re-reading the table from the top, and an empty batch is never yielded. `.cursor` is where the next batch starts and advances before the yield, so a consumer that breaks reads the position it stopped at and `.after(cursor)` resumes it. Three refusals land on the chain instead of one batch later: a size that is not a whole number of rows, a chain that also called `limit()` — one number with two meanings, and honouring it reads a fraction of a batch while dropping it reads the whole table the caller thought they had bounded — and an ordering no cursor can carry, which is the one that matters most: a nullable sort column mints no cursor when the result fits in a single batch, so it would pass every test and fail once the table grew.
- **`countBy(column)` — a `count()` per row is one grouped count.** Recounting a page of posts' likes sent one `select count(*)` per post, and no batch above reaches those: each of them asks a different question. This asks all of them at once, on `Repo`, on the chain and on **both** drivers:

  ```ts
  // Before: one statement per post.
  for (const id of ids) {
    const likeCount = await db.likes.where({ orgId, postId: id }).count();
    await db.posts.update(id, { likeCount });
  }

  // After: one statement for every post in `ids`.
  const counts = await db.likes.where({ orgId }).andWhere('postId', 'in', ids).countBy('postId');
  for (const id of ids) await db.posts.update(id, { likeCount: counts.get(id) ?? 0 });
  ```

  It counts the whole predicate and never the page, exactly as `count()` does: the chain's filters, its tenancy (`X_TENANCY_UNSCOPED` on a tenant-scoped entity with no org predicate) and its `deleted_at is null` visibility are all in the statement, and `limit()`/`after()` bound it no more than they bound a `count()`. **A value nothing matched is absent, never `0`** — that is what `group by` returns, and it is what lets a caller tell "none" from "never asked"; the default is the caller's `?? 0`. **NULL is one group**, keyed `null`, in both drivers: in memory a property the row never carried is `?? null`, so it lands in the group Postgres files its NULL rows under, while `0`, `''` and `false` stay the values they are. Entries come back biggest group first, ties by the value — numbers and bigints numerically, everything else by its text — and `null` last; the order is applied in `count-by.ts` after the rows are in rather than in the statement, because a hash aggregate returns groups in whatever order it built them and a `Map` filled row by row returns insertion order, so an `order by` there would let the two drivers disagree about a result they agree on. Groupable columns are a closed set — `uuid`, `text`, `char`, `boolean`, `integer`, `bigint` — and a `timestamptz`, a `jsonb` or `money` is `X_INVARIANT_VIOLATED` whose `fix` names a column of that entity that *is* groupable: a `Map` compares a non-primitive key by identity, so such a map could only ever answer `undefined`. The number of groups is bounded at `MAX_GROUPS` (1000), and going past it is a **refusal, not a truncation** — the statement asks for one group more than the bound, the trick a page already uses when it reads one row past its limit, and that extra group fires `X_INVARIANT_VIOLATED` spelling `andWhere('<column>', 'in', <values>).countBy('<column>')`, because a map that silently lost its tail reads exactly like a complete one and a caller recounting from it would write the wrong number to every row it missed. One statement: `select "post_id" as group_value, count(*) as group_count from "likes" where … group by "post_id" limit $n`. Both output names are fixed aliases, so they cannot collide with each other whatever the table declares — an entity is free to have a column called `count` — and the grouped value is re-parsed by the column that declared it, since `int8` arrives as a string and would otherwise key the map by text where the in-memory driver keys it by a `bigint`. No new error code, no `groupBy()` builder, nothing to declare: it is a terminal on the chain that already exists. Pinned in both drivers — in memory, and against the recording client.
- **`relationMap()` — the foreign keys an entity already declared, readable at query time.** `ColumnMeta.references` was resolved in exactly one place, `describe.ts`, to spell a DDL constraint; at query time nothing could answer "what is a post's author". `@ultimat3/entity` now derives a named map from the same thunks — `belongsTo` from an entity's own foreign keys, `hasMany` from the inbound ones:

  ```ts
  relationMap().posts;
  // { org:    { kind: 'belongsTo', to: 'orgs',    localKey: 'orgId',    remoteKey: 'id' },
  //   author: { kind: 'belongsTo', to: 'members', localKey: 'authorId', remoteKey: 'id' },
  //   likes:  { kind: 'hasMany',   to: 'likes',   localKey: 'id',       remoteKey: 'postId' } }

  relationsFor('posts');              // one entity's relations
  relationNamed('posts', 'author');   // one relation, or X_PRELOAD_UNKNOWN_RELATION listing the rest
  ```

  No new declaration syntax, and there will not be one: a `hasMany: […]` init key would be a second copy of a fact the foreign key already states, free to drift from the constraint the migration emits. `local*` is always a property of `from` and `remote*` of `to`, so a traversal reads the same in both directions. Names come off the key (`authorId` ⇒ `author`) and, for a `hasMany`, off the entity the rows come from; when two keys want one name **every** member of that group takes its long form (`author`/`authorId`, `postsByAuthor`/`postsByReviewer`), so adding a second foreign key never renames an existing relation by declaration order. Two keys differing only by an `Id` suffix are `X_INVARIANT_VIOLATED` naming both columns, never one relation swallowing the other. A money column declares no relation, since one property is two physical columns.

  The relations reach query time through the registry, not through a list the caller assembles: `RegistryEntry` gains `references()`, the resolved records, and `ColumnDescription.references` is now *rendered* from them, so the `"<table>.<column>"` string a migration reads and the record a traversal reads cannot disagree. It is a method because a `references()` thunk may point at an entity two modules of an import cycle have not finished evaluating. `relationMap()` memoises against a registry generation, so a schema module imported late rebuilds the map instead of being missed by it; `relationsOf(entries)` is the same derivation over a named subset. A name that resolves to nothing is `X_PRELOAD_UNKNOWN_RELATION`, and its `fix` is a `relationNamed()` call on one that does exist with the rest named after it — they are derived, so there is no schema file listing them to go and read; an entity with no foreign key at all gets `x entities list --json`, since the declaration it needs names a target the error cannot know. Additive — nothing consumes the map yet; a preload is what will.
- **`x.verify.json` — the suite floor, so a step that once applied must keep applying.** Counting the skips made a vacuous gate visible; nothing made one fail. Delete a suite and its step goes from passing to skipped, and `x verify` still exits 0. The floor is this repo's committed claim about which steps it already runs — hand-written, read by the gate, written by nothing, because a gate that edits its own floor ratchets both ways:

  ```json
  {
    "steps": [
      "typecheck", "lint", "boundaries", "filesize", "package-shape", "errors",
      "unit", "contract", "live", "e2e", "manifest", "roadmap"
    ]
  }
  ```

  A step named there that reports nothing to check is recorded **failed and not skipped**, with `X_VERIFY_SUITE_VANISHED` and both edits that resolve it — so it lands in the failure count, in `data.failed`, and in every step table another gate parses. Not a breaking change for an existing app: a repo that commits no floor is not ratcheted and behaves exactly as before. A floor naming a step the gate does not run enforces nothing and is refused by the `manifest` step (`X_CONFIG_INVALID`), because a typo covering no suite is the same false green. This repo's own floor pins 12 of 17; `job`, `eval`, `drift`, `contract-diff` and `budgets` are the honest skips.
- **`setStatementObserver()` — the seam a statement-level diagnostic installs into.** `@ultimat3/db` emits no span, no counter and no log for a statement, so nothing above it can count one: the dev timeline's `repeatedSql` groups span names and has never seen a repository read, which makes an N+1 invisible by construction. The seam is one process-wide observer, the `setDbClient` shape, with a `StatementEvent` carrying `{ text, values, durationMs, rows, error?, attribution?, expected? }`:

  ```ts
  setStatementObserver({ onStatement: (e) => ledger.count(e.text) });
  setStatementObserver(undefined);   // production, and what every test must leave behind
  ```

  `attribution` — the `{ entity, op }` pair that lets a report read `50× findById on members` instead of 50 copies of one `select` — is produced, `As of 2026-08`: `@ultimat3/entity`'s `postgresRepo` is the one producer, the last caller that still knows both once the SQL exists, and it wraps every repository method around its send through `withStatementAttribution()`. Hand-written SQL, a migration, a health probe and `@ultimat3/jobs`' own queue statements still carry none — nothing above them knows an entity to name — which is why the field stays optional rather than required.

  Uninstalled costs one property read and one branch, which is why the accessor hands back the installed observer itself instead of notifying through a wrapper: no event object is built for nobody to receive (axiom 6). One observer, not a list — a second install replaces the first, so "which diagnostic saw this statement" is never order-dependent, and the one consumer that needs several composes them itself, where that order is reviewable. A throw from `onStatement` reaches whoever ran the statement, deliberately: strict test mode is an observer that fails the test its N+1 happened in, and containment here would make that impossible.

  It is invoked from the two funnels every statement already passes through, and from nowhere else: `runOn` in `client.ts` — pooled and pinned alike — and `statement()` in `pglite.ts`, which is the queued path, the pinned path and the in-transaction path that skips the queue. Both settle paths notify, so a statement that failed is reported with `rows: 0` and the `X_DB_UNAVAILABLE` its caller is about to be thrown: fifty identical timeouts are still fifty statements. `rows` is the count `execute()` answers with, off the same helper, so the report and the return value cannot disagree about one statement. Reserving a connection, booting PGlite and closing a pool are not statements and emit nothing.

  **Installing an observer is also what puts the database in the trace.** Both funnels now open one span per statement around the send alone — named `db.<verb>` (`db.select`, `db.begin`; a text opening with a comment is `db.statement`), OTel kind `client`, carrying the statement under `STATEMENT_ATTRIBUTE` (`db.statement`), now exported from `@ultimat3/db` so the CLI's recorder imports the key instead of restating it — a third copy of that string is a rename that leaves the timeline grouping nothing with every test still green. That is the attribute `x dev`'s recorder already preferred over the span name, and `db.` joins `query.`/`cache.`/`job.` in the prefix table that gives the `/_x` timeline its kind — so a request's flame gains the DB children `packages/http/src/pipeline.ts` has claimed since 1.0, and `repeatedSql` counts one SQL text fifty times instead of one `query.feed` once. It is one switch, not two: with no observer installed the branch that skips the event skips the span, so a production process mints no span id and allocates no span object for the hottest path it has.

- **`expectedQueryLoop(reason, fn)` — the one way to say a loop of queries is deliberate.** Some loops are optimal and a detector counting repeats cannot know which: the admin's cross-entity search issues one indexed lookup per text field because the query IR is a conjunction and three small indexed reads beat one unindexed `OR`, and `migrate()` applies one migration per transaction because a failure has to leave the ledger describing exactly what ran. Both are now declared at source, in the loop, with the argument for it:

  ```ts
  return expectedQueryLoop('admin search runs one indexed lookup per text field', async () => {
    for (const field of fields) hits.push(...(await repo.list({ where: [match(field)] })));
    return hits;
  });
  ```

  One mechanism, and deliberately not two: no comment pragma, no config list of exempt call sites, no per-code threshold table (axiom 1) — each of those puts the argument somewhere other than the loop it defends, where the next reader will not find it. `reason` is required and non-blank (`X_INVARIANT` otherwise), because an exemption with no argument is a pragma with extra steps.

  The scope rides an `AsyncLocalStorage`, so it survives every `await` at any depth and two loops running at once never read each other. Both funnels stamp the innermost reason onto the `StatementEvent` as `expected` at settle time — captured with the statement rather than read later, because a diagnostic that judges a whole request judges it after every scope in it has closed. What is suppressed is a **verdict**, never a statement: the SQL is still sent, still observed, still a span on the trace, so everything that measures still sees the loop and only the thing that warns is told the author already answered. Production is unchanged: the reason is read inside the branch that already checks for an installed observer, so an app with no diagnostic pays nothing.

- **`withStatementAttribution(entity, op, fn)` — the `{ entity, op }` pair behind `StatementEvent.attribution`, produced.** The field shipped with `setStatementObserver()` (above) and no producer: every event in every running process read `attribution: undefined`. `@ultimat3/entity`'s `postgresRepo` is now the one producer — the last caller that still knows both once the SQL exists — and every repository method wraps its send:

  ```ts
  const attributed = <T>(op: string, send: () => Promise<T>) =>
    withStatementAttribution(entity.$name, op, send);

  async findById(id, options) {
    const op = 'findById';   // the same string idPlan(entity, id, options, op) reports on refusal
    return attributed(op, () => coalesceFindById(entity, client(), plan, shapeOf(args), id) ?? one(plan, args));
  }
  ```

  A scope, not a parameter: the statement leaves several frames and at least one microtask below the repository call that caused it — the coalescer flushes its batch from a `queueMicrotask`, a wide write is a chunked loop, a preload sends through `readByIds` — and threading a parameter through all of those is the same fact written five times, with every path an author forgot it emitting unattributed SQL instead. `withStatementAttribution` rides an `AsyncLocalStorage`, `expectedQueryLoop`'s own shape, so it survives every one of those `await`s; nesting keeps the innermost pair for the same reason `expectedQueryLoop` keeps the innermost reason — a relation preloaded during `findMany` reads through the *related* repository, so its statement is attributed to the related entity and its own operation, never to the read that triggered the preload. `findById`'s coalesced batch is flushed from a microtask scheduled inside the scope, so the one statement sent on behalf of fifty lookups carries the pair every one of those fifty would have carried.

  With no observer installed the scope is never entered — one property read, one branch, no object allocated, on the path every statement in the process takes (axiom 6), which is also why the pair arrives as two strings rather than a `StatementAttribution` literal: a literal at the call site would be allocated before the branch could decline it. An observer installed *during* `fn` therefore sees the statements that follow unattributed — installation happens once, at boot. Both funnels call `statementAttribution()` inside the branch that already found an observer, next to `expectedQueryLoopReason()`, and stamp it onto the event on **both** settle paths — the same argument as `expected`: a diagnostic that judges a whole request runs long after every scope in it closed. Hand-written SQL, a migration, a health probe, `x db` commands and `@ultimat3/jobs`' own queue statements stay unattributed — nothing above them knows an entity to name, which is why the field stays optional and a detector must still fall back to the statement text. Additive — nothing reads `attribution` yet; the N+1 detector is what will.

- **`x dev` counts repeated statement shapes per request — and it is the only process that does.** `x dev` now installs a `StatementObserver` at boot, next to the span exporter and for the same reason: an installed observer is the single switch that turns statement instrumentation on at all, so the `/_x` timeline's SQL rows and the repeat counts arrive together instead of through two toggles. `serve.ts` installs neither — a production process still pays the one `undefined` branch the seam costs uninstalled, and nothing more (axiom 6), which is the same line `serve.ts` already draws for `/_x` itself.

  The visible half is immediate: **`/_x/timeline` has DB children.** Before this, no process in the framework installed an observer, so `@ultimat3/db`'s funnels opened no span, the panel's `repeatedSql` grouped span names, and a repository loop was invisible in the one panel built to show it. A `x dev` trace now carries one `db.<verb>` span per statement with the SQL under `db.statement`.

  The ledger behind it counts one shape per request. A shape is `entity.op` when the statement is attributed — `members.findById` fifty times is the report an author can act on, and the SQL is one sample of it — and the statement's own text, whitespace collapsed, when it is not. Counting state hangs off the request's own `Ctx` in a `WeakMap`, so it is collected with the request and never swept, and a statement issued outside a request (a migration, a boot probe, a script) is not counted at all: "five of one shape" only means something inside one unit of work. Five is the default threshold, a shape is promoted to a verdict exactly once — a loop of fifty is one verdict reading `count: 50`, not forty-six verdicts — and the verdict list is bounded so a dev server up for a week retains the recent loops rather than every loop it ever saw. `expectedQueryLoop` silences the verdict and nothing else: the statement is still sent, still observed and still a span, because that scope suppresses a judgement and this ledger *is* the judgement. A statement that threw still counts — fifty identical timeouts are fifty statements, and a detector that went quiet there would go quiet exactly when the loop cost the most.

  What renders those verdicts is the entry below: the ledger counts and warns once, and the four surfaces read one projection of it.

- **`X_N_PLUS_ONE_QUERY` and `X_N_PLUS_ONE_WRITE`, whose `fix` is a line that already compiles.** Both are owned by `@ultimat3/entity`, because the fix speaks that package's vocabulary — `preload`, `insertAll`, `updateWhere` — and a code owned by the process that detects loops would put the one sentence an author acts on in a package the entity layer cannot see. `nPlusOne(loop)` takes a ledger's verdict and returns the error; it counts nothing, holds no threshold and installs no observer.

  ```ts
  nPlusOne({ kind: 'read', subject: 'members.findById', count: 50, entity: 'members', op: 'findById' });
  // X_N_PLUS_ONE_QUERY: a read repeated once per row
  //   cause: members.findById ran 50 times in one request — one read per row
  //   fix:   db.posts.preload('author')   # one statement for the whole page
  ```

  The relation in that `fix` is **derived, never invented**: `preloadsFor(entity, op)` reads the same `relationMap()` `preload()` resolves against, so the pasted line resolves against the schema that produced the loop. The operation picks the side — a point lookup per row is the `belongsTo` edge (`posts.preload('author')`), a filtered read per row the `hasMany` edge (`posts.preload('comments')`) — and every other operation falls back to the batched form of the statement that repeated, `db.members.andWhere('id', 'in', ids).all()`. Edges are read by their `to` end, because the loop repeated on the entity being *looked up* and the ledger only ever saw the statement, never the `for … of` above it: two entities may both reference it, so both pages are named, the first pasteable and the rest after it, exactly as `X_PRELOAD_UNKNOWN_RELATION` spells its names. A write loop names the bulk form of the same call — `insertAll(rows)`, `updateWhere(filter, patch)`, `deleteWhere(filter)`, and both of the first two when the operation has no single bulk form of its own — and hand-written SQL, which is attributed to no entity, names the statement's own `any($1)` form instead of a chain that does not exist.

  A schema whose relations cannot be named still reports the loop it was asked about: `relationMap()` throws `X_INVARIANT_VIOLATED` on two foreign keys it cannot tell apart, and a diagnostic that let that escape would replace the N+1 with a schema complaint the loop did not cause — in a dev process, as an uncaught throw — so the derivation falls back to the `in` form. Neither code is ever thrown and neither carries a flag to turn the warning off: `expectedQueryLoop(reason, fn)` from `@ultimat3/db` is the one way to declare a loop deliberate, and it silences the count upstream of the error rather than answering it.

- **A loop in `x dev` reaches four surfaces, and no surface counts a second time.** The ledger's verdicts now arrive wherever a diagnostic is already read, through the channels that already existed:

  | Surface | What it shows |
  |---|---|
  | `x dev` findings | the verdict as a `Finding`, located by request id — text and `--json` render it for free |
  | `/_x/timeline` | `nPlusOne`, the loops of the request on screen, beside the flame that drew them |
  | the browser overlay | the same code/cause/fix under the error, on the page the author is looking at |
  | the log | one `logger.warn` per request per code, carrying `requestId`/`traceId` automatically |

  **One detector, four renderers.** `statement-loop.ts` in `@ultimat3/cli` is the single projection: it hands a verdict to `nPlusOne()` and every surface reads what comes back, so the `fix:` the timeline prints is the `fix:` the terminal prints is the `fix:` in the log. The count is read when a surface asks, not frozen at promotion — a loop of fifty reads `ran 50 times` — while the log line names the count at the moment the threshold was crossed, because that is when it was emitted.

  The timeline keeps **two** fields on purpose. `repeatedSql` stays what it was, a measurement over the recorded trace: every SQL text that appeared twice. `nPlusOne` is the verdict, counted per request with attribution applied and `expectedQueryLoop` honoured. A measurement that started warning would be a second detector — blind to a declared loop, grouping fifty point lookups by their bind values — disagreeing with the one whose `fix:` an author pastes. A host that installed no ledger gets `null` there, never `[]`: "nobody counted" is not "this request was clean".

  New seam, dev-only: `ServerHooks.devNotices` in `@ultimat3/http`, called **inside** the `config.dev && wantsOverlay` branch and nowhere else, so a production process and an agent asking for `problem+json` never pay for it. `OverlayNotice` is declared structurally there for the reason `AuthzDecision` is — tier 2 can never import the package that owns the codes. `x dev` is the only host that supplies one; `serve.ts` boots through the same `startRoles` and passes nothing.

- **`statements` — the fixture that fails a test on its own N+1.** A warning in a dev server is a warning nobody is looking at during CI. Destructuring `statements` installs the detector in **throw** mode for the length of one test, and the loop's fifth statement rejects where it was issued:

  ```ts
  import { expect, test } from '@ultimat3/testing';

  test('the feed reads its authors once', async ({ statements }) => {
    await renderFeed();                              // a per-row findById throws here:
    //   X_N_PLUS_ONE_QUERY: members.findById ran 5 times in one request — one read per row
    //   fix: db.posts.preload('author')   # one statement for the whole page
    expect(statements.count('posts.findMany')).toBe(1);
  });
  ```

  Opting in is naming it: a fixture nobody destructures is a fixture nobody built, so there is no `strict: true` to remember and no suite-wide switch to forget. The threshold is `N_PLUS_ONE_THRESHOLD` from `@ultimat3/entity` — the same number `x dev` warns at, now exported, because a loop that fails a test and a loop that warns in dev have to be the same loop — and the error is `nPlusOne()`'s, so the `fix:` names the `preload()` the schema's own relations spell.

  Two differences from the dev ledger, both deliberate. **The unit of work is the test, not the request**: the ledger keys its tally on the `Ctx` object and ignores a statement issued outside a request, and a unit test calling `posts.findById(id)` with no request anywhere is exactly the loop it was written to catch. **It throws once per shape and keeps counting**, so a test that catches the error gets one failure at the statement that crossed the threshold rather than one per statement after it — and `statements.all()`, `.count(fingerprint?)` and `.shapes()` still measure the whole loop, expected statements included. `expectedQueryLoop(reason, fn)` remains the one way to declare a loop deliberate: it suppresses the verdict, never the measurement. The seam is handed back on disposal like `network` and `runJobs` — the observer that was installed before, not a fixed default.

- **`statementFingerprint()`, `statementKind()` and `statementVerb()` from `@ultimat3/db`.** What shape a statement is — `entity.op` when attributed, its own whitespace-collapsed text when not; read or write from the leading verb — is now one rule next to the `StatementEvent` it reads, rather than a copy per detector. `x dev`'s ledger and the `statements` fixture group by the same identity by construction, and `statementSpanName` reads its verb from the same scanner.

### Fixed

- **`x db migrate` verifies the database it just migrated — the third engine split, closed.**
  `checkDrift` existed twice under one name and one `X_DB_DRIFT`. `@ultimat3/db`'s read the ledger,
  introspected the live catalog and diffed the two — and had **zero callers anywhere**.
  `@ultimat3/cli`'s hashes the entity source against what `x db gen` recorded, never opens a
  database, and was the one wired into `x verify`, `x doctor` and `x db migrate`. So the comment on
  `x db migrate` promising "a schema that migrated cleanly and still disagrees is the failure this
  command exists to surface" described a check that reads files and answers the same before and
  after a migration: a column added by hand was invisible on every path the framework ships.

  `@ultimat3/db`'s `checkDrift()` is now **the post-migrate verification**, and it runs where a
  connection is open: `runMigrations` calls it inside the queue's lifetime and returns it on
  `MigratedApp.drift`, so `x db migrate`, `x db reset` and `ROLE=migrate` verify one post-condition
  through one call, the way they already apply migrations through one. `x db migrate` renders each
  difference through `driftError` — the pinned three-line `X_DB_DRIFT` output, never a second copy
  — and exits non-zero; a `ROLE=migrate` container logs the first difference and still exits 0,
  because its contract is "apply every migration, then exit" and a diagnostic after a clean apply
  is not a failed migration.

  It could not have run before: `x_migrations`, `x_jobs`, `x_job_steps`, `x_outbox` and every
  `@ultimat3/auth` table are `create table if not exists` at boot, declared by no migration and
  carried in no snapshot, so a correct database reported eight `unexpected-table` findings. New
  `appTables()` / `FRAMEWORK_TABLE_PREFIX` in `@ultimat3/db` drop the whole `x_` namespace before
  the diff — a prefix, so a table a future package adds needs no second list. `introspect()` keeps
  its narrower exclusion, because the admin schema view and MCP's `schema.describe` legitimately
  show `x_users`.

  The source check keeps its job and loses the collided name (see *Changed*): it stays `x verify`'s
  `drift` step and `x doctor`'s probe, where no database exists to open, and is no longer repeated
  on `x db migrate`. One condition, one reporter, each. `packages/cli/src/drift.ts` also gains the
  test file it never had — eight tests over a check that has been failing builds since 1.0.0.

- **`x db gen|migrate|reset` run the framework's own migration engine — there is no second one.**
  All three shelled out to `bunx drizzle-kit`, and `x db studio` to `bunx drizzle-kit studio`.
  drizzle-kit is declared in **no** `package.json` in this repo and is not installed, so `bunx`
  network-fetched an unpinned version at run time — a supply-chain surface, and the reason a
  scaffolded app's very first documented command (`bin/setup` → `x db migrate`) exited
  `X_DB_MIGRATE_FAILED` on *drizzle.config.json file does not exist*. Worse than broken: two
  engines with two journals for the same question, while `ROLE=migrate` already applied migrations
  through `@ultimat3/db`'s ledger.

  `x db gen` now calls `generateMigration()`, and `x db migrate` / `x db reset` call `serve.ts`'s
  own `runMigrations` — literally the function `ROLE=migrate` runs. A laptop, CI, staging and
  production share one `x_migrations` ledger, one checksum rule and one advisory lock. The MCP
  `db.migrate` tool joins them; it kept a fifth shell-out and a third hand-rolled scanner of
  "which migrations exist", both now the framework's own `readMigrations` + `pendingMigrations`.

  `x db gen` opens no database at all: it diffs the app's entities against the schema the newest
  migration **declares**, and writes that schema beside the SQL as `<id>.snapshot.json` so the next
  generation is incremental. `declaredSchema()` is new in `@ultimat3/db` and `expectedSchema()` is
  now defined over it, so generation and drift can never read one snapshot two ways. `--allow-destructive`
  is now a real flag, because `X_MIGRATION_IRREVERSIBLE`'s own `fix:` line has always named it and
  the parser used to refuse it.

  `x db studio` moves to the planned table (`PLANNED_SUBCOMMANDS`, new): `X_NOT_IMPLEMENTED` with
  `x dev   # then the db panel at /_x`. One subcommand does not earn a second schema engine.
  `X_DB_STUDIO_FAILED` is now reserved and never thrown, like `X_MIGRATE_CONCURRENT`.

  Two smaller fixes ride along. `readMigrations` skipped nothing, so a hand-written pre-1.2.0
  `<id>.down.sql` beside its `<id>.sql` was read as a migration named `<id>.down` and would have
  **dropped every table it exists to reverse** — it is now never applied, and the reference app's
  own migration is one file with a `-- down` marker like every generated one. And `packages/db/migrations`
  was spelled in two places that had to agree; it is one constant now, in the module that reads it.

- **A migration `up` holding two statements applies — on both drivers.** `migrate()` sent the whole
  script through one `tx.execute(raw(migration.up))`, and the two drivers disagreed about what that
  means. PGlite's `query()` is the extended protocol always, so it refused the send outright:
  *cannot insert multiple commands into a prepared statement*. Bun.SQL degrades to the simple
  protocol whenever the text carries no bound value, so against a server the same script happened to
  apply — until it carried one, and never by contract. The embedded driver is the one `x dev` and
  `x db branch` run on, and `createTable` emits the table **and** every index it carries, so an
  entity with one index generated a migration the local database could not apply. The documented
  workaround was one statement per file.

  `migrate()` and `rollback()` now split the script and send one statement at a time, inside the
  **same** transaction: a half-applied migration is worse than an unapplied one. Splitting is
  `statementsOf()` (`@ultimat3/db`), and it is a scan, not a `split(';')` — a `;` inside a string
  literal, a quoted identifier, a dollar-quoted body, a `--` comment or a **nested** block comment is
  data, and a generated migration holds all five, including the `-- backfill "c", then: … set not
  null;` note written for a NOT NULL column added to a populated table. A chunk of whitespace and
  comments alone is dropped rather than sent as an empty query, so a no-op `up` reaches its ledger
  row instead of failing on nothing. The seven copies of this rule hand-rolled across
  `@ultimat3/entity`'s and `@ultimat3/ai`'s live tests are gone — they import the one migrations use.
  Pinned where it actually broke: `pglite-embedded.test.ts` applies a table-plus-index `up` against
  the real embedded database and reverses it, and `migrate.live.test.ts` does the same against a
  real server.

- **A composite index reaches the generated migration whole.** `EntityDescription.indexes` carried
  index *names* and `parseIndexName` recovered the column list back out of one, so
  `indexes: [{ on: ['orgId', 'createdAt'] }]` emitted
  `create index "todos_org_id_created_at_idx" on "todos" ("org_id_created_at")` — one column that
  does not exist, `42703`, and a migration nobody can apply. The convention that builds the name
  joins with `_` and does not run backwards: two columns and one column called `org_id_created_at`
  are the same string. `IndexDescription` now carries `columns`, `unique`, `where` and `order`, and
  the generator spells every part of them — so a **partial** index keeps its predicate (emitted as
  a total one, it refused rows the entity allows) and a `desc` index keeps its direction.
  `parseIndexName`/`ParsedIndex` are gone; nothing derives an index from a string any more.
  Composite unique indexes are what `upsertAll`'s `on conflict` is inferred against, so
  `packages/entity/src/pg-driver-bulk.live.test.ts` no longer creates its own by hand — it asserts
  the generated migration carries it. An index over no columns is `X_INVARIANT` at `entity()`
  rather than DDL Postgres cannot parse.

- **The `/_x` DB panel's read-only guard read a comment marker inside a quoted identifier as a
  comment.** `select 1 as "--"; delete from members` blanked from the `--` onward, so the scan saw
  `select 1 as "`, called it a read, and handed the whole string to Postgres — which ran both
  statements. The passes could not be ordered correctly, because each opaque form can contain
  another's opener: blanking comments first eats the `--` inside a string, blanking strings first
  eats the `'` inside a comment. `sanitize()` is now ONE left-to-right alternation over every span
  Postgres reads as opaque text — `'…'`, `"…"`, `$tag$…$tag$`, `--` and block comments — which
  resolves them the way a lexer does: whichever token starts first consumes the rest. An
  unterminated quote matches nothing and leaves the rest of the statement visible to the scan;
  failing open there would be the same bypass by another route.

- **`/_x/live` reported every subscriber-lookup failure as "no sync node".** A bare `catch` around
  `sources.subscribers()` folded an authz refusal, a dropped NATS connection and a bug in the
  recorder into `dev.live.no-sync-node` — the note for a tier that was never installed — and threw
  the diagnostic away, telling the reader to wire up something they already had. It now catches
  `DevSourceUnavailableError` and nothing wider; everything else reaches `panelPayload`, which
  renders its code and its fix line.

- **The policy contract test called any coded failure "before its policy decided".** `invoke` runs
  parse input → row → policy → handle → parse output, and every `UltimateError` from any stage
  landed in one branch: an `X_OUTPUT_INVALID` from the parse *after* the handler was reported as
  input drift, with `pass \`input:\`` as the fix — a knob that changes nothing about an output
  schema. Worse, it hid the case the assertion exists to catch: a `policy: allow()` whose handler
  throws was read as drift rather than as an anonymous actor getting through. Only
  `X_INPUT_INVALID` becomes `X_CONTRACT_DRIFT` now; every other code keeps its own code and its own
  fix, the same reasoning that already rethrew a non-`UltimateError` untouched.

- **An unusable `docs` link buried a usable `type`.** `nonEmpty(body['docs'] ?? body['type'])`
  selected on presence, not on being a link, so a problem document carrying `docs:
  'javascript:alert(1)'` alongside a valid HTTPS `type` reached `RemoteActionError` with only the
  unusable one and fell back to the error index. Both now travel in preference order and
  `remoteDocs` takes the first that is an absolute `http(s)` URL.

- **`/_x/live`'s `sql` field was permanently `''`.** `QueryDescriptor` never carried SQL text —
  `defaultDevSources().liveQueries()` read a field the registry does not produce — so every row in
  the live panel printed an empty string forever, not the query it described. It now compiles real
  SQL through `@ultimat3/query`'s `describeSql`, given a sample input via the new `sqlSamples`
  option on `defaultDevSources`; a query with no sample answers `sql: null`, honestly "unknown",
  never an invented `''`. `LiveQueryFact.sql` is `string | null` to say so.

- **`/_x/live`'s "no sync node" note fired for a sync node with zero subscribers.** `panel-live.ts`
  folded "the source is unwired" and "the source answered `[]`" into one empty array, so a live
  tier that was up and running with nobody attached printed `dev.live.no-sync-node` — a different
  and wrong diagnosis. The two are now told apart: an unwired source still degrades to the note,
  a wired one with no subscribers shows an empty list and no note.

- **The `/_x` DB panel's write guard matched a write word inside a string literal.** `assertReadOnly`
  tested `\b(insert|update|…)\b` against the raw SQL text, so `select * from events where kind =
  'create'` was refused as a write statement — a false positive on the exact kind of filtered read
  the panel exists to answer. It also read only `--` line comments, so a `/* … */` block comment
  naming a write word could still trip the same false refusal, or a comment could hide a real one
  past the leading-keyword check. `assertReadOnly` now sanitizes string literals and both comment
  forms (blanking them, not deleting them, so `whe` + `re` never fuses into a new keyword) before
  the keyword scan runs.

- **`ToolRegistry`'s field used TypeScript `private` instead of a real `#` private field**
  (`@ultimat3/mcp`), the one place in `registry.ts` that had drifted from the rest of the package's
  convention — `private` is erased at compile time only, `#tools` is actually inaccessible outside
  the class at runtime.

- **`DevPanel.question` was an English literal sitting beside `titleKey`**, in `panel.ts` and every
  `panel-*.ts` (`@ultimat3/admin`) plus the CLI's two process panels — rendered raw into `/_x`'s
  `<p class="question">` with no `t()` in the path, and `titleKey` itself was declared on every
  panel but never actually read anywhere. Replaced with `questionKey` (`t()`'d the same way
  `titleKey` now is, for the tab label), both following the `dev.panel.<key>.title` /
  `dev.panel.<key>.question` convention the rest of `catalogs/en.json` already uses.

- **A route's `load` swallowed every failure that carried a `code`, and a route that loaded nothing claimed to load anything.** `routeDataFor` rethrew a caught error untouched whenever it was an `Error` with a string `code` — the shape of a framework error, and equally the shape of every `ENOENT`, `ECONNREFUSED` and `ERR_MODULE_NOT_FOUND` a loader can raise. A `load` that read a missing file surfaced Bun's own rejection, with no `X_ROUTE_LOAD_FAILED`, no fix line and no mention of the route an author has to go and fix. The check is now `isUltimateError` from `@ultimat3/core`, which reads the well-known brand: a policy denial or a tier-0 `X_VALIDATION_FAILED` still passes through with its own code, and everything else gets wrapped, as it always should have.

  The second half is the branch above it. With no `load` the context IS the route's data, and it was handed back as `ctx as unknown as TData` — a double cast that let a route declare `meta: ({ data }) => ({ title: data.post.title })`, load nothing, and render `undefined` in a `<title>` on the surface whose entire purpose is SEO. `defineRoute` now takes `RouteDefinition<TData> & LoadRequirement<TData>`: data the context cannot supply requires a `load`, so that route is a compile error, and the fallback narrows to `RouteContext & TData` — checked, not laundered. `RouteContext` is an alias rather than an `interface` for the same reason; only an alias is a `RouteData`. Pinned in `packages/render/src/type-pins.ts`. Routes reading `data.url` / `data.params`, and every route `x new` and `x g route` write, are unaffected.

- **The typed client rebuilt a server's failure as a locally-declared one, and invented the page documenting it.** Any `problem+json` body with a string `code` became a bare `UltimateError` carrying that code plus `docs: https://ultimate.dev/errors/<code>` — a URL synthesized in the browser for a code this bundle never registered. The codes that reach a browser are exactly the ones that need it least: an app's own `X_SIGNUP_CLOSED`, declared through `registerErrorStatus`, printed a `docs:` line pointing at a framework page that does not exist, under a title humanised from the code as if the framework owned it. `typeof code === 'string'` was the only check, so a gateway answering `{"code":""}` produced an error rendering `: `.

  Failures now come back as `RemoteActionError`: the code rides along verbatim — matching on it is the point of `problem+json` — but the error says where it came from, `name` in a stack trace and `meta: { origin: 'remote', action, status }` in `--json`, the dev overlay and the error reporter, with the status also typed as `.status`. The docs link is the server's own when it sent a resolvable `http(s)` one (RFC-9457's `type` counts, `about:blank` and `javascript:` do not), this build's registered link when it knows the code, and otherwise the index — never a per-code page nobody wrote. A body naming no `X_SCREAMING_SNAKE` code is a proxy answering rather than the app, which is what `X_RPC_FAILED` already says.

- **`.job()` was missing from the view the registry hands back.** `listActions()` and `getAction(name)` answer in `AnyAction`, the schema-erased view, and it projected an action to every surface except the queue: `getAction('publishPost')?.job()` was a type error against an object that has carried the method since `facadeFor` bound it. The erased view now declares `job(): ActionJobHandle`, and `Action` narrows it to its own schemas as before. `client()` stays off it and now says why in a build error rather than a comment — a `ClientMethod` is a function type, so its input is contravariant and no erased spelling is assignable from a concrete one. Both halves are pinned in `packages/action/src/type-pins.ts`, source rather than a test, because `tsconfig.json` excludes tests and `tsc` never reads one.

- **`.contract()`'s policy assertion never reached a policy.** The generated `"<action>: policy denies an anonymous actor"` test invoked the action with `{}` and accepted **any** `UltimateError` as proof of a denial. Every action with a required input field — which is every action `x g action` writes, and all three in the reference app — failed `input:` before `guard()` ran, so the assertion passed on `X_INPUT_INVALID` and proved nothing about authz. An action whose policy was `allow()` passed it too.

  The test now sends an input the schema accepts, synthesized from the schema's own IR (required keys only, formats included: `t.uuid` gets a uuid, `t.money` gets minor units and a currency, a nullable field gets `null`), and accepts only an `ActionDeniedError` — the one outcome that means the policy decided. It is the class and not `X_FORBIDDEN`, because a denial carries the policy decision's own code and the blessed `can()` answers a null actor with `X_UNAUTHENTICATED`; pinning one code would fail every action authored the way the framework teaches. Anything else thrown before the policy is `X_CONTRACT_DRIFT` naming the culprit code, with `pass \`input:\` to contractTestsFor(<action>)` as the fix — the new `input` option, for a schema carrying a constraint the IR cannot invert (a bare `pattern`) or a `row:` loader that needs an id which resolves. `contractTestsFor` is unchanged for callers that pass neither.

- **A cache bust that refused failed the write it followed.** `invoke` awaited `invalidateTags()` after the handler had already committed, so a fan-out that refuses outright — `invalidates: [tag.pots]`, or any tag a manifest older than the entity never declared, raising `X_CACHE_TAG_UNKNOWN` — turned a durable write into a failed action, and the caller retried a write that had already happened. The bust now goes through `bustAfterCommit` in `cache-gate.ts`, the one place this package calls `invalidateTags`: the refusal becomes a single `action.invalidate.failed` error line and the stale entries expire by TTL. That is the rule `@ultimat3/cache` already held for one dead tier, now held for a fan-out that never started. A replay busts nothing either — `idempotent: true` plus a repeated `Idempotency-Key` runs no handler, so re-purging the CDN and re-queueing ISR on every retry was work for a write nobody made.

- **An `ack` that failed re-queued a job that had already finished.** `executeJob` settled inside the `try` it ran the body in, so an `ack` rejected by a pool timeout or a reset on that one statement fell into the retry branch: the queue was told the attempt FAILED, `nack` re-delivered work whose side effects outside a step had already happened, and the run was reported as `retried` — a point in `jobs_total{outcome}` for a failure that never occurred. Settlement now lives outside the retry decision. Only the body's own rejection reaches the `catch`; an `ack` that cannot land propagates to the worker, which logs `jobs.worker.settle-failed` and lets the lease lapse, so the queue re-delivers because nobody could say the job ended rather than because it failed.

- **A heartbeat that renewed too LATE hid the lease it lost.** Expiry was decided before the driver was asked, which catches a renewal that hangs or rejects — but a renewal that *succeeds* after the visibility window (an event-loop stall, a driver answering at the end of its connect timeout) then set `renewedAt = now()` and restarted the clock on a lease the queue had already handed to another worker. The one failure shape with nothing to catch is now checked after the `await` as well: a renewal that lands past its own window reports `jobs.lease.lost` and `job_leases_lost_total` instead of silently extending somebody else's lease.

- **`task({ tz: '+02:00' })` was accepted.** The zone check was a local `Intl.DateTimeFormat` probe, and ES2024 `Intl` accepts a numeric offset — the one kind of "zone" that carries no DST rules, which is the entire reason a cron needs a zone. `task()` now validates through `@ultimat3/time`'s `isValidTimeZone`, the same rule the rest of the framework holds dates to: one validator, so a zone `task()` accepts is a zone `@ultimat3/time` can do arithmetic in. `'Bogota'` and `'Not/AZone'` are refused as before.

- **`jobs.scheduler.tick-failed` threw away everything that made the failure actionable.** The round's catch logged `error.message` only, so an `UltimateError` reaching it lost the stable code an operator searches on and the `fix:` they run. The log line now carries `code`, `cause` and `fix` when the failure has them, and is unchanged for a plain `Error`.

- **`X_ABORTED` said `no action needed`.** A `fix:` line an agent cannot act on is a defect in the error (axiom 4), and both throw sites — `@ultimat3/core`'s `throwIfAborted` and `@ultimat3/jobs`' `JobAbortedError` — said exactly that. Both now name the call: `add throwIfAborted(ctx) before expensive work, or pass fetch(url, { signal: ctx.signal })`. The wiki row matches.

- **The `job` verify gate step was a silent no-op.** `packages/jobs` — the package the suffix names — shipped zero `*.job.test.ts` files, so `x verify`'s `job` step (step-replay, idempotency-dedupe, outbox-atomicity, per its own summary line) always reported green with nothing run, and none of the package's 12+ unit test files ever called a worker's real `start()`/`stop()` — every prior test drove the loop by hand through `tick()`. Four new opt-in suites close it: `replay.job.test.ts` proves a completed step survives both a real retry and a real suspend/resume without re-running, over an actual polling worker; `idempotency.job.test.ts` proves two enqueues racing on one key collapse to a single row that a real worker (even three contending) runs exactly once, and that the dedupe window is "currently live" rather than "ever existed"; `outbox-atomicity.job.test.ts` follows a staged row past the queue boundary the existing `outbox.test.ts` stops at, through to a real worker, proving a rollback never reaches one and a relay that republishes after a crash still yields one execution; `worker-soak.job.test.ts` runs several real workers against one shared driver with one killed mid-job (its queue connection severed, never a clean `stop()`) and asserts every job still reaches a terminal state — no orphan — with the actual unit of work behind it executed exactly once — no double-execution.

- **The scheduler dispatched a tick it was already dispatching.** `start()` guarded a second `start()`, never a second tick: the loop was a `setInterval` at the tick interval, so a round slower than one second — a task with twenty entries, a `run-all` catch-up after downtime, a queue under load — had the timer open a second round while the first was still enqueueing. Both read the same `lastFiredAt`, both walked the same occurrences and both dispatched them. The occurrence-scoped idempotency key deduped the jobs, which is exactly why nobody saw it: what was left was a re-marked watermark, occurrences reported as dispatched that were never enqueued, and a catch-up sequence interleaved with itself.

  The loop now re-arms on the round it just finished, so the interval is the **gap between rounds** rather than a fixed period, and every other caller of `tick()` joins the round in flight instead of opening a second one. Cron accuracy pays nothing for it: an occurrence is computed from the clock, not from tick counts.

- **`stop()` released the leader lock out from under a live dispatch.** It cleared the timer and released immediately, without waiting for the round it was racing — so a standby promoted while this node was still enqueueing an occurrence's jobs, and both then owned it. The advisory lock exists to make that impossible; releasing mid-dispatch handed it away. `stop()` now stops dispatching, waits out the round in flight and only then releases, and the round re-reads the drain state before each task, so a stop between two tasks means stop now rather than at the next round. A task not reached keeps its `lastFiredAt` untouched, so the next leader owes it.

- **The scheduler registered no shutdown hook at all.** `onShutdown` was not imported: on SIGTERM the lock was held until the lease expired, and any occurrence mid-dispatch was abandoned wherever the process died. It now registers one hook at the `accept` phase, exactly as the worker does — one while it runs, handed back in the teardown's `finally`, so a `release()` that threw still gives it up and a start → stop → start cycle holds one rather than one per start. `drainOnShutdown: false` opts out.

- **`catchUp: 'skip'` was documented as waiting for the next occurrence.** It never did: it fires the latest missed one and drops the older ones (`'run-once'` fires the earliest missed one instead). The code was right and shipped that way — the comment, the README and `wiki/Scheduled-Tasks.md` were wrong.

- **A lost lease was the quietest bug a queue can have.** The worker's heartbeat ended in `.catch(() => undefined)`, so a renewal that stopped landing — a connection reset, a pool exhausted, a Postgres failover — produced nothing at all: no line, no series, no signal. The visibility timeout then expired under a job that was still running, the queue handed it to the next worker that claimed, and the only evidence was a job that ran twice for reasons nobody could reconstruct.

  A renewal now decides between two different facts. **One failed renewal is not a lost lease** — there is a whole visibility window left and, at the default interval, three tries inside it — so it logs `jobs.heartbeat.failed` at `warn` and nothing more. **A window that passes with no renewal landing is a lost lease**: `jobs.lease.lost` at `error`, with the job, the queue and the attempt, plus one point on the new `job_leases_lost_total{queue}` counter. Every point on that series is one job that ran twice, which is why it is a series of its own and not an outcome on `jobs_total`.

  The window is measured on the worker's own clock from the last renewal that **landed**, not on `claimed.visibleAt` — that timestamp comes from the driver's clock, and comparing the two would make every lease decision a function of clock skew. Two failure modes fall out of it that a rejection-only check could never see: a heartbeat hung on a dead connection (it neither resolves nor rejects, so expiry is checked before the driver is asked), and a renewal that lands long after the window is gone (a late success is not a lease — the job belongs to another worker now, and renewing would extend theirs).

- **One slow job froze the whole worker.** A claim pass ended on `Promise.allSettled([...inFlight])` — every job the process held, across every queue — so nothing was claimed again until the slowest member of the batch finished. A `concurrency: 10` pool ran the ten it started and then sat idle behind one long job; a second queue was not asked at all.

  The claim loop now re-arms on the **pass**, not on the jobs. A slot belongs to its own job and is free the moment that job settles, so the next poll refills exactly that slot and every other queue keeps being served. `worker.tick()` still resolves with the executions **that pass** started, so tests read unchanged; a saturated queue still costs zero driver calls, because free slots are counted before anything is claimed.

- **A job that could not be settled with its driver vanished.** `allSettled` swallowed the rejection, so an `ack` that failed on a closed connection left no trace anywhere. It is now `jobs.worker.settle-failed` at `error` — and, since nothing else awaits those promises any more, the one place a job's failure is observed at all.

- **A job that hit its `timeout` kept running beside its own retry.** The deadline rejected the attempt and nothing told the body about it: the rejection nacked the job, the queue handed it to the next worker that claimed, and the original handler carried on — two copies of one job, in one process or two, both writing steps into the same `runId`. The one thing that had to happen first — telling the body to stop — never happened at all.

  A deadline is now a **cancellation**, in that order: cancel, then fail the attempt. The signal is `ctx.signal`, the seam an action body already reads, so nothing jobs-only has to be learned:

  ```ts
  run: async ({ input, ctx, step }) => {
    // Aborted at the job's `timeout`, and also when the caller's own ctx goes away.
    const res = await fetch(url, { signal: ctx.signal });
    throwIfAborted(ctx); // or check ctx.signal.aborted in a long loop
    await step.run('save', (signal) => save(res, { signal }));
  },
  ```

  Three rules fall out of it:

  - **A cancelled attempt writes no steps.** Nothing in JS can kill a body that ignores a signal, so the durable state is fenced instead: past the cancel, `step.run`, `step.sleep` and `step.waitForEvent` refuse to write and raise `X_ABORTED`. A late `completed` would hand the attempt that replaced this one a step it never ran; a late `failed` would erase one it did. The refusal is what unwinds an uncooperative body, and it is one guard on one write path, not a check per call site.
  - **`step.run`'s callback receives an `AbortSignal`** — the run's cancellation and that step's own `stepTimeoutMs` ceiling composed, so a body reads one signal and sees whichever deadline lands first. Purely additive: every zero-argument `() => …` callback already written is unchanged. The per-step timeout aborts before it rejects too, same order and same reason.
  - **A body that runs past its deadline is named.** `jobs.timeout.abandoned` logs at `warn` with the job and how it ended, which is how an app finds the handler that never reads `ctx.signal`. A body that stopped *because* it was cancelled is the intended end and stays quiet.

  `executeJob` moved to `packages/jobs/src/execute.ts` — same export from `@ultimat3/jobs`, and `worker.ts` is back under the file-size ceiling it was one line from.

- **The jobs worker's drain closed the queue connection under a job it had just claimed.** `tick()` read the drain flag on entry and never again, so a round that got past that read kept going: it was still awaiting `driver.claim()`, and the jobs it started joined `inFlight` *after* `stop()` had already snapshotted that set. The snapshot was empty, the drain concluded there was nothing to wait for, and `driver.close()` ran with a handler mid-flight — the ack never lands, the lease expires, and the queue hands the job to the next worker that claims. That is the "always twice" draining exists to prevent, on exactly the deploys where a poll and a SIGTERM land in the same tick.

  `stop()` now waits out the claim round it is racing before it waits on the jobs. A round registers itself in the same synchronous step as its guard — no await between them — so it is either refused by a drain already under way or visible to every drain that starts after it. Two rules fall out of that:

  - **A round already in flight stops claiming the moment the drain starts.** The state is re-read before each queue rather than once on entry, so a `stop()` landing between two queues is honoured by the round it landed in, not the next one. What that round already holds still runs to the end — that is the drain, and `stop()` waits for it.
  - **A `driver.close()` that throws leaves the worker `'stopped'`.** The state was assigned after the close, so a throwing close pinned it at `'draining'` for the life of the process: `stats()` reported a drain that had already finished, and `start()` — which leaves only `'idle'` or `'stopped'` — refused to run that worker again. It is now set in the same `finally` that hands the shutdown hook back. The failure still reaches the caller, on the promise it awaited.

- **The jobs worker leaked a shutdown hook per `start()`.** `onShutdown` returns an unregister and `createWorker`'s `start()` threw it away, while `stop()` unregistered nothing — so a stopped worker stayed on the process's drain list forever, holding its driver, its in-flight set and the whole worker closure alive. The `start()` guard read `'running'`, so start → stop → start stacked a second registration on the first, and every later drain called all of them. `@ultimat3/realtime`'s `listenSyncNode` and `@ultimat3/http`'s `server.ts` already kept theirs; the worker now does too, released in a `finally` so a `driver.close()` that throws still hands it back.

  Two rules fall out of making the registration single:

  - **`start()` only starts from a standstill.** It used to restart mid-drain, putting the claim loop back on a driver the drain was about to close — and stacking a hook on the one still running, which is the leak again by another route.
  - **`stop()` is one teardown, joined.** A SIGTERM landing on a manual stop used to run the whole drain a second time and close the driver underneath it. Concurrent callers now await the same promise, which is cleared as it settles so a worker that started again tears down again rather than joining a promise that settled a lifetime ago.

  `@ultimat3/core` exports a test-only `shutdownHookCount()` — the same shape as `idleWaiterCount()` — so "one hook while it runs, none once it has stopped" is assertable rather than asserted in prose.

- **`LiveClient` never reconnected.** `#scheduleReconnect` computed the delay, incremented the attempt counter and published `reconnectAt` — and armed nothing. No `setTimeout`, no call to `connect()` from any close path; `reconnectAt` was read in exactly one place, `useConnection()`, to render a countdown that then expired and sat there. A client that lost its socket stayed offline until the app called `connect()` itself, which meant every deploy, every idle timeout and every dropped Wi-Fi packet ended the session. `drainPlan()`, the `reconnect` frame and `AcceptBudget` — the three mechanisms that spread a reconnect herd — were spreading clients that were never coming back.

  The timer is now armed by the same method, through an injected `Scheduler` (`(fn, ms) => cancel`) defaulting to `timeoutScheduler`, so the reconnect is provable without sleeping. Four consequences fall out of making it real:

  - **`onClose` drops the socket reference, and speaks only for its own socket.** `#send` is fire-and-forget, so a retained dead socket turned every later frame into a silent no-op the caller believed had landed. And a socket `connect()` had already replaced could close later and take the live connection down with it — offline, every subscription `offline`, a backoff armed against a healthy socket — so the handler returns before touching any state when `#socket` is no longer the socket that closed. `close()` reports its own subscriptions offline as a result: the close it triggers is now one of the events that returns.
  - **A server-assigned delay survives the close it triggers.** A `reconnect` frame arms the node's slot *before* closing, and `onClose` only schedules when nothing is armed — otherwise the delay `drainPlan()` computed for this socket was immediately overwritten by a local backoff, re-clustering the herd the node had just spread.
  - **A dial that throws arms the next attempt, and is reported rather than rethrown.** A socket constructor is allowed to refuse — mixed content, a URL the page may not open — and one throw inside the timer would otherwise end the chain as completely as never arming it did. Nothing awaits a timer, so a throw out of one is `window.onerror` in a tab and an uncaught exception under Bun that can kill the very process that was about to retry. The failure goes to the new `LiveClientOptions.onError` seam instead, defaulting to `console.error` — never `@ultimat3/core`'s `logger`, whose writer is `process.stderr` and this is browser code. A `connect()` the app called itself is still the app's to handle, still throws to it, and still arms nothing.
  - **`LiveClient.close(code?, reason?)` is new**: cancels the armed reconnect and drops the socket, so a client whose owner is gone stops dialling. `connect()` starts over — it is a stop, not a tombstone.

  ```ts
  const client = new LiveClient({ signal: createSignal, connect, buildId });
  client.connect();
  // socket drops → reconnectAt renders the countdown → and now the client actually dials again
  client.close();   // …and this is how you make it stop
  ```

- **A live gate that could not decide reported "denied". Rows left the screen and nothing paged anyone.** `visibleWithPolicy` in `@ultimat3/realtime` wrapped its `guard` call in `catch { return false }`, so a rule whose repo lookup timed out, a predicate with a typo in it and a genuine policy denial were one answer. The subscriber's rows were dropped, `live.rows_denied` counted the drop — the metric that exists precisely so a drop is never invisible — and the node published a database outage as a permission change. `reauthorize` had the mirror-image bug: any throw from `authorize` **destroyed** the subscription, so one pool timeout during a login told the client it may no longer see a query it is still entitled to, and a client does not resubscribe to a denial.

  A denial is now the only thing read as one. `guard` throws `QueryDeniedError` for a decision and nothing else, so the row gate matches that class and rethrows everything else; the registry's gates ask `isPolicyDenial(error)`, because `LiveQueryDefinition.authorize` and `.visible` are caller-supplied functions and the question has to be asked of the error's code (`X_FORBIDDEN`, `X_UNAUTHENTICATED`) rather than of a class this package could import. What each surface then costs:

  | Where | Denial | Failure |
  |---|---|---|
  | `subscribe` snapshot | row dropped, `rowsDenied` + 1 | raises out of `subscribe` — a snapshot missing the rows nobody could decide about is a short result set the client renders as the whole one |
  | `deliver` patch | row dropped, or a `delete` if the subscriber holds it | that **one** subscriber is marked desynced and re-snapshotted on the next flush; the fanout to everyone else completes |
  | `reauthorize` | unsubscribed, sid returned in `dropped` | subscription **survives**, desynced — the row gate still decides every row under the new actor, from the same policy `authorize` consults |

  A third answer joins them, and it is neither: **a patch whose row the shared window does not hold is withheld.** An update patch carries the changed columns plus the id — never the whole row — so merging it onto nothing and calling the result a row hands `visible` an `undefined` for every column the change did not touch. That fails closed for `row.ownerId === actor.id` and leaks for every `!row.private`. The window *is* the result set, so a row it does not hold is one this subscriber may not keep: the patch is dropped, or converted to the one `delete` that tells a subscriber holding it so. Nothing decided anything, so it counts as neither `rowsDenied` nor `gateFailures`. The single path that could have met an empty window — a delta resume onto an entry nothing has read yet — fills the window first, and only then, so a restart storm resuming onto live entries still pays nothing.

  `LiveQueryRegistry` gains a second counter, `gateFailures` (`live.gate_failed`), and an `onGateFailed` callback carrying the qid, sid, actor, stage (`authorize` | `snapshot` | `patch`), row id and the error unwrapped. It is deliberately not folded into `onRowDenied`: an alert fires on one of them and a dashboard that summed them would show a permission change. `reauthorize` still returns the dropped sids and they are now denials only, so a caller may tell the client "you may no longer see this" and be right. The per-subscriber pass moved to `packages/realtime/src/subscriber-gate.ts`; `policy-gate.ts` remains the package's only authz seam.

- **Two changes off the bus raced each other through one live query, and the loser's patch landed last.** Nothing ordered `deliver`: the `sync` node fires `void registry.deliver(change)` from its bus subscription — it has to, the handler must return before the next change arrives — while `deliver` itself mutated the shared window and then awaited a policy pass per subscriber. Two changes back to back both started. A subscriber whose gate answered quickly for the second change was handed lsn 2 and then asked to fold lsn 1 on top of it: the row settled at the *older* value and stayed there, and its cursor was rewound to lsn 1, so the next reconnect replayed the same patch again. Nothing logged it. On top of that, every cold subscribe re-read the query and wrote the result straight over the shared window — N subscribers on one query id were N reads, and a read that resolved after a change had already been fanned out silently rewound the window to rows the fanout had moved past.

  Each query id now has one FIFO lane (`packages/realtime/src/window-lock.ts`) and every fanout takes its turn in it. Across query ids nothing is ordered and nothing needs to be — a qid pins the query *and* its input. `deliver` *enters* every lane before it awaits any of them, and no fanout ever takes a second lane, so holding all of them at once cannot be a cycle — and two deliveries queue onto each query id in call order, which is what makes "serialized per query id, not per node" a claim rather than a hope. Each task chains on a settled shadow of the one before it, so a fanout that threw rejects its own caller and not the changes queued behind it.

  A lane that fails costs one query id and no more. `deliver` awaits the lanes with `allSettled`, so one rejection neither cancels the others nor goes unhandled: every other query id still sees the change, the failed entry's own subscribers are marked desynced — the window advanced under a fanout that did not finish, so they hold a cursor below the change and no later flush would have corrected them — and the first failure still reaches the caller. Awaiting one entry before entering the next was two bugs in one line: one slow policy pass set the whole node's pace, and a throw ended the loop, so every entry behind it silently missed the change with nobody desynced. That is the divergence `markDesynced` exists to prevent.

  The read is now once per entry: a cold subscriber arriving while another's read is in flight joins it and runs its own policy pass over the result — the read is shared, the authz is not. It stays a share and not a cache, cleared as it settles, so a subscriber arriving later still reads current rows. Its result is assigned in the lane and only ever forwards; a snapshot that resolved behind the fanout is discarded and its caller served from the newer window, because writing it back hands that subscriber stale rows at a cursor behind the change that would have corrected them.

  The `sync` node's fire-and-forget call site is guarded too: a fanout that fails now logs `live.deliver failed` and is reported, where before it was an unhandled rejection — the one outage whose only symptom is a dead process.

- **A typo in a live query's name told the client to rebuild itself, and the shared window was compiled twice.** Two defects on one path, both of them a second thing pretending to be the first.

  `subscribe` answered a name it had never registered with `X_PROTOCOL_VERSION` — *"client and sync node disagree on the wire protocol"*, fix `x build && redeploy the client`. The frame had parsed and the version had matched; one string in it named nothing. So the instruction was the only one that cannot work: a rebuilt client spells the typo the same way, and the registry that would have shown the mismatch never gets opened. `X_LIVE_QUERY_UNKNOWN` is new, its fix is `x queries list --json`, and it is a client fault — an unknown name never pages anyone. The name the client sent is echoed back and the registry is not: a socket walking `a`…`zz` is not entitled to a list of every read the app declares.

  ```text
  X_PROTOCOL_VERSION  no live query registered as "liveFed" — client and server manifests differ
    fix: x build && redeploy the client            # before — rebuilds the same typo

  X_LIVE_QUERY_UNKNOWN  no live query is registered as "liveFed" on this node — subscribe under
                        a name the registry prints, or pass the query to defineApi({ queries })
    fix: x queries list --json                     # after — a command, and only a command
  ```

  Underneath it, `liveQueryDefinition` built the same `(query, input)` twice per query id: once through `target.live()` for the shape, the dependency set and the matcher, and once more through a subject-less `sourceFor` because `LiveQuery` described the read but could not run it. Two parses, two `sql()` calls, and — the part that is not merely waste — two descriptions of one read that agreed only by luck. Where a declaration's `sql()` is not a pure function of its input, the subscriber was served the *second* build's rows while the matcher patching them belonged to the first. `LiveQuery` gains `execute()`, the source it was already built from, run; the shared window reads through it, and one build now serves both halves.

- **A replicator whose stream ended kept reporting itself live, and a drained `sync` node kept consuming the bus.** Two leaks of the same shape in `@ultimat3/realtime`: the thing that stopped never released what it held.

  `PgReplicationStream`'s pump had two exits and neither finished the job. On a throw it recorded `stats().failure` and cleared the confirm timer, but left `#connection` set and its socket open — so the next `start()` overwrote the field and orphaned a walsender connection holding the slot `active`. On a *clean* exit — `nextCopyData()` returning `undefined`, which is the walsender ending the copy, a dropped slot or a server shutting down — it returned from the loop and touched nothing at all: `#running` stayed `true`, so `failure` stayed `null` for a loop that reads no WAL, `/readyz` answered ready, `start()` was a silent no-op, and the confirm timer went on telling the walsender a dead stream was keeping up. Both exits now run one teardown (`#die`) that records the failure, stops the timer, and closes and drops the connection; a `start()` that goes live clears the previous death, and `stop()` waits for a pump that is still going down rather than reporting a released slot to the supervisor about to start the next process.

  Two more ways the same slot leaked, both closed here. **A restart waits for the previous pump's terminal cleanup, because `#pump` *is* that cleanup** — `#drain` awaits `#die` and `#die` awaits `connection.close()`, but `#die` clears `#running` and nulls `#connection` *before* that close settles, so a `start()` that only checked `#running` dialled into a slot the dead walsender still owned and replaced `#pump` with its own; the next `stop()` then awaited only the new pump and reported a slot that was still `active`. `start()` now takes the old pump and awaits it before it dials anything, and its failure path swallows `stop()`'s own failure on purpose: the boot diagnosis is the one an operator can act on, and a teardown that also failed must not replace it. **And a `stop()` releases everything before it reports anything** — a `#confirm` or an `endCopy` that threw used to skip the close and the pump await entirely, so the socket leaked and the failure reached a supervisor that was already starting the next process. Every step now runs whatever the step before it did, and the first failure is rethrown only once the connection is closed and the pump has ended.

  `createSyncNode`'s `drain()` closes the hub and evicts every socket — it is terminal — but released neither the change-bus subscription nor the presence sweep interval; only `stop()` did, and `stop()` is not required to follow. A drained node went on pulling every change off the bus into a fanout with no sockets left, and sweeping presence for a fleet it had already left, through a hub `drain()` had closed. Both are now released by whichever of the two runs first, and running it twice is a no-op — `listenSyncNode` calls both, in that order.

- **Docs: a read's cache key does not include the actor, and six pages said it did.** "Cache keys always include the actor's tenant and policy scope, so a cache hit can never leak across tenants" was a guarantee an app could have designed around. `cacheKeyFor` in `@ultimat3/query` is `query:<name>:<parsed-input fingerprint>:<sorted tag keys>` and has never carried the actor. The rule that actually holds: the tenant reaches the key through the read's **input**, so `feed({ orgId })` is one entry per org, and a `cache:` read whose answer varies by actor for one input must not declare `cache:` — tier 1, the request memo, is keyed by `Ctx` identity and already separates it. Policy still runs on every read before a tier is consulted; it decides whether *this* caller may ask, not which rows the entry holds. Corrected in `wiki/Caching-And-Invalidation.md`, `wiki/Queries-And-Live-Queries.md`, `wiki/Entities-And-Migrations.md`, `docs/architecture/01-package-map.md`, `03-request-lifecycle.md` and `06-data-layer.md`; `docs/idea/05-caching.md` keeps the scoped key as the design intent and now names the gap rather than claiming it shipped. No code changed.

- **MCP exposure has one answer, `isMcpExposed`, and the contract stops publishing tools nothing serves.** Six readers across five packages decided `mcp: { expose }` three ways: `=== true` where a tool is actually built (`@ultimat3/action`'s `toMcpTools`, `@ultimat3/query`'s, `@ultimat3/mcp`'s two projections), `!== false` in the OpenAPI operation's `x-ultimate.mcpTool`, and `?? true` in `describeAction`'s manifest fact. So an action with **no `mcp` block at all** was published as a tool by `x.manifest.json` and by `openapi.json`, and refused by every surface an agent could call — and the first honest `mcp: { expose: false }` an author wrote then read as a *withdrawn* capability, which `x verify`'s contract diff classifies as breaking and demands a major version bump for.

  `isMcpExposed(declared)` in `@ultimat3/core` is now the single predicate. Core owns it because the readers span tiers 3–5 and this is the only tier all of them reach — the same reason `timingSafeEqual` lives there. Opt-in is unchanged and unchanged everywhere: an absent block, an omitted `expose` and a literal `false` are one answer.

  ```jsonc
  // an action declaring no mcp block, in openapi.json
  "x-ultimate": { "mcpTool": "publish_post" }   // before — a tool no catalog listed
  "x-ultimate": { "mcpTool": null }             // after
  ```

  `diffManifest` reads both sides through the same predicate, so a manifest parsed off disk whose `mcp.expose` is absent or non-boolean reads as un-exposed rather than as a third state. **Upgrading:** run `x manifest` once — an app whose actions never declared `mcp.expose` will see those facts flip `true → false`, which is the correction, not a withdrawal; re-commit the regenerated file before the next `x verify`.

  `@ultimat3/admin`'s own catalog keeps the opposite default on purpose and says so in code: every tool there is already gated on an admin permission and its CRUD tools carry no `mcp` block at all, so opt-in would list `admin.posts.delete` while hiding the action button beside it. That exception is the only one, and `packages/cli/src/mcp-exposure-pin.test.ts` pins every other reader to one answer.

- **`query.client()` now reaches a route. Reads are served over HTTP, in `x dev` and in a container alike.** `@ultimat3/query` derived `/_x/query/<kebab>` in `naming.ts`, `client.ts` fetched exactly that URL, and nothing anywhere built or mounted a route for it — so every typed read compiled, shipped, and 404'd, while the README and the wiki documented the projection as shipped.

  `toQueryRoute(target)` in `packages/query/src/http.ts` is that projection, mirroring `@ultimat3/action`'s `toRoute`:

  ```ts
  GET /_x/query/live-feed?orgId=…   // the URL liveFeed.client({ baseUrl }) already derived
  ```

  Three decisions it makes, each for a reason a read has and a write does not. The search string is **coerced** at the boundary (`@ultimat3/schema`'s `coerceQuery`, the one HTTP-boundary decoder) and **validated** by `runQuery` — one parser, so a bad `orgId` is the read's own `X_INPUT_INVALID` with the line that prints its schema, never the pipeline's `X_BODY_INVALID`. `meta.input` is therefore absent: the pipeline validates it against a *body*, and a GET has none. The answer is `no-store` — the URL names no actor while the rows are scoped to one — and `enforcedBy: 'handler'`, because `runQuery` is the read's one policy evaluation and it holds the parsed input; an authz stage deciding first would be a second authz system deciding from raw strings.

  `@ultimat3/cli`'s new `apiRoutes()` is what mounts it, and it is now the **one** composition of the app's HTTP API — both `x dev` and `serve.ts` mount it, so a read cannot answer in one and 404 in the other. `@ultimat3/query` gains a dependency on `@ultimat3/http` (tier 3 → tier 2, downward).

- **`useLiveFeed({ orgId })` exists. The typed client hook the wiki has always documented is a projection you can bind.** [Queries and live queries](https://github.com/developerz-ai/ultimate/wiki/Queries-And-Live-Queries) listed a typed client hook among a query's five projections and showed exactly that line; no `useLiveFeed`, `useQuery` or `createLiveQuery` existed in any package. What shipped was `useLive(query, input)` — untyped on both sides, because its `query` parameter is anything carrying a `name`, so neither the input nor the row type could come off the declaration.

  `liveHookFor` (`@ultimat3/realtime`) is the missing projection: one declared `query({ live: true })` bound to one named hook, in one line, with no generated file.

  ```ts
  export const useLiveFeed = liveHookFor(liveFeed);  // app/feed/hooks.ts

  const feed = useLiveFeed({ orgId: actor.orgId });  // feed()[0].title typechecks
  useLiveFeed({ orgIdd: actor.orgId });              // does not compile
  ```

  It **binds** `useLive` rather than re-implementing it — one subscribe path, given the query's name and types, because two of those is two places a subscription can be opened wrong. `LiveQuerySource` names `Query`'s shape structurally instead of importing `@ultimat3/query` as a value: a hook is browser code, and a value import would carry the server's read path into the bundle. The name is read **per call**, never captured at bind time, because a module-level binding runs at import and `registerQueries()` stamps the name at boot — later. Binding a query with no `live: true` is the new `X_QUERY_NOT_SUBSCRIBABLE`, thrown where the binding is written rather than at the first render: a read that never patches has no subscription for a hook to hold, and the non-live read from a component is `query.client({ baseUrl })` over the route above. `LiveRows`'s row parameter widens from the wire's `Row` to `object` so a query's own row type survives; the four type claims are pinned in `packages/realtime/src/type-pins.ts`, which `tsc` checks and a `.test.ts` could not.

- **`X_INPUT_INVALID` is a 400 over HTTP, not a 500.** The code had no row in `error-map.ts`, so it took the 500 default on every surface that throws it — an action route and now a query read alike. A caller's typo'd uuid was answered as a server fault *and* reported to the error monitor by the `error-map` stage, which pages the on-call for someone else's mistake. 400 is also what the published OpenAPI operation has always promised for it.

- **`LruCache.clear()` now resets `hits`/`misses`/`evictions` along with entries and bytes.** `stats()` after a `clear()` used to keep reporting whatever the cache had accumulated before the clear — a fresh cache with stale lifetime counters. `clear()` is a reset, and `stats()` now reads as one.

- **A drain that times out no longer leaks its waiter.** `waitForIdle()` pushed a closure onto `idleWaiters` and relied on the eventual `beginWork()` completion to remove it; a drain that gave up at the deadline resolved its own promise but left that closure in the array forever, to be invoked (harmlessly, but pointlessly) whenever in-flight work eventually finished. The timeout branch now removes its own waiter. `@ultimat3/core` exports a test-only `idleWaiterCount()` so this stays provable.

- **A storage disk's `get()`/`list()` now return the `cacheControl`/`metadata` a `put()` wrote.** `StorageObject` gained optional `cacheControl`/`metadata` fields, and the local driver's sidecar parser — which validated only `contentType`/`etag` — now preserves both, closing the round trip `packages/storage/CLAUDE.md` already promised ("`get` must round-trip exactly what `put` was handed"). The s3 driver's `list()` still reports `DEFAULT_CONTENT_TYPE` for every entry; that one is commented, not fixed — ListObjectsV2 does not return Content-Type, and reading it for real would cost one HeadObject per listed row.

- **`HttpServer.stop()` no longer leaves its shutdown hooks registered when `drain()` throws.** `unregister()`/`unregisterClose()` ran after `await drain('manual')`, so a rejecting drain skipped both — the next drain in this process would still find and re-run this handle's hooks against a server that already tore down. Both now run in a `finally`.

- **Nine call sites across `entity` and `db` read the ambient wall clock instead of `@ultimat3/core`'s `Clock`.** Column defaults, `onUpdate` stamps, soft-delete writes, and three `now?: Date` fallbacks called `new Date()` directly, in violation of the framework's "only `clock.ts` calls `new Date()`" rule. All now read `systemClock.now()` — a behavior-preserving substitution, not a new injection seam; `now?: Date` overrides are unchanged.

- **A row with a money column can be returned from an action again — `Money` is one declaration, and its `minor` is a `number` everywhere.** The framework carried three structural restatements of one shape: `Money` in `@ultimat3/money`, `MoneyValue` in `@ultimat3/schema`, and a third in `@ultimat3/entity` whose `minor` was a `bigint`. The third was not a stylistic difference. `JSON.stringify` throws on a bigint, so returning a decoded row from an `action`, a `query`, a job payload or an MCP tool result **crashed the response**; `t.money` — the node that becomes the OpenAPI contract — rejected the row this framework's own driver produced; and `@ultimat3/realtime` normalised the *same column* to a `number`, so two readers of one column disagreed about what it held.

  `number` is the decision, and it is the one every other surface already made: `@ultimat3/money`'s whole arithmetic, allocation and `Intl` surface, `t.money`'s IR, `@ultimat3/ai`'s budgets, `@ultimat3/ui`'s `<Money>`, `@ultimat3/admin`'s widgets, the `x new` scaffold and this repo's own root convention. `@ultimat3/schema` (tier 0 — the only tier every package may import) now owns the single declaration; `Money` and `entity`'s `MoneyValue` are **aliases** of it, so a row a `money()` column decodes *is* a `Money` and goes to `add()`, `formatMoney()` or `<Money>` with no cast.

  What the wide column bought is kept, honestly. `<name>_minor` is still `bigint`, and a stored value past ±2^53 — written by a psql session, a backfill, another service — is now **refused where it is read** (`X_INVARIANT_VIOLATED`, naming the value it could not carry) rather than rounded into the row or carried as a bigint that crashes three layers later. That is the same refusal `@ultimat3/realtime` already made, so the two readers agree.

  Additive on the write side: `MoneyInput` still takes a `bigint | number`, so a minor unit read straight off a `bigint` column reaches an insert with no conversion at the call site. `narrowMoney` is called by **both** drivers — `bindValues` before a statement, `memoryRepo`'s `write` before it stores — so a row's money never depends on which driver produced it; previously the in-memory driver stored the caller's bigint verbatim and produced the one row in the framework `JSON.stringify` refused.

  `Money.minor` and `Money.currency` are now `readonly`, which the type's own documentation had asked for and nothing enforced. Type-only, and pinned in `packages/entity/src/type-pins.ts`: re-declaring the alias, widening `minor` back to a `bigint`, or dropping either `readonly` is a build error rather than a review comment.

- **A rotating-address scan can no longer grow a rate limiter until the process dies.** Both in-memory limiters keyed a `Map` by the connection address and never removed an entry: `@ultimat3/http`'s `memoryRateLimitStore` only deleted on an explicit `reset(key)`, and `@ultimat3/auth`'s `createAuthLimiter` only on a successful login. A scan walking an IPv6 /64 mints a fresh key per request against both, so the table grew for as long as the scan ran — the throttle that exists to survive a flood was the thing the flood consumed. Neither had a sweep, and neither had a cap.

  Both now hold one rule: **an entry that answers exactly as a missing one is forgotten, not evicted.** Each entry carries the instant it reaches that state — a token bucket back at capacity, or an auth key whose failure window has emptied *and* whose lockout has expired — and a sweep drops everything past it. That alone flattens a scan: a one-request bucket on the default route refills in half a second.

  The cap is the backstop for what the sweep cannot claim, and it decides *which* live entry goes with the same care, because getting that backwards is a rate-limit bypass. The entries nearest to being forgotten anyway go first, so the most-throttled key is the last to go — and in `@ultimat3/auth` a live lockout outranks its own deadline, so filling the table is not a way to buy back attempts against the account you just locked:

  ```ts
  memoryRateLimitStore({ maxKeys: 20_000 });                      // DEFAULT_MAX_RATE_LIMIT_KEYS
  createAuthLimiter(clock, { ...DEFAULT_AUTH_RATE_LIMIT, maxKeys: 10_000 });
  ```

  Defaults are `DEFAULT_MAX_RATE_LIMIT_KEYS` (20,000 — an http key is `route|subject`, so one subject throttled on N routes is N entries) and `DEFAULT_MAX_AUTH_LIMIT_KEYS` (10,000 — an auth key is one identity). A few megabytes, held, instead of an unbounded map. Both are also observable now: `memoryRateLimitStore()` and `createAuthLimiter()` return their interface plus a `size`, so the bound is something a test can assert rather than something a comment claims. Sweeping is amortized — a sort is paid once per 10% of the cap, never per request — and a key that is dropped throttles again from a clean bucket, never a half-written one. Nothing about the decisions themselves changed: same buckets, same window, same lockout, same headers.

- **`{constructor}` in a translated string no longer renders a function's source into the page.** `interpolate` read a variable as `vars?.[name]`, an ordinary property access, so every member of `Object.prototype` was a variable a catalog could reach: `{constructor}` rendered `function Object() { [native code] }`, `{toString}`, `{valueOf}` and `{hasOwnProperty}` rendered their own source, and `{__proto__}` rendered `[object Object]` — all through the path that is supposed to render `⟦name⟧` for anything the caller did not pass. Only an **own** property is a variable now, which is the guard `catalog.ts` already applies from the other side by nesting keys into null-prototype nodes. A caller that genuinely passes `{ toString: 'ok' }` still gets `ok`.

  The same function's fast path returned early on a template with no `{`, which skipped `}}` un-escaping — so one escape had two meanings: `'{{a}}b'` collapsed to `'{a}b'` while `'a}}b'` came back untouched. It now tests both braces.

- **One bad date no longer takes the whole feed down.** `buildFeed` parsed item timestamps straight into `new Date(...).toISOString()`, so a `published` that would not parse — a CMS column holding prose, a hand-typed front-matter line — reached `toISOString()` as `NaN` and threw a bare `RangeError` out of the feed route. The same line spread its work into `Math.max(...times)`, one argument per item, so a feed that grew past the engine's argument limit crashed in proportion to how well the blog did; and the empty-feed branch called `Date.now()` directly, the one clock read in the package no test could freeze.

  All three are gone. `feed-dates.ts` is now the only place a feed timestamp is parsed or formatted, `buildFeed` resolves every date once, and the three builders only ever see instants:

  ```ts
  const feed = buildFeed(channel, [{ ...post, published: 'sometime last spring' }]);
  // renders: the item keeps its title, link and guid — only the date is missing
  ```

  A date that will not parse is treated as **absent**, never invented: RSS drops that item's `<pubDate>`, Atom drops its `<published>`, JSON Feed drops `date_published`, and Atom's *required* `<updated>` falls back to the feed's own instant, which is always real. An unparseable date sorts last instead of turning the comparator into `NaN` and handing the feed's order to the engine's sort. An unparseable `channel.updated` falls back to the newest item rather than poisoning `lastBuildDate`. Every timestamp the three formats emit is now normalised to UTC from one instant, so an offset-bearing input means the same moment in all three.

  "Now" is a seam: `buildFeed(channel, items, { clock })` takes a `Clock` — `frozenClock(at)` makes a feed with no usable dates byte-for-byte reproducible — and defaults to `systemClock`.

- **`Pipeline.handle()` keeps its one promise: a Response, always.** The lifecycle absorbed a throw from every stage that runs *before* the response exists, and then ran the two that finish it — `cache-headers` and `response` — in a bare loop outside that guard. A stage refusing the response it was handed (headers that cannot be set, on a `Response.redirect` or anything else a handler returned) rejected `handle()` against the contract written on it, and the caller got whatever the runtime prints instead of a document naming the defect. The recover stage had the same hole from the other side: it is the single place a throw becomes a status, so an app's `onError` sink or a `devNotices` producer throwing inside it left nothing to render its own throw.

  Both are now guarded in `finalize.ts`, and a refusal degrades to the new **`X_PIPELINE_FINALIZE_FAILED`** — 500, with the stage name and the underlying message in `cause`:

  ```json
  { "code": "X_PIPELINE_FINALIZE_FAILED",
    "cause": "the \"response\" stage threw while finishing the response: immutable headers" }
  ```

  The degraded answer is finished, not shipped bare: the finalize chain runs a second time over the problem document, whose headers *are* writable, so `x-request-id`, CORS and the security headers still reach the client that has to report this. A second failure keeps its 500 and stops — two passes, never a loop. The failure travels through the recover stage rather than around it, so it is reported, logged and rendered by this package's one call site for each, and `x dev` still shows it in the overlay. A request the stages *can* finish is byte for byte what it was.

- **A mis-encoded path is a 400, not a 500 and a page for the on-call.** `decodeURIComponent('%ZZ')` throws a bare `URIError`, and the router called it unguarded on every `:param` and `*wildcard` segment it walked past. A client typo — a lone `%`, a truncated `%A`, a value concatenated into a URL instead of run through `encodeURIComponent` — escaped `matchRoute` as an uncoded throw, so the pipeline mapped it to `X_INTERNAL`, answered **500**, and reported it to the error monitor (`error-map` pages on `status >= 500`). The caller was told nothing about a request only the caller could fix.

  `matchRoute` now answers with the fourth `MatchResult` variant instead of throwing, and the pipeline turns it into the new **`X_PATH_INVALID`** — 400, with the offending segment in `cause` and `encodeURIComponent` in `fix`:

  ```ts
  const match = matchRoute(table, 'GET', '/posts/%ZZ');
  // { ok: false, reason: 'path-invalid', segment: '%ZZ' }
  ```

  Only the branch that would have decoded can fail: static segments are compared raw, so a path that reaches no param or wildcard is the 404 it always was, a static route still wins the precedence it always won, and a sibling that does match still wins over one that could not decode. `X_PATH_INVALID` is registered in `HTTP_ERROR_TITLES` and mapped to 400 in `ERROR_STATUS`; `pathInvalid()` is exported for a host that matches routes itself.

- **`verifySignedUrl` keeps its promise never to throw.** `parseConstraints` decoded each key segment with a bare `decodeURIComponent`, so a signed URL whose path carried `%ZZ` raised a `URIError` out of a function whose header says verification never throws — an uncoded 500 on the storage read path, for a URL this package would never have minted (`buildSignedUrl` percent-encodes every segment). A segment that will not decode is now `'malformed'`, already a `SIGNED_URL_FAILURES` member, and it is refused before the signature is computed. Nothing is loosened: the reason is the same one an off-base URL gets, and it leaks nothing about the secret.

- **A cache tier that refuses no longer fails the read it was supposed to speed up.** `createCacheStack` walked the ladder with every tier call unguarded, so a tier throwing anywhere on the value path threw straight out of `read()` — the caller saw a failed business read where the source had already answered correctly. The common one needs no outage to reproduce: `LruCache.set` raises `X_CACHE_TOO_LARGE` for any entry over the tier's whole byte budget, so a page that grew past `maxBytes` stopped *loading* rather than stopping *caching*. A `get` was the same shape — a Redis with no socket failed every read that walked past it, including ones the memo or the LRU would have answered.

  Every `get`/`set`/`del` the stack makes now goes through `bestEffort()`, which reads a refusal as "that tier did not answer": the walk continues, later tiers are still populated, `write` and `drop` still reach the tiers behind the refusing one, and the value still comes back.

  ```ts
  const hit = await bestEffort(tier.name, 'get', key, () => tier.get<T>(key));
  if (hit === undefined) continue;                  // a miss and a refusal read the same here
  ...
  const value = await load();                       // the one call still left to throw
  ```

  `load()` stays unguarded on purpose — it *is* the business read, and absorbing it would hand back `undefined` as though it were the value. Silence is the other half of the bug, so the absorbed refusals are readable: **`recentTierFailures()`** returns the last 100, newest first, each carrying the tier, the operation, the key, the message and the `X_*` code when there is one, and each one is logged as `cache.tier.failed`. That is `report.errors` applied to the path that has no report to return, and `resetTiers()` clears it alongside the invalidation log. `LruCache.set` is unchanged and still throws for a direct caller: the stack is the layer that degrades, not the tier.

- **Two identical reads in one request are one read, even when they race.** The request memo behind a cached `query` stored the *value*, and stored it only after the read had settled — so two holes rendering concurrently both missed the memo, both asked the cache tier, and both executed the source. The memo now holds the read **in flight**, published before `readThrough`'s first await: the second reader joins the first instead of starting a competing one, and five concurrent readers cost one execution and one tier round trip.

  ```ts
  const memo = requestMemo(ctx);          // Map<string, Promise<unknown>> — was Map<string, unknown>
  const joined = memo.get(key);
  if (joined !== undefined) return (await joined) as T;
  ```

  A promise is never `undefined`, so the same change fixes a second defect for free: a read that legitimately resolves `undefined` now memoizes, where a value-keyed map read it back as a miss on every subsequent call. A rejection is evicted rather than memoized — a failed read is not the request's answer, so the next read in the same request retries instead of replaying one failure until the request ends. `requestMemo()` is exported, and its entries are now promises; nothing in the framework reads them but `readThrough`.

- **A query with no `cache:` block is memoized per request too.** The memo only ever ran for a query that declared `cache:` — `readRows` returned straight from the source on the `fresh || def.cache === undefined` branch, without so much as looking at `requestMemo`. So the reads that most need deduplicating were the ones that never got it: an uncached lookup called once per row of a list cost one round trip per row, and the request memo, the thing that exists to collapse exactly that, sat unused beside it.

  The memo is now what every read goes through, and the tier is the half a query opts into:

  ```ts
  if (options.fresh === true) return (await read()) as readonly TRow[];   // no cache may answer
  const key = cacheKeyFor(name, raw, def.cache?.tags ?? []);
  return (def.cache === undefined
    ? await readOnce(ctx, key, read)                                      // memo only
    : await readThrough(ctx, key, def.cache.ttlMs ?? null, read)          // memo, then the tier
  ) as readonly TRow[];
  ```

  `readOnce(ctx, key, run)` is the single-flight half of `readThrough`, split out and exported; `readThrough` is now `readOnce` plus the tier fill and nothing else, so there is one place a key is joined and one place it is stored. What the memo holds is the **execution**, never the decision: `readRows` parses the input, evaluates the policy and calls `sql()` before it reaches the memo on every call, and `.as()` reads in a child context whose identity is its own memo — so a memoized answer is still one that actor was allowed to ask for, and an impersonated read can never join one made as someone else.

  `fresh: true` now skips the memo as well as the tiers, a memo being a cache whose lifetime is the request. That makes it the one way to read past a write made earlier in the same request: an action's `invalidates` drops tier entries, not memo entries. It skips the memo on the way *in* and publishes to it on the way *out* — `readFresh` is `readOnce` minus the join, both sharing one publish step — so the read it just made is the request's answer from then on. Returning the rows early instead would leave the pre-write entry standing and end the guarantee at the one call that asked for it, handing the next plain read of that key the answer the write had already moved past.

- **A read filtered on NULL matched every row in memory and no row in the database.** `@ultimat3/query`'s source emitted `"col" = $n` whatever the value was, and `= $n` with a NULL argument is *unknown* in Postgres, never true — so `where({ deletedAt: null })` selected every live row from `from()` and nothing at all from a driver. The keyset predicate had the same defect one page later: `"publishedAt" > $n` is unknown for every draft, so page two stopped at the first NULL and the rows behind it could not be reached through a cursor at all.

  NULL now means one thing across the SQL, the in-memory execution and the live matcher, and `null` and a column the row omits are the same absence:

  | Operator | NULL is | Emitted as |
  |---|---|---|
  | `=` `!=` `in` | a value — it matches itself and nothing else | `is null` · `is not null` · `is distinct from` · `in (…) or is null` |
  | `>` `>=` `<` `<=` | unknown — a NULL on either side matches nothing | unchanged; `matchesFilter` now answers the same |
  | `order by`, the cursor | the largest value: last ascending, first descending | `asc nulls last` · `desc nulls first` |

  ```sql
  -- before                                    -- after
  where "deletedAt" = $1                       where "deletedAt" is null
  order by "publishedAt" asc                   order by "publishedAt" asc nulls last
  ("publishedAt" > $1)                         (("publishedAt" > $1 or "publishedAt" is null))
  ```

  Two behaviour changes ride along, both making the memory path answer what Postgres answers: an ordering operator against a NULL no longer compares the string `"null"` (a null `score` used to sort past `5` and land in a `score > 5` feed), and `compareValues` sorts NULL after every value instead of between `"m"` and `"o"`, which is what `compareRows`, `isAfterKey` and the live matcher's insertion position all read. `!=` compiles to `is distinct from`, the pair `@ultimat3/entity`'s `predicateSql` already emitted. An empty `in` list is `1 = 0` rather than `in ()`, which Postgres refuses outright — and so is an `in` handed something that is not a list at all, which used to fall through to `"col" in $1`: a syntax error from the driver where `matchesFilter` had quietly answered no rows. `isNull` is exported beside `isAfterKey`, for the same reason: a custom `SqlSource` has to agree on what NULL is rather than re-decide it.

  A generated `order by` now carries `nulls last`/`nulls first` explicitly. It is Postgres' own default — no plan changes, and `asc nulls last` is still the default btree order — but an assertion on exact SQL text needs updating.

- **The live matcher places a new row where the database would put it.** A page is served `order by <declared keys>, "id" asc` and `isAfterKey` reads the next one the same way, but the incremental matcher compared the declared keys alone — so a row tied on every one of them was appended after the whole tie group rather than placed by its id. The client rendered an order no re-read agrees with, and the cursor cut from that window's tail skipped every tie the matcher had pushed past it.

  `totalOrder(orderBy)` is now the one definition of that list — the declared keys, then `id asc` unless the ordering already names `id` — and `positionFor`, `Builder.seek()` and the in-memory sort all read it:

  ```ts
  // window [b(t=10), c(t=10)], insert a(t=10)
  positionFor(shape, window, a);   // 0, was 2 — the database returns a, b, c
  ```

  A row with no `id` is now `X_QUERY_NOT_PAGEABLE` at the matcher, as it already was at `seekKeyOf`: `String(undefined)` is `"undefined"`, an id every id-less row shares, so one row's patch landed on another's position and a `remove` named a row no client held. An unordered query still appends — SQL promises no position there to get wrong. `totalOrder` is exported for the reason `isNull` and `isAfterKey` are: a custom `SqlSource` has to serve the order the cursor assumes rather than re-decide it.

  **And the live window is now served in that order too.** Placing the patch by `totalOrder` fixed two of the three readers and left the third: the initial window came from the query's own `sql()` unpaged, so it arrived ordered by the declared keys alone and a tied row sat wherever the database returned it — the matcher then inserted by id into a list that was not sorted by id, and the resume `seek()` read the next page as though it had been. `SqlSource` gains an optional `total()` — the same read, no cursor and no window, ordered `<declared keys>, "id" asc` — and `sourceFor` calls it for `surface: 'live'` and nothing else:

  ```sql
  -- a live feed's window, before          -- after
  order by "createdAt" asc nulls last      order by "createdAt" asc nulls last, "id" asc nulls last
  ```

  `Builder.total()` implements it (`seek()` already implied it, and the private `pageOrder()` is now `servedOrder()` because a live window is not a page). A source that does not implement `total()` is untouched, as is every non-live read: a plain `from()` over rows with no `id` still generates exactly the SQL it was asked for. An assertion on a live query's `sqlText` needs updating.

- **A `BEGIN` that fails no longer leaks the connection it was going to run on.** `withTransaction` reserved a connection, ran `BEGIN` *above* its `try`, and released the pin in the block's `finally` — so the one statement that opens the transaction was the one statement not covered by the guard that closes it. A `BEGIN` that rejected (a connection killed mid-pool, a server in recovery, `statement_timeout` on a hung `SET`) returned the pin to nobody: one leaked pool connection per failure on Postgres, and on PGlite the single session's turn, which every later statement in the process then waits for forever.

  The pin is now held by a `using` declaration and `BEGIN` runs inside the guarded scope — the shape `readOnlyQuery` already had, and it too is converted, so both sites read the same:

  ```ts
  using reserved = isReservable(client) ? await client.reserve() : undefined;
  try {
    await connection.execute(raw(beginStatement(options)));   // inside the guard, not above it
    ...
  }
  ```

  One visible consequence: a failed `BEGIN` now also emits a best-effort `ROLLBACK`, which the server answers with a notice — cheaper than a second exit path for the statement that opened nothing. Nothing else changes: the same statements, in the same order, on the same connection.
- **A failing `ROLLBACK TO SAVEPOINT` no longer masks the error that caused the rollback.** A nested `withTransaction` whose body threw rolled back to its savepoint *uncaught*, so when the failure was the connection itself the caller got `X_DB_UNAVAILABLE: statement failed: ROLLBACK TO SAVEPOINT x_sp_1` instead of the error the unit of work actually died of — and the `onRollback` undos never ran. It is best-effort now, matching the root's `ROLLBACK`. `SAVEPOINT` and `RELEASE SAVEPOINT` stay uncaught on purpose and are documented as such: a savepoint that was never taken means the scope never opened, and a release that failed means its work is not durable in the outer scope. Both are failures the caller has to see.
- **A released `DbConnection` is inert, and releasing it twice releases it once.** `createPostgresClient().reserve()` returned a handle whose `query`/`one`/`execute` kept issuing on the pinned connection after `release()` — but the pool had already handed that physical connection to another unit of work, so a `tx` leaked past its transaction scope wrote its row inside *their* transaction, committed or rolled back with it, with no error anywhere to explain it. The handle now runs direct **only while the pin is held**; a late statement takes its own connection out of the pool like any other caller. That is the rule `pglite.ts` already enforced with its turn queue, so the two drivers finally mean the same thing. `release()` is idempotent for the same reason it needed to be there: two owners reach it on one exit path, and the second was freeing a pin that was no longer ours.

  `DbConnection` is `Disposable` — `[Symbol.dispose]` **is** `release()`, not a second code path — so the pin can be held by a declaration instead of a hand-rolled `finally`:

  ```ts
  using connection = await client.reserve();
  await connection.execute(raw('BEGIN'));
  // released on every exit path, including the one nobody wrote a test for
  ```

  Not a breaking change: `release()` stays, with the same signature and the same semantics on the first call. An implementer of `DbConnection` outside the framework — there is no supported reason to have one — must add `[Symbol.dispose]`.
- **The migration advisory lock is held by one session, so migrators actually serialise.** `migrate()` issued `pg_advisory_lock(MIGRATION_LOCK_KEY)` on the *pool*, and `pg_advisory_lock` is scoped to a Postgres session, not to a statement: the pool lent a connection for that one statement and took the session back. Both halves of the lock then failed. The unlock ran later on whatever connection the pool lent next, answered `false`, and left the lock held until that backend died — the next `ROLE=migrate` container waited on a lock nobody would ever release. And the session actually holding it sat idle for the whole run, so the pool's idle timeout (`migrate`'s is 10s) closed it and released the lock *mid-migration*, which is the case the lock exists to prevent. `ROLE=migrate` masked the first half by accident — its pool is `max: 1`, so every statement found the same connection; no other role and no test has that.

  The lock scope now pins one connection (`using`, so it comes back on every exit path), takes the lock on it, and hands that session down — `ensureLedger`, the ledger read and every migration's `withTransaction` run on it, which is also the only thing that can work on `max: 1`. The unlock stays best-effort and now reaches the session that took the lock. `rollback()` took **no** lock at all and takes the same one, with the same `lock: false` escape hatch as `migrate()` for a private branch database.
- **PGlite's turn queue holds its turn with `using`, matching `DbConnection`.** `TurnQueue.run()` gave the turn back in a hand-rolled `finally`, the same shape `withTransaction` had before its own fix above — one exit path a future edit can still slip above. `Turn` (`pglite-turns.ts`) is now `Disposable`: `release()` and `[Symbol.dispose]` are the same call, idempotent for the same reason `DbConnection.release()` is, and `run()` holds it with `using turn = await take()` instead. `reserve()` in `pglite.ts` cannot do the same — its turn outlives the function, released later by the caller's own `release()` — so it calls `turn.release()` explicitly where it used to call `turn()` directly. Not a breaking change: both functions are package-internal, and the queue's public shape (`take()`/`run()`) is unchanged.
- **A `close()` that rejects no longer caches a dead pool.** `PostgresClient.close()` awaited the driver's teardown and *then* dropped its handle, so a teardown that threw — a connection already terminated, a socket that never drained — skipped the drop and left the corpse cached. The next `connect()` handed it straight back, every statement after that failed for a reason no caller could see, and a second `close()` could not clear it because it threw in the same place. The handle is now read and cleared **before** the await, matching `pglite.ts`: the rejection still reaches the caller — a shutdown that could not drain wants to know — but the client is empty either way, so the next statement opens a live pool. Clearing first also settles the race: a `connect()` arriving while the teardown is in flight gets a new pool rather than joining the one draining.
- **`x build --target binary` produces an executable that boots.** It compiled and then died on `ENOENT … '/$bunfs/package.json'` before any role started: a single-file executable carries no `package.json`, and `FRAMEWORK_VERSION` read one at module scope. The read is now lazy and accepts a second source — `x build` compiles the version in as `--define ULTIMATE_FRAMEWORK_VERSION="<version>"`, which is the only thing inside `/$bunfs` that can answer. A binary built any other way exits `X_INVARIANT` at the first version read, naming the flag, rather than reporting a version it does not have. `packages/core/e2e/version.e2e.test.ts` compiles a real executable and runs it, with the define and without, on every push — the gap lasted two releases because nothing ever executed the artifact. Still unproven, and still named in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps): the target end to end. Booting is not serving, and no scaffolded app has been compiled and run from a bare VM.
- **`@ultimat3/cli`'s command registry no longer reads a manifest at import.** The same eager read survived one file over: `export const CLI_VERSION = loadVersion()` sits at the module scope of `registry.ts`, and `index.ts` re-exports it — so importing the package for `runRole` alone, which is all a compiled `apps/web/server.ts` does, died on `ENOENT … '/$bunfs/package.json'` before the first role started. `cliVersion()` resolves at the call and caches, and falls back to the same `ULTIMATE_FRAMEWORK_VERSION` define `x build` already passes — the packages ship one version, one commit, one tag, so a second define would be a second version fact to hold in step, and without the fallback `x --version` inside a binary answered `X_INVARIANT` for a version the build knew. `packages/cli/e2e/registry-boot.e2e.test.ts` compiles the registry into an executable and runs it: the binary builds the whole command list, reports the defined version when the build passed one, and throws only when something asks for a version the artifact does not carry. Its last test compiles the module-scope read and asserts the binary dies before it boots — the fix and the defect are both executable, so neither can regress silently.
- `@ultimat3/cli` declares `@ultimat3/schema`, which `error-catalog.ts` has always imported — an undeclared dependency that resolved only because the workspace hoisted it.
- **`Invariant<T>.holds` is a method, not a function-typed property.** A property is checked contravariantly, so `Invariant<Post>` was not assignable to `Invariant<unknown>`, `Entity<Post, C>` did not satisfy `EntityCore`, and every `database({ posts, orgs })` call silently degraded to `Table<unknown>` — 36 cascading errors in the reference app from one position.
- Both regressions are pinned by `packages/entity/src/type-pins.ts`, which is source rather than a test: `tsconfig.json` excludes `src/**/*.test.ts`, so a type-level assertion written in a test file is never read by `tsc` and can never fail.
- `KNOWN_GAPS` in the scaffold typecheck gate is **empty**: every file `x new` and `x g` write now compiles with no diagnostic to excuse.
- **One `timingSafeEqual`, not two.** `@ultimat3/auth`'s `tokens.ts` and `@ultimat3/storage`'s `signed-url.ts` carried byte-identical constant-time string comparisons — the kind of duplication that drifts silently, since a fix to one copy's branch-free XOR loop would say nothing about the other. The implementation now lives in `@ultimat3/core` (`timingSafeEqual`), tier 0 and reachable from both; each package re-exports it so every existing `from '@ultimat3/auth'` and `from '@ultimat3/storage'` import keeps working unchanged.
- **`@ultimat3/schema`'s error codes render their real titles in every process, not just the CLI's.** `X_VALIDATION_FAILED` and `X_SCHEMA_UNSUPPORTED` were exported as data from `SCHEMA_ERROR_CODES` and registered nowhere except `@ultimat3/cli`'s `error-catalog.ts` — a process that never loads the CLI (a worker, a job runner, a plain script importing `@ultimat3/schema` on its own) rendered the humanised fallback (`X_VALIDATION_FAILED: validation failed`) instead of the authored title. `@ultimat3/core` now registers both at import time (`schema-error-codes.ts`) — every process gets them just by importing core, which is unconditional. Schema is tier 0 alongside core and cannot register its own codes or have core import it back to read them, so the titles are a deliberate, tested duplicate: `schema-error-codes-pin.test.ts` (in `@ultimat3/cli`, a package that may import both) pins core's copy equal to schema's own declarations. `error-catalog.ts`'s CLI-only registration is gone — it is now redundant with what core already does for every process.

## 1.2.0

### Added

- **`/metrics` is served by every role**, on its own port (`METRICS_PORT`, default 9090) rather than the role's HTTP port — the Helm ingress routes `/` with no path exclusion, so mounting it beside `/healthz` would publish route patterns, request volumes and error rates to the internet. `worker`, `scheduler` and `replicator` open no HTTP socket at all, so a separate listener is the only thing they could ever be scraped on.
- **The three recorders are wired**, each in the package that owns the event: `recordRequest` in the HTTP pipeline's `finally` (counts a request whose finalize stage throws, which the happy path misses), `recordConnection` in `SocketRegistry.add`/`remove` (the idle sweep now routes through `remove()` — that was the one leaking path), `recordQueueDepth` at the top of the worker's `tick()`, throttled to 15s because `stats()` aggregates the whole jobs table.
- **Six tutorials** in the wiki, first app through deploying free and growing up. Every command and every pasted output was executed against the published 1.1.0 packages.
- **`wiki/Known-Gaps.md`**, plus `Observability` and `UI-Components` reference pages.

### Changed

- **The GitHub Pages site is gone.** The wiki is the single public documentation surface. `site/`, `.github/workflows/pages.yml` and the custom domain are removed, and the repo homepage points at the wiki.

### Fixed

- Metric labels use the route **pattern** (`/posts/:id`), never the concrete path, and unmatched paths collapse to one `unmatched` series — a scanner hitting `/wp-admin` and `/.env` cannot mint unbounded series.
- **Documentation that had drifted from the code.** `wiki/Theming.md` and the admin dev server both hardcoded the pre-retune palette, including the `line` value that measured 1.16:1 in dark; the admin server now derives from `colorTokens` so it cannot drift again. `ROLE=all` was documented in three places and does not exist (`X_ROLE_UNKNOWN` at boot). `x status`, `x deploy static --to`, and `x build --target docker --helm` were documented as shipped and are not. `X_MIGRATE_CONCURRENT` was described as "no advisory lock" — the lock is real (`pg_advisory_lock`), the code simply has no throw site because concurrent migrators *wait*.

### Known gaps found while writing the tutorials

Not fixed, and each one hit by actually running the command. Full list in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **`x db gen` and `x db migrate` fail in every scaffolded app** — both shell out to `bunx drizzle-kit`, which `x new` neither installs nor configures. This also breaks `bin/setup`, the scaffold's own documented first command.
- `generateMigration` mangles composite indexes; a migration `up` holding two statements cannot be applied.
- Every generated entity fails `typecheck` on its `invariant()` calls, not just the `x new` example slice.
- The Helm chart still cannot reach `/metrics`: no role declares a metrics container port and no scrape target ships, so the HPAs read `<unknown>`.

## 1.1.0

**The first release published by the workflow.** 1.0.0 was the manual bootstrap; every `@ultimat3/*` package now carries an OIDC trusted publisher for `developerz-ai/ultimate` → `release.yml`, so this version reaches npm with no `NPM_TOKEN` and provenance attached automatically.

### Added

- **`x` serves in production.** `serve.ts` boots a role without the dev watcher, `/_x` or `dev: true`. `ROLE=migrate` applies migrations through the db ledger and exits — the release phase a PaaS asks for. `x new` now writes `apps/web/server.ts`, `apps/web/prerender.ts`, a Dockerfile, a `.dockerignore` and `docker-compose.prod.yml`.
- **Metrics.** `metrics.ts` — counter, gauge and histogram on the OpenTelemetry data model, a `MetricExporter` seam, and `/metrics` in Prometheus text with no dependency. The Helm chart's `connections` and `queue_depth` are emitted verbatim; `rps` is derived from the monotonic `http_requests_total`, because a rate is not a series.
- **`Secret`.** Redacts by value — `toString`, `toJSON`, `Symbol.toPrimitive`, the inspect symbol and the logger — at any depth, under any key, frozen so a spread cannot unwrap it.
- **`resolveEnvironment()`** in core: `development | test | staging | production`, from `ULTIMATE_ENV`.
- **`renderEnvExample()`** generates `.env.example` from the typed env declaration, so the two cannot drift.
- **Page-level UI composites** — `AppShell` (with a working skip link), `PageHeader`, `Section`, `Toolbar`.
- **`defineTheme()`** — the one brand-override seam. Values are validated, never escaped; a `;` or a `</style>` is a refusal.
- **`CATALOG.md`** — 46 components with every prop and the token vocabulary, generated from source and drift-tested, so an agent picks a component without reading it.
- **Factory traits, associations and `create()`**, plus `sharedExamples` / `behavesLike` in the test harness.
- **`docs/ops/`** — running an Ultimate app for real: the PaaS → Compose → Kubernetes ladder, secrets, observability, datastore sizing, disaster recovery, runbooks. Recommendations only; the framework depends on none of it.
- **`scripts/trust-publishers.ts`** — attaches and verifies the OIDC trusted publisher for every published package. `--check` is the read-only form.

### Fixed

- **A scaffolded app produced no deployable artifact.** `x build --target binary|static` pointed at entry files nothing created, and `--target docker` routed through the same missing file.
- **Eight colour pairings failed WCAG AA.** `line` on `surface-raised` scored **1.16:1** in dark — an input border nobody can see. Seven channels retuned; `tokens/contrast.ts` measures every pairing so it cannot regress.
- **Secrets leaked through the log.** Redaction was by key name, so `{ dsn: 'postgres://user:pw@host/db' }` printed the credential. `checkEnv().values` carried plaintext too; `maskedEnvValues` is now the printing path.
- **Every registry factory defaulted to `seed: 1`**, so two tables minted the same uuid and a join assertion could pass for the wrong reason.
- A scaffolded `biome.json` carried `//` comments Biome rejects; the root tsconfig never mapped `@app/*` for paths the scaffold itself writes; the scaffolded `package.json` had no `version`; `resolveServices` created `.x/` unconditionally, which is `EACCES` in a non-root container.
- `IconButton`'s primary variant hardcoded `accent-fg`, so a danger icon button used accent's on-colour.

### Known gaps

- `x build --target binary` compiles but crashes at import: `FRAMEWORK_VERSION` reads `package.json` at module scope and a single-file executable has none.
- `docker-compose.prod.yml` declares a host port and `replicas: 3` together — two processes cannot bind one port. This is the rung-1 ceiling. **Closed in [Unreleased]**: `web` and `sync` are `replicas: 1` in all four files, and the ceiling is declared with the two ways up named.
- The shared cache tier's Lua invalidation `DEL`s keys it never declared in `KEYS`, so it fails on Dragonfly and on Redis Cluster. **Closed in [Unreleased]**.
- `resolveEnvironment` now exists in both `core` and `seo` with different return types. **Closed in [Unreleased]**, as a breaking change: `@ultimat3/seo` exports neither it nor `SeoEnvironment`.

## [1.0.0] - 2026-08-10

First release. 27 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 28 in all — publish at 1.0.0 to npm, in tier order.

1.0.0 itself is the **manual bootstrap**: a trusted publisher can only be attached to a package that already exists, so this one version is published by hand by an npm org member. Every release after it goes through the workflow over OIDC trusted publishing, no `NPM_TOKEN` — see [PUBLISHING.md](PUBLISHING.md).

### Added

- **The eight primitives**, shapes frozen under semver: `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task`. There is no ninth — a new capability arrives as a factory over an existing primitive, which is why `llm()` returns an `action`.
- **One authz object across every surface.** A `policy` decides the HTTP call, the typed client call, the job run, the MCP tool call and the live-query subscription. No trusted-tool mode, no second permission table.
- **`@ultimat3/core`** — `UltimateError` and the error contract, ALS request context, `defineEnv`, roles, clock, structured logging, OpenTelemetry spans, graceful drain, signed cursors, `defineService`.
- **`@ultimat3/schema`** — Standard Schema over a built-in default provider, JSON Schema projection, and one `formatIssues` shared by every package that reports a validation failure.
- **`@ultimat3/entity` + `@ultimat3/db`** — a Postgres driver (`postgresDriver()`) and an in-memory one over one shared plan/cursor layer, so the two cannot drift; PGlite and database branching, so `x dev` needs no Docker.
- **`@ultimat3/action` + `@ultimat3/query`** — one declaration projecting to an HTTP route, an OpenAPI operation, a typed client method, a job handle, an MCP tool and contract tests, all through a single `invoke` path.
- **`@ultimat3/http`** — the owned `Bun.serve` lifecycle with an explicit, ordered request pipeline.
- **`@ultimat3/jobs`** — Postgres queue driver, durable steps with memoized replay, transactional outbox on by default, cron `task`s with a required IANA timezone and leader election.
- **`@ultimat3/realtime`** — tiers 1–2: channels, presence, live queries with per-subscriber policy, an incremental matcher, a Postgres logical-replication change feed (`pgoutput` over `Bun.connect`), and a NATS bus for fanout.
- **`@ultimat3/render` · `pwa` · `seo`** — five render modes with `stream` the default, the `site/` → `app/` surface boundary as a build error, a generated service worker, and SEO gates that fail the build rather than the audit.
- **`@ultimat3/cache`** — four tiers and one tag invalidation graph; an untagged cached query fails the gate.
- **`@ultimat3/mcp` · `ai` · `manifest`** — the AI-first surface: an MCP dev server whose tool catalog is per-connection and fail-closed, a read-only SQL guard with four independent defenses, `x.manifest.json`, `llm()` with token-and-money budgets and a scope-partitioned semantic cache, `PgVectorStore` fusing pgvector cosine and Postgres FTS through RRF, and evals that gate on score delta from a committed baseline.
- **`@ultimat3/auth` · `mail` · `storage`** — OAuth authorization-code exchange with id-token verification, ESMTP and Resend transports, S3 storage.
- **`@ultimat3/i18n` · `money` · `time`** — enforced, not documented: no hardcoded user-facing string, no float money, no date without an explicit IANA `timeZone`.
- **`@ultimat3/ui` · `admin`** — an SCSS-module design system on semantic tokens for both colour schemes, and the `/_x` dashboard.
- **`@ultimat3/cli`** — the `x` binary. `x dev` boots the real app in any role, and every fact it reports comes from a framework package rather than a second implementation inside the CLI.
- **`create-ultimate`** — `bunx create-ultimate myapp` scaffolds a monorepo whose unmodified generated code passes `x verify`.
- **`x verify`, 17 steps**, with no way to run fewer: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap.
- **The error contract, as gate steps.** Every failure carries a stable `X_*` code, a cause, a runnable `fix:` and a `--json` form. `x verify` fails a `fix:` that names no command, and an `X_*` code with no documented row.

### Fixed

- A lockstep release now rewrites sibling `@ultimat3/*` pins, not only each package's own version. Moving versions alone would have published `@ultimat3/jobs@1.0.0` naming `@ultimat3/core@0.0.1` — a version that is not on the registry, so every install of the release would fail.
- Version skew is a `package-shape` finding (`X_RELEASE_VERSION_SKEW`), so it fails the gate instead of reaching npm.
- A changelog entry inserts under `[Unreleased]` instead of appending, which keeps the file newest-first past the second release.

### Notes

Not claimed at 1.0.0, named here rather than left to be discovered:

| Open | Where it stands |
|---|---|
| Realtime capacity | no published benchmark. The 50k-socket forced-restart number is unmeasured; documented capacity figures are targets, not results |
| Two-platform deploy proof | `x build --target docker\|binary\|static`, both compose files and the Helm chart ship. The demo app on Compose **and** K8s from one image, with an invisible rolling restart, is [milestone 11](docs/idea/14-roadmap.md) and is not yet demonstrated |
| Deferred to v2 | realtime tier 3 local-first (`persist: true`), the plugin API, multi-region replication, and the Redis/NATS **job** drivers — each behind an interface that ships today, throwing `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

## [0.0.1] - 2026-07-26

Repository bootstrap: monorepo layout, tier-enforced package boundaries, Biome and strict TypeScript, free-runner CI, npm OIDC trusted publishing, and the design docs. Never published to npm.
