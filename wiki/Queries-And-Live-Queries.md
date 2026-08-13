# Queries and live queries

A `query` is a read. `live: true` makes it subscribable. Never writes, never enqueues, never sends mail.

v1.1.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). Tiers 1–2 of [Realtime](Realtime) ship in v1; `persist: true` (tier 3, local-first) lands in v2.

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
| `persist` | no — default `false` | tier 3. Swaps the client result store from memory to IndexedDB and makes the mutator queue durable. Implies `live: true`. v2 |
| `sql` | yes | `(input) => SqlSource`. `from()` (`@ultimat3/query`) wraps an already-resolved `@ultimat3/entity` repo call and restates `where`/`orderBy`/`limit` for the matcher to read back; `select`/`preload` happen inside that repo call, before `from()` ever sees a row. No ORM in the graph. SQL-transparent: `toSQL()` prints the statement verbatim so an agent can read it and self-correct |
| `mcp` | no — default not exposed | `{ expose: true, description }` makes the read an MCP tool. Opt-in, unlike an action: a read hands rows to an agent, so silence exposes nothing |
| `mcp.visibleTo` | no | roles that may see the projected tool; a caller whose role is not named gets ToolNotFound, never Forbidden — the policy still decides every call |
| cache tags | derived | acquired automatically from the tables `sql` touches. Never hand-declared on a query |

Nothing else is a query field. Sorting, paging, and filtering are `input` fields consumed by `sql`.

## The fluent surface

Every projection is a method on the query — `liveFeed.tool()`, never `toQueryTool(liveFeed)` — and every declared field is lifted onto it. A query has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `liveFeed(input, options?)` | the read | parse input → evaluate policy → build source → execute, through the cache tiers |
| `.as(actor, input, options?)` | the same read, as someone else | keeps the surrounding context whole — services, clock, locale, trace — and swaps only the actor. `null` is the signed-out caller |
| `.page(input, { first, after? })` | one bounded page | `{ rows, endCursor, hasNextPage }`. The cursor is signed and scoped to `queryHash(name, input)` — the query's name and its parsed input, never `first` or `after`, which are controls rather than scope. There is no `offset` and there never will be |
| `.live(input, options?)` | the subscription descriptor | a `LiveQuery` carrying the **same** policy object, re-evaluated per subscriber |
| `.tool()` | the MCP read tool | `liveFeed.tool().policy === liveFeed.policy`. Reads fresh: an agent diffing two calls must be reading rows, not a TTL |
| `.client({ baseUrl })` | the typed browser method | `GET /_x/query/live-feed?orgId=…`, keys sorted so one input is one URL |
| `.describe()` | the manifest row | name, capability, tags, ttl, `live` |
| `.input` `.policy` `.cache` `.mcp` `.isLive` | the declaration, lifted | readable. `sql` is not among them |

`sql` is unreachable by design. The declaration lives in a private store inside `read.ts` and `@ultimat3/query` exports no reader for it, so `sourceFor` is the only thing that can build a source — one read path and one authz path, structurally rather than by convention. A hand-rolled object with `kind: 'query'` is `X_QUERY_FOREIGN`, never a registered read.

`isLive` is the declared boolean; `live()` is the subscription itself. Every projection needs the name `registerQueries()` stamps on — before that, `X_QUERY_UNREGISTERED`.

## Five projections

| Projection | Derived from | Shape |
|---|---|---|
| HTTP GET | name + `input` | `GET /_x/query/live-feed?orgId=…`, errors as `UltimateError` JSON |
| Typed client hook | `input` + `sql` return type | `const feed = useLiveFeed({ orgId })` in `app/` — no fetch, no codegen step. Bound once with `liveHookFor`, below |
| Live subscription | `live: true` | WS frames `{qid, op, row, lsn}` patched into a Solid signal |
| Cache entry | tags from `sql` | key is the query name + a fingerprint of the parsed input + the sorted tag keys — the actor is not in it; see [Caching and invalidation](Caching-And-Invalidation) |
| MCP read tool | `input` + `policy` + name | one read tool per query, identical authz. See [MCP and AI](MCP-And-AI) |

### The typed client hook, precisely

`liveHookFor` (`@ultimat3/realtime`) binds one live query to one named hook. The binding is a line in `app/`, not a generated file — the types come off the declaration, so a wrong input key is a compile error in the component.

```ts
// app/feed/hooks.ts
import { liveHookFor } from '@ultimat3/realtime';
import { liveFeed } from '../posts/live';

export const useLiveFeed = liveHookFor(liveFeed);
```

```tsx
const feed = useLiveFeed({ orgId: actor.orgId }); // feed(), feed.state(), feed.cursor(), feed.unsubscribe()
```

| Fact | Rule |
|---|---|
| Types | the query's own `input` and row type. `useLiveFeed({ orgIdd })` does not compile, and `feed()[0].titel` does not compile |
| Transport | the subscription, not a fetch — the hook *is* `useLive` with the query's name and types already bound. One subscribe path, never two |
| Input | a value or a thunk, read **once**, at subscribe time. There is no reactive runtime at tier 3 to re-run it; new input is a new subscription |
| Naming | read per call, never at bind time — `registerQueries()` stamps the name at boot, after the module-level binding has already run |
| Lifetime | the caller owns `unsubscribe()`. This layer does not know what a mount is |
| A query without `live: true` | `X_QUERY_NOT_SUBSCRIBABLE`, thrown where the binding is written. A non-live read from a component is `query.client({ baseUrl })` over the HTTP GET below — a read that never patches has no subscription for a hook to hold |
| No registered client | `X_LIVE_CLIENT_MISSING`. One `setLiveClient` per app, in the entry, above the first render |

### The HTTP GET, precisely

Mounted for every registered query by `x dev` and by a container, from one composition — nothing to wire in the app.

| Fact | Rule |
|---|---|
| Method + path | `GET /_x/query/<kebab-export-name>`, the URL `.client()` derives with no server import |
| Input | the search string, coerced at the boundary (`t.number` from `"12"`) then validated by the query's own schema. Repeated keys are an array, and keys are sorted so one input is one URL |
| Bad input | **400** `X_INPUT_INVALID`, with `x queries describe <name> --json` as the fix — the same code and line every other surface of that read answers |
| Authz | evaluated once, inside the read, from the parsed input. `auth: 'public'` only for `allow()` — anything else is `required`, and an anonymous caller is 401 before the policy is reached |
| Caching | `no-store`. The URL names no actor while the rows are scoped to one, so a shared cache is something a CDN in front of the app configures knowingly. The read's own `cache:` tags ride along for a purge |
| Failures | `application/problem+json` carrying the code, cause and fix. A non-framework throw is the server's 500, never dressed as a read failure |

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

A page is served `order by <declared keys>, "id" asc`, and so is a live window — `As of 2026-08`,
the initial window, the matcher's patch positions and the keyset re-read a reconnect resumes with
are one ordering. A row tied on every declared key lands where its id puts it, not after the tie
group, and not wherever the database happened to return it. `x queries describe <name> --json`
prints the order. A row that reaches the matcher with no `id` is `X_QUERY_NOT_PAGEABLE`, never a
patch aimed at a position no client holds.

A non-live query has none of these constraints — it is just a read.

## Row-level policy filtering

Policy is not a subscribe-time gate that then trusts the stream.

| Moment | Check |
|---|---|
| Subscribe | `policy` evaluated against `{ input, actor }`. Denied → `X_FORBIDDEN`, no subscription created |
| Initial snapshot | every row filtered through the same policy |
| Each incremental patch | re-checked per row. A row that fails is **dropped, never sent** |
| Actor change (role revoked, org left) | the subscription re-evaluates; rows that no longer pass are delivered as `delete` ops |
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

A nullable sort key pages correctly here. `@ultimat3/entity`'s repo cursor refuses one outright at
mint time instead ([Entities and migrations](Entities-And-Migrations)) — two answers to the same
question, both explicit, neither silent.

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
| `X_LIVE_QUERY_LIMIT` | a tenant registered more distinct live queries than the cap | raise `realtime.limits.perTenantQueries` in `app.config.ts`, or narrow the query set |
| `X_SUBSCRIPTION_LIMIT` | a socket or tenant reached the subscription cap | `raise realtime.limits.perSocket in app.config.ts, or unsubscribe unused live queries` |
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
| `x queries list --json` | name, input schema, tags acquired, `live`/`persist`, policy |
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
