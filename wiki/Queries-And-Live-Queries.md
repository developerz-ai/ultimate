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
| `sql` | yes | `(input) => SqlSource`. Built with `from()` from `@ultimat3/query` or an `@ultimat3/entity` repo plan — no ORM in the graph. SQL-transparent: `toSQL()` prints the statement verbatim so an agent can read it and self-correct |
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
| Typed client hook | `input` + `sql` return type | `const feed = useLiveFeed({ orgId })` in `app/` — no fetch, no codegen step |
| Live subscription | `live: true` | WS frames `{qid, op, row, lsn}` patched into a Solid signal |
| Cache entry | tags from `sql` | key includes actor tenant + policy scope; see [Caching and invalidation](Caching-And-Invalidation) |
| MCP read tool | `input` + `policy` + name | one read tool per query, identical authz. See [MCP and AI](MCP-And-AI) |

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

## Request memo (tier 1) dedupe

Three components on one page calling `liveFeed({ orgId })` resolve **one** query.

| Property | Behavior |
|---|---|
| Store | AsyncLocalStorage, keyed by query name + parsed `input` + actor tenant + policy scope |
| Lifetime | one request. No cross-request reuse, no eviction policy to tune |
| Hit cost | ~0 |
| Concurrency | the entry is the read *in flight*, so a caller that races the first one joins it instead of starting a competing read |
| Scope safety | two actors in the same process never share an entry — the scope is in the key |
| Invalidation | dropped immediately when a write in the same request invalidates a tag it carries |

Streamed `<Suspense>` holes ([Routes and render modes](Routes-And-Render-Modes)) are the common case: independent holes, one round trip to Postgres.

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
- Cache keys are framework-generated. A hand-built key is a rejected PR.
