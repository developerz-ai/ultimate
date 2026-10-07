# Queries and live queries

A `query` is a read. `live: true` makes it subscribable. Never writes, never enqueues, never sends mail.

`As of 2026-08-23`. Stable API — semver from here ([Upgrading](Upgrading)). All three tiers of [Realtime](Realtime) ship. Tier 3 (local-first) shipped in 21.0.0, opt-in: `persist` is an `entity()` option, read by realtime's IndexedDB store and one outbox ([Realtime](Realtime#tier-3-shipped-in-2100)). `persist` is **not a field `query()` accepts**; writing it is a `TS2353` excess property.

## The canonical shape

```ts
// query
export const liveFeed = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('feed:read'),
  live: true,
  sql: ({ orgId }) => db.posts.where({ orgId }).orderBy('createdAt').limit(50),
});
```

## Fields

| Field | Required | Rule |
|---|---|---|
| `input` | yes | Standard Schema; `t` re-exported from `@ultimat3/query`, so a query file imports one package. The shipped provider is `@ultimat3/schema`'s dependency-free builtin — ArkType, Zod and Valibot are optional swaps behind `configureSchemaProvider`, and no adapter ships. Parsed before `policy`, before `sql`. Becomes the GET query string, the client hook argument, and the MCP tool's JSON Schema |
| `policy` | yes | `can('<perm>')`, optionally with a predicate over `{ input, actor }`. Evaluated at HTTP call, client hook, subscribe, **and per delivered row** |
| `live` | no — default `false` | registers the query with the incremental matcher. Requires a deterministic, bounded `sql` |
| `single` | no — default `false` | `true` declares a read of ONE object (a detail page's row by id or slug). Only the wire changes: the HTTP GET answers the first row `sql` returns as the body, **404 `X_NOT_FOUND`** when there is none (a list read answers `200 []`), refuses `_first`/`_after` (400), and `openapi.json` documents one object, a `404` and no page controls. The typed client answers `Promise<TRow>` and has no `.page`. The MCP tool answers as the route does — the row, or `X_NOT_FOUND` — over `tools/call` alike (`As of 2026-10`). Every in-process caller — `read(input)`, `.as()`, `.page()`, `.live()` — keeps `readonly TRow[]`. Anything but a boolean is `X_QUERY_SINGLE_INVALID`. `As of 2026-09-29` |
| `sql` | yes | `(input) => SqlSource`. `from()` (`@ultimat3/query`) wraps an already-resolved `@ultimat3/entity` repo call and restates `where`/`orderBy`/`limit` for the matcher to read back; `select`/`preload` happen inside that repo call, before `from()` ever sees a row. No ORM in the graph. SQL-transparent: `toSQL()` prints the statement verbatim so an agent can read it and self-correct |
| `mcp` | no — default not exposed | `{ expose: true, description }` makes the read an MCP tool. Opt-in, unlike an action: a read hands rows to an agent, so silence exposes nothing |
| `mcp.visibleTo` | no | roles that may see the projected tool; a caller whose role is not named gets ToolNotFound, never Forbidden — the policy still decides every call |
| `audit` | no — default `false` | `true` records every call in the installed `AuditSink` — allowed, denied, failed, and a memo or cache hit (`replayed: true`). See [Audit](#audit-who-saw-what) |
| cache tags | derived | acquired automatically from the tables `sql` touches. Never hand-declared on a query |

Nothing else is a query field. Sorting, paging, and filtering are `input` fields consumed by `sql`.

## The fluent surface

Every projection this package owns is a method on the query — `liveFeed.live(input)`, never `toLiveQuery(liveFeed, input)` — and every declared field is lifted onto it. The MCP read tool is `@ultimat3/mcp`'s one projection, `toolFrom(liveFeed)` (`As of 25.0.0` there is no `.tool()`). A query has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `liveFeed(input, options?)` | the read | the policy's actor half → parse input → evaluate policy → build source → execute, through the cache tiers. A reader refused whatever they send is 401/403, never `X_INPUT_INVALID` |
| `.as(actor, input, options?)` | the same read, as someone else | keeps the surrounding context whole — services, clock, locale, trace — and swaps only the actor. `null` is the signed-out caller |
| `.page(input, { first, after? })` | one bounded page | `{ rows, nextCursor, hasMore }` — the one page shape, `@ultimat3/core`'s `Page`, the same `findMany` answers; the `endCursor`/`hasNextPage` aliases left in 25.0.0. `nextCursor` is `null` exactly when `hasMore` is false (25.0.0: the last page used to keep a cursor), so `while (page.hasMore)` stops on the last page. The cursor is signed and scoped to `queryHash(name, input)` — the query's name and its parsed input, never `first` or `after`, which are controls rather than scope. There is no `offset` and there never will be |
| `.live(input, options?)` | the subscription descriptor | a `LiveQuery` carrying the **same** policy object, re-evaluated per subscriber |
| `.client({ baseUrl })` | the typed browser method | `GET /_x/query/live-feed?orgId=…`, keys sorted so one input is one URL. `.client(…).page(input, { first, after })` reads one page over the same route |
| `.describe()` | the manifest row | name, capability, tags, ttl, `live` |
| `.input` `.policy` `.cache` `.mcp` `.isLive` | the declaration, lifted | readable. `sql` is not among them |

`sql` is unreachable by design. The declaration lives in a private store inside `read.ts` and `@ultimat3/query` exports no reader for it, so `sourceFor` is the only thing that can build a source — one read path and one authz path, structurally rather than by convention. A hand-rolled object with `kind: 'query'` is `X_QUERY_FOREIGN`, never a registered read.

`isLive` is the declared boolean; `live()` is the subscription itself. Every projection needs the name `registerQueries()` stamps on — before that, `X_QUERY_UNREGISTERED`.

## Five projections

| Projection | Derived from | Shape |
|---|---|---|
| HTTP GET | name + `input` | `GET /_x/query/live-feed?orgId=…`, errors as `UltimateError` JSON |
| Read hook | the query's name, and `live` | `const feed = useQuery({ name: 'liveFeed', live: true }, { orgId })` in an island. It returns an `AsyncState` accessor; see below |
| Live subscription | `live: true` | WS frames `{qid, op, row, lsn}` patched into the page's one record store |
| Cache entry | tags from `sql` | key is the query name + a fingerprint of the parsed input + the sorted tag keys — the actor is not in it; see [Caching and invalidation](Caching-And-Invalidation) |
| MCP read tool | `input` + `policy` + name | one read tool per query, named for the export **verbatim** — `liveFeed`, never `live_feed`. The URL is kebab-cased; the tool name is not. Identical authz. See [MCP and AI](MCP-And-AI) |

### The read hook, precisely

**One read hook, `useQuery`**, in 21.0.0. `useLive` and `liveHookFor` are deleted.
Live-ness belongs to the query declaration, not to the hook an island picks.

```ts
import { useQuery } from '@ultimat3/realtime';

type FeedRow = { id: string; title: string };
declare const orgId: string;

const feed = useQuery<FeedRow>({ name: 'liveFeed', live: true }, { orgId });
// feed(): AsyncState<readonly FeedRow[]>; feed.refetch(); feed.release()
```

| Fact | Rule |
|---|---|
| The ref | `{ name, live?, entity? }`: the registered name, never the query **value**. Importing the value drags its read path into the island; measured at 698,801 B for the reference feed |
| `live: true` | rows arrive and move over the page's one socket |
| no `live` | one `GET /_x/query/<kebab>` through `clientTransport`. Name its `entity` to make the rows store records that any write moves; without it the list holds its rows itself and only `refetch()` moves them |
| What it returns | an `AsyncState` accessor: `pending`, `refreshing` (keeps the rows on screen), `ready`, `failed` |
| Lists hold ids | the rows come from the page's `RecordStore`, so a record updated through any path re-renders every list holding it |
| Input | read **once**, at call time. A changed input is a new `useQuery` |
| Lifetime | the caller owns `release()` (Solid: `onCleanup`) |
| Not derived, `As of 2026-09-22` | `live` and `entity` are stated on the ref by hand, and nothing checks them against the query declaration. A ref saying `live: true` for a non-live query subscribes to nothing |
| Types | the row type is the caller's annotation (`useQuery<FeedRow>`), not inferred from the query. That is the price of never importing the query value |
| A server render | answers `pending` with no subscription |
| A browser bundle that never called `installRealtime()` | `X_REALTIME_UNINSTALLED` |

### The HTTP GET, precisely

Mounted for every registered query by `x dev` and by a container, from one composition — nothing to wire in the app.

| Fact | Rule |
|---|---|
| Method + path | `GET /_x/query/<kebab-export-name>`, the URL `.client()` derives with no server import |
| Input | the search string, coerced at the boundary (`t.number` from `"12"`) then validated by the query's own schema. Repeated keys are an array, and keys are sorted so one input is one URL. The typed client sends a `Date` as its ISO instant and nothing for an empty array; the route reads a **required** array nobody sent as `[]`, so `{ tags: [] }` arrives (`As of 2026-10`). An optional or defaulted array keeps the schema's own answer for absence — `[]` passed to one arrives as absent |
| Bad input | **400** `X_INPUT_INVALID`, with `x queries describe <name> --json` as the fix — the same code and line every other surface of that read answers |
| Authz | evaluated once, inside the read, from the parsed input. `auth: 'public'` only for `allow()` — anything else is `required`, and an anonymous caller is 401 before the policy is reached |
| Caching | `no-store`. The URL names no actor while the rows are scoped to one, so a shared cache is something a CDN in front of the app configures knowingly. The read's own `cache:` tags ride along for a purge |
| Failures | `application/problem+json` carrying the code, cause and fix. A non-framework throw is the server's 500, never dressed as a read failure |
| A page | `?_first=20` answers `.page()`'s own envelope — `{ rows, nextCursor, hasMore }` — and `&_after=<nextCursor>` continues it. Without a control the answer is the bare array. The keys carry an underscore because `first` is a legal input member (a listing's own page size); declaring `_first` or `_after` as input is `X_QUERY_INPUT_UNENCODABLE`. A size outside 1–10,000 or an `_after` without `_first` is **400** `X_INPUT_INVALID`; a cursor that is not this read's is **400** `X_CURSOR_INVALID`. `As of 2026-09`. **A declared `.limit()` is the size of the listing** (`As of 2026-10`): `_first` pages inside it and never past it, the last page inside it answers `hasMore: false` and `nextCursor: null`, and a read meant to be paged to the end declares no limit |
| In `openapi.json` | every read, as a `GET` path item: the input as `in: query` parameters, then `_first` and `_after`, and a `200` that is `oneOf` the rows and the envelope. A `single: true` read: the input parameters only, a `200` that is one object, a `404`, and `x-ultimate.single: true` |
| One object | `single: true` answers the row itself, or **404** `X_NOT_FOUND` — see below |

### A read of one object — `single: true`

```ts
export const postById = query({
  input: t.object({ id: t.uuid }),
  policy: can('post:read'),
  single: true,
  sql: ({ id }) => db.posts.where({ id }).limit(1),
});
// GET /_x/query/post-by-id?id=…  → 200 { id, title, … }  ·  404 X_NOT_FOUND
// await postById.client({ baseUrl })({ id })  → Promise<Row>
// await postById({ id })                       → readonly Row[]  (unchanged in process)
```

| Fact | Rule |
|---|---|
| The body | the FIRST row `sql` returns — the one every in-process `[0]` of the same read takes. Say `.limit(1)`: nothing counts the rest |
| No row | **404** `X_NOT_FOUND`, `@ultimat3/entity`'s code, whose fix prints the SQL. The policy runs first, so a caller it denies is still 403 |
| Page controls | `_first` or `_after` is **400** `X_INPUT_INVALID`, and neither is published |
| `rows:` | the envelope as usual, with the row as `data` |
| The MCP tool | the row itself, or `X_NOT_FOUND` — the route's answer on both counts, over `tools/call`. A declared `rows:` publishes the row as `outputSchema`, with no `rows` wrapper |
| Not changed | `read(input)`, `.as()`, `.page()` and `.live()` still answer rows. `useQuery` reads lists: a single read in an island is `.client()` or `queryClient` |

### Two spellings of that client, one URL

`.client({ baseUrl })` binds one read; `queryClient<Api['queries']>({ baseUrl })` binds every registered read at once, the way `rpc<Api['actions']>` does for writes. Both run `queryClientMethodFor`, so the URL cannot differ between them.

```ts
// apps/web/shared/client.ts — the app's one place for both
export const client = rpc<Api['actions']>({ baseUrl });         // writes
export const queries = queryClient<Api['queries']>({ baseUrl }); // reads
```

| Fact | Rule |
|---|---|
| When the map-wide one is the only option | a surface that may not import the feature — `site/`, where an edge into `app/` is `X_BOUNDARY_VIOLATION`. `.client()` needs the query object; `queryClient` needs only the `Api` **type** |
| Why two clients and not one | actions and queries are two registries (`defineApi`'s `actions:` and `queries:` keys) answering two methods. A read taken off the action client is a name that does not exist on `Api['actions']` — a compile error, which is the point |
| Types | the read's own `input` and row type. A list read answers `readonly TRow[]`, `limit(1)` included; a `single: true` read answers `TRow` and rejects with `X_NOT_FOUND` when the route 404s |
| Failures | the server's own code, off `problem+json` — `X_INPUT_INVALID` stays `X_INPUT_INVALID`. A gateway answering HTML, a network fault and a 2xx body that is not JSON are `X_CLIENT_TRANSPORT_FAILED`, the same code an action's client answers. It was `X_RPC_FAILED` until 21.0.0 |
| Rows are JSON | what `response.json()` parsed, exactly as `rpc` hands back. A query declares no output schema — row types come from the `SqlSource` its `sql:` returns — so a `Date` column arrives as the ISO string, and the surface that formats one converts at its `load` |
| `then` is not a read | the proxy answers `undefined` for it, so `await queries` resolves to the client instead of fetching `/_x/query/then`. Same rule in `rpc` |

## Owns / never

| Aspect | Rule |
|---|---|
| Projects to | HTTP GET, typed client hook, live subscription, cache entry with tags, MCP read tool |
| Owns | result shape + row-level filtering |
| Never | write, enqueue a job, send mail, read headers or cookies, authorize inside `sql` |
| Never | return partial data to satisfy a policy — filter rows in `sql`, decide yes/no in `policy` |

## `live: true` requires deterministic, bounded SQL

`x verify` rejects a live query without both an `orderBy` and a `limit`.

| Requirement | Why | Failure |
|---|---|---|
| `orderBy` on a total order | the matcher decides *enters / leaves / moves within* the result from the changed row alone | `x verify` error naming the query |
| `limit` | an unbounded result set has no bounded change buffer and no bounded reconnect snapshot | `x verify` error naming the query |
| No `now()`, `random()`, or non-deterministic function | the same `(input, row)` must always yield the same membership answer | `x verify` error naming the expression |
| No cross-tenant predicate | tenant scoping comes from `ctx`, not from `input` | `X_FORBIDDEN` at subscribe |
| The source reads as its subscriber's tenant | a sync node shares one read per `(query, input)` **per org**, in a context carrying that org — so `repo.list(limit)` needs no org argument on a live query, exactly as on a request | a source naming another org is `X_TENANCY_ACTOR_MISMATCH`; a subscriber with no org reading a tenant table is `X_TENANCY_ACTOR_ORG_REQUIRED` |

**A patched row lands where `order by` returns it** (`As of 2026-10`). The matcher, `from()`'s in-memory execution and the cursor fallback compare two values by the column's DECLARED kind, through `@ultimat3/entity`'s own comparator — `@ultimat3/query` has none. A `bigint()` or `decimal()` column orders by its digits (its row value is decimal text: `'9'` before `'10'`), a `uuid()` is a value whatever its case, a `timestamp()` is an instant. The kinds resolve from the entity declared on the table `from(name, …)` names; a relation no entity declares has none, and its digits compare as text — as a `text` column's do. A custom `SqlSource` calling `compareRows`, `matchesFilter` or `isAfterKey` passes `kindsOf(shape.entity)`; `compareValues` is gone.

A page is served `order by <declared keys>, "id" asc`, and so is a live window — `As of 2026-08`,
the initial window, the matcher's patch positions and the keyset re-read a reconnect resumes with
are one ordering. A row tied on every declared key lands where its id puts it, not after the tie
group, and not wherever the database happened to return it. `x queries describe <name> --json`
prints the order. A row that reaches the matcher with no `id` is `X_QUERY_NOT_PAGEABLE`, never a
patch aimed at a position no client holds.

A non-live query has none of these constraints — it is just a read.

## A sealed column never rides on a row

A query declares no output schema, so nothing parses a row on its way out. A `.sealed()` column
stays behind because the repository row does not enumerate it
([Sealed columns](Entities-And-Migrations#sealed-columns)), `As of 2026-10`.

| Projection | Sealed column |
|---|---|
| `GET /_x/query/<name>` — list, `Page`, `single: true`, the record envelope's `data` and `records` | absent |
| the MCP read tool, a `cache:` entry in a shared tier | absent |
| a live snapshot and every patch | absent |
| `query(input)` / `.as(actor, input)` called on the server | `row.password` reads the plaintext |
| a derived row — `rows.map((row) => ({ ...row, initials }))` | absent; the spread drops it |
| a derived row that names it — `({ id: row.id, token: row.token })` | **sent.** The only way to send a secret is to write its name |

| Refused | Code |
|---|---|
| `live: true` with a sealed column in `.where()` / `.compare()` / `.orderBy()` | `X_MATCHER_UNSUPPORTED` at subscribe — a change row carries no sealed column, so the window could be read once and never patched |

## Row-level policy filtering

Policy is not a subscribe-time gate that then trusts the stream.

| Moment | Check |
|---|---|
| Subscribe | `policy` evaluated against `{ input, actor }`. Denied → `X_FORBIDDEN`, no subscription created |
| Initial snapshot | every row filtered through the same policy |
| Each incremental patch | re-checked per row. A row that fails is **dropped, never sent** |
| Actor change (role revoked, org left) | the subscription re-evaluates; rows that no longer pass are delivered as `delete` ops |
| Actor moves to another org | the subscription is re-seated on that org's own window and sent its snapshot: a window is one tenant's, and two orgs never share one |
| A refused subscription, on the page | `useQuery`'s `failed` state carries the node's error as a branded `UltimateError` — its code, cause and fix — never `X_INTERNAL` |
| Topic guards (tier 1) | `X_TOPIC_FORBIDDEN` — cause names the actor and topic, never the topic's data |

One authz system. A live query cannot become a second door into your data — that is the failure mode that killed the `allow`/`deny` generation of frameworks ([The eight primitives](The-Eight-Primitives)).

## NULL

`As of 2026-08`, one rule for the generated SQL, the in-memory source behind `from()` and the live
matcher alike. `null` and a column the row omits are the same absence.

| Operator | NULL is | Generated SQL |
|---|---|---|
| `=` `!=` `in` | a value — it matches itself and nothing else | `is null` · `is not null` · `is distinct from` · `in (…) or is null` |
| `>` `>=` `<` `<=` | unknown — a NULL on either side matches nothing | `"col" > $n`, which already matches no NULL |
| `orderBy`, the cursor | the largest value: last ascending, first descending | `asc nulls last` · `desc nulls first` |

`where({ deletedAt: null })` emits `"deletedAt" is null` and binds no parameter. `= $1` with a NULL
argument is *unknown* in Postgres and unknown is never true, so before this the same read matched
every row from a memory source and no row from a driver. A cursor across a nullable sort key had
the defect one page later: page two stopped at the first NULL, and the rows behind it were
unreachable. `x queries describe <name> --json` prints the SQL that says so.

**Both pagination systems now answer this the same way, `As of 2026-08-24`.** `@ultimat3/entity`'s
repo cursor used to refuse a nullable sort key outright rather than answer where a NULL sorts; it
now writes the same two orderings down (`asc nulls last` / `desc nulls first`), carries the absence
in the cursor and reaches it in the seek. One answer, per axiom 1. What entity still refuses is
narrower and is not about ordering: a **nullable primary-key column** used as the tiebreak —
`null = null` is unknown, so two rows sharing a sort value are indistinguishable to the seek and one
of them is served twice or never ([Entities and migrations](Entities-And-Migrations)).

## Request memo (tier 1) dedupe

Three components on one page calling `liveFeed({ orgId })` resolve **one** query.

| Property | Behavior |
|---|---|
| Coverage | every query, `cache:` or not. `cache:` buys the tier behind the memo, never the memo itself |
| Store | a map per request context, keyed by query name + `input` fingerprint + the query's tags |
| Lifetime | one request. No cross-request reuse, no eviction policy to tune |
| Hit cost | ~0 |
| Concurrency | the entry is the read *in flight*, so a caller that races the first one joins it instead of starting a competing read |
| Scope safety | two actors never share an entry — each request has its own context, and `.as()` reads in a child of it |
| Authorization | parsing, the policy and `sql` run on every call. What the memo holds is the execution, never the decision |
| Failure | a rejection is evicted, so the next read in the request retries rather than replaying one failure |
| Invalidation | none — a write in the same request drops tier entries, not memo entries. `fresh: true` is the read-past, and what it read replaces the memo entry, so the next plain read of that key sees the write too |

Streamed `<Suspense>` holes ([Routes and render modes](Routes-And-Render-Modes)) are the common case: independent holes, one round trip to Postgres. The same memo is what keeps an uncached lookup called once per row of a list to one round trip — `As of 2026-08`, per row is what it used to cost.

The memo collapses the *same* read asked twice. Fifty *different* row lookups collapse one layer down, in the repo: `findById` issued across one microtask of a request is one `where "id" in (…)` ([Entities and migrations → Point lookups batch themselves](Entities-And-Migrations#point-lookups-batch-themselves)) — or, named on the chain instead of inferred from a loop, one `preload()` per relation ([Entities and migrations → Preload states a relation the loop would infer](Entities-And-Migrations#preload-states-a-relation-the-loop-would-infer)).

Fifty *counts* collapse neither way — one `count()` per row is fifty different questions, so nothing above the repo can batch them. The repo answers them in one statement instead: `db.likes.where({ orgId }).andWhere('postId', 'in', ids).countBy('postId')` is a map keyed by the column's values, biggest group first, with a value nothing matched absent rather than `0` ([Entities and migrations → A count per row is one grouped count](Entities-And-Migrations#a-count-per-row-is-one-grouped-count)).

## Audit: who saw what

`query({ audit: true })` writes one record per call into the sink an action's `audit: true` writes to — one contract, `@ultimat3/core`'s `AuditRecord` / `AuditSink`, one installed sink (`setAuditSink` from `@ultimat3/core` — `@ultimat3/action` no longer re-exports it, `As of 25.0.0`). `As of 2026-10`.

| Rule | |
|---|---|
| What is a call | `read(input)`, `.as()`, the HTTP GET, `.page()` — one record each. `sourceFor(…)` + `execute()` (how `@ultimat3/mcp` serves a tool): one per `execute()`, or one at the build when it is refused |
| A memo or cache hit | **recorded**, `replayed: true` — an audit of a read is who saw what, not what the database computed |
| Outcomes | `allowed` · `denied` (a policy refusal, before or after the input parse) · `failed` (an unparsed input, a spent rate limit, a throwing source) |
| `surface` | `server` · `http` · `mcp` — the same vocabulary an action's record uses |
| `name` | the export name. `action` holds the same value, **deprecated**, removed in 25.0.0 — read `name` |
| `primitive` | `'query'` (an action's record says `'action'`) — what tells a read from a write in one sink |
| `input` | the parsed input, never the raw payload; a persisting sink redacts it through `auditableInput` |
| rows | **never on the record**, as an action's result never is |
| Not recorded | `explain()`, `describeSql()`, the shared live window: built `unenforced`, no caller to attribute |
| No sink installed | `X_QUERY_AUDIT_SINK_MISSING`, before the input parse |
| The sink refuses | a denied/failed record: logged (`audit.sink.failed`), the caller gets the original error. An allowed record: the rows are withheld, `X_QUERY_AUDIT_SINK_FAILED` — a read commits nothing, so retry |

## Every cached query carries a tag

The contract. **Not yet a gate** — `As of 2026-08` `X_CACHE_UNTAGGED_QUERY` is reserved: no code path raises it, and `x errors explain X_CACHE_UNTAGGED_QUERY` refuses it ([Error codes → Reserved codes](Error-Codes#reserved-codes)).

| Case | Today |
|---|---|
| a cached query no tag covers | cached under a key no `invalidates` fan-out reaches — stale until its `ttlMs`, and forever without one |
| a tag no entity declares | `X_CACHE_TAG_UNKNOWN`, `fix: x manifest` — the opposite mistake, and the one that is enforced |
| the `x verify` gate | no step reads a query's tags. Nothing fails |

Until it is a gate, tag coverage is a review item, not a build error. Declare the entity tag — `tags()` / `entityTag()` in [Caching and invalidation](Caching-And-Invalidation).

## Subscription caps

Load shedding is a decision with a typed error, not a fall-over.

| Code | Trigger | Fix |
|---|---|---|
| `X_SUBSCRIPTION_LIMIT` | a socket, tenant or node reached a cap; the error names which scope refused, and which knob | `raise maxPerSocket / maxPerTenant / maxEntries on the LiveQueryRegistry (per socket, default 128), or unsubscribe unused live queries` — and a **channel topic** cap answers `maxTopicsPerSocket` / `maxTopicsPerNode` on the `ChannelHub`. All constructor options, none an `app.config.ts` field |
| `X_CURSOR_STALE` | resume cursor outside the change buffer and no snapshot path supplied | `pass 'snapshot' to resumeFrom() so the fallback path can re-snapshot instead of failing` |
| `X_TRANSPORT_UNAVAILABLE` | the fanout bus is unreachable | `x doctor transport` |

Verbatim shapes: [`packages/realtime/src/errors.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/realtime/src/errors.ts). Full index: [Error codes](Error-Codes).

## Testing

`x test live` — its own runner, its own fixture shape. Runs against a cloned Postgres plus an in-process replicator and in-process NATS.

| Asserted | Why it catches regressions |
|---|---|
| Initial snapshot | the `sql` is right, ordered, and bounded |
| Incremental patch on write | the matcher's enter/leave/update decision is right for the changed row |
| Reconnect delta | resume from an LSN produces the same state as a fresh snapshot |
| Policy-filtered row never delivered | the per-row re-check actually runs |

Every `query({ live: true })` emits a test covering snapshot + one patch + one policy-filtered row, green on the first run. Extend it as the query grows — an untested live query is a red build.

```
x test live --json
x verify              # runs all six test types
```

## Introspection

| Command | Output |
|---|---|
| `x queries list --json` | `name`, `live`, `capability`, `tags`, `ttlMs` — the table header is `cmd-registries.ts`'s own |
| `x queries describe <name> --json` | generated SQL, tag set, MCP tool shape |
| `x cache graph --json` | what a write to each tag evicts, including this query's entry |

## Rules

- One query per read shape. Two queries differing by a boolean is one query with a boolean `input` field.
- Filter rows in `sql`; decide yes/no in `policy`. Never mix.
- `live: true` needs `orderBy` + `limit`, always.
- Presence, typing indicators, and cursors are tier 1 channels forever — never model ephemeral state as rows ([Realtime](Realtime)).
- A cache miss must be correct and merely slower. No query may depend on a hit.
- NULL is a value to `=`/`!=`/`in`, unknown to `>`/`<`, and the largest value to `orderBy`. Never
  write a filter that reads a NULL a fourth way.
- One order, three readers: the generated SQL, the cursor and the live matcher all serve
  `<declared keys>, "id" asc`. Never sort a window by the declared keys alone.
- Cache keys are framework-generated. A hand-built key is a rejected PR.
