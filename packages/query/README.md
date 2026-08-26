# @ultimat3/query 🔎

A read. Optionally live. Never a mutation — writes are `action`.

```ts
import { query, t } from '@ultimat3/query';

export const liveFeed = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('feed:read'),
  live: true,
  mcp: { expose: true, description: 'The org feed' },
  sql: ({ orgId }) => db.posts.where({ orgId }).orderBy('createdAt').limit(50),
});

const rows = await liveFeed({ orgId });        // typed rows, policy enforced
```

Register once at boot: `registerQueries(await import('./live'))`. Export names become
query names, which the manifest, the live protocol and `/_x` all address.

## One declaration, five projections

Every projection is a method on the query itself. A query has no `.def`.

| Call | Gives |
|---|---|
| `liveFeed({ orgId })` | the rows, policy enforced, through the cache tiers |
| `liveFeed.as(actor, { orgId })` | the same read as another actor — the surrounding context is untouched, `null` is signed out |
| `liveFeed.page({ orgId }, { first: 20, after })` | one bounded page plus the signed cursor that continues it. There is no `offset` |
| `liveFeed.live({ orgId })` | the `LiveQuery` `@ultimat3/realtime` subscribes to, carrying the same policy object |
| `liveFeed.tool()` | the MCP read tool, named `liveFeed`. `tool().policy === liveFeed.policy`, and it reads fresh |
| `liveFeed.client({ baseUrl })` | `GET /_x/query/live-feed?orgId=…`, typed both ways |
| `liveFeed.describe()` | the manifest row |

The route on the other end of that client is `toQueryRoute(liveFeed)`, and — `As of 2026-08` —
`x dev` and a container both mount it for every registered read, the framework's job, not the
app's. The search string is coerced at the wire and validated by the read's own schema, so a bad
`orgId` is the query's `X_INPUT_INVALID` and a 400; the answer is `no-store`, because the URL
names no actor while the rows are scoped to one.

`queryClient` is the same method for **every** registered read at once — the read half of
`@ultimat3/action`'s `rpc`, and the one spelling available to a surface that may not import a
feature:

```ts
import { queryClient } from '@ultimat3/query';
import type { Api } from '../api';                 // a TYPE, so no module-graph edge

export const queries = queryClient<Api['queries']>({ baseUrl });
const [post] = await queries.publicPost({ slug }); // typed input, typed rows
```

Both spellings run `queryClientMethodFor`, so a read has one URL however it is addressed.

### Flight control — `createClientFlight`, opt-in

A typed read is one `fetch` and nothing else until a `flight` is installed. With one, N concurrent
identical reads become ONE dispatch, a fence can retire everything issued before now, and a failure
worth sending again is sent again on `@ultimat3/core`'s one backoff curve.

```ts
import { createClientFlight, isSuperseded, queryClient } from '@ultimat3/query';

declare const session: () => { userId: string };
declare const baseUrl: string;
type Api = { queries: Record<string, never> };

const flight = createClientFlight({
  principal: () => session().userId,   // dedup is OFF without this — see below
  retry: { attempts: 3 },              // default is `attempts: 1`, i.e. no retry
  deadlineMs: 10_000,
  limit: { maxConcurrent: 6, maxQueued: 12 },
});

export const queries = queryClient<Api['queries']>({ baseUrl, flight });

// A route change, a sign-out, a tenant switch: everything already issued stops being addressed
// to anybody, and every read still open is aborted.
flight.bump();
```

| Rule | Why it is that way |
|---|---|
| the dedup key is `[principal, url]`, and **no principal means no dedup** | a key that is only the URL lets one caller join another's still-open read across a sign-in or a tenant switch |
| a caller-supplied `signal` is **never** shared | the leader owns the request, so one caller's abort would cancel every other caller's read; refcounting joiners is the "correct" fix and this is the one that cannot be wrong |
| `{ fresh: true }` opts one read out | the case it exists for is "this read exists BECAUSE something just changed", which must not join a dispatch that left before the change did |
| every joiner parses its own rows | what is shared is the immutable body TEXT; handing two callers one array hands each of them the other's edits |
| a fenced answer is `X_SUPERSEDED`, never a failure | `isSuperseded(error)` is the read; a caller that cannot tell it from a refusal retries a request its own context has already replaced |
| an **unclassified** throw is not retried | core's `retryDecision` retries anything nobody classified — a caller's own `AbortError` included. A client retries a declared `retryable`/`retry-after`, plus a dispatch that produced no response at all |
| a deadline is `X_TIMEOUT` | core's code, already classified `retryable`, so a caller's own loop needs no table |

`createClientFlight` is **`@ultimat3/core`'s**, re-exported here: it is the same object
`@ultimat3/action` re-exports, because both packages are tier 3 and neither may import the other.
It shipped as a byte-identical copy in each; the copies are gone and every name is importable from
this package exactly as before.

Bundle cost is why `ClientFlight` is a TYPE inside `client.ts` and never a value: importing
`queryClient` alone from this package is **12,755 B** minified for the browser, and adding
`createClientFlight` is **17,912 B**. A caller who wants a plain typed fetch pays for none of it.
Expect ±376 B run to run — `Bun.build` 1.4.0 drops `@ultimat3/core`'s `schema-error-codes.ts` from
some builds even though `sideEffects` names it (issue #273).

The declaration is lifted too: `.input`, `.policy`, `.cache`, `.mcp`, `.isLive`. `sql` is not
among them — it lives in a private store inside `read.ts`, so `sourceFor` is the only thing
that can build a source and there is nowhere for a second authz path to hide. Something that
merely looks like a query (`kind: 'query'`, no declaration) is `X_QUERY_FOREIGN`.

### Skipping the policy costs a written reason

Two reads have no subscriber to decide about: developer tooling that returns the statement and no
rows (`explain`, `describeSql`), and the shared, subject-less window a sync node builds once per
`(query, input)`. Both say so, in words:

```ts
const source = await sourceFor(target, input, {
  unenforced: 'a scaffolded test asserts the SQL text; the policy is asserted separately',
});
```

A blank reason is refused before the source is built. It is a string and not a boolean for the
reason `@ultimat3/entity`'s `crossTenant(reason, fn)` is: `enforce: false` reads exactly like
forgetting the policy, and the reason is what tells the next reader which of the two it is.

## What each file owns

| File | Job |
|---|---|
| `query.ts` | the primitive, `describeQuery`, `queryHash` |
| `read.ts` | the one read path — `runQuery`, `sourceFor` — and the declaration store |
| `facade.ts` | binds each projection to the query; re-implements none of them |
| `mcp-tool.ts` | the MCP read descriptor |
| `client.ts` | the typed read client (browser-safe) |
| `http.ts` | the route projection — `GET /_x/query/<kebab>`, the URL the client derives |
| `naming.ts` | export name → wire path. The MCP tool name is the export name verbatim |
| `live.ts` | the `LiveQuery` descriptor `@ultimat3/realtime` subscribes to |
| `matcher.ts` | change event → minimal patch (`add` / `update` / `remove` / `refill`) |
| `pagination.ts` | `paginate()` — keyset pages over core's cursor codec |
| `sql.ts` | `explain()` — the generated SQL, verbatim |
| `cache.ts` | request memo + tag-keyed tier, one invalidation graph |
| `source.ts` | the `SqlSource` contract + `from()`, the in-memory reference |

## Live queries

`live: true` produces a descriptor with four parts:

| Part | Why |
|---|---|
| `shape` | the matcher patches from the shape, never by re-parsing SQL |
| `reads` | entities + tags this read depends on — the change-feed filter |
| `policy` | evaluated **per subscriber**, on subscribe and on every fanout |
| cursor | reconnect state: epoch + query hash + version + seek key |

### `subscribes:` — the one fact about a live read nothing can derive

```ts
import { from, type QueryPolicy, query, t } from '@ultimat3/query';

interface PostSummary {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: Date;
}

declare const feedRead: QueryPolicy;
declare const repo: () => Promise<readonly PostSummary[]>;

export const liveFeed = query({
  input: t.object({ orgId: t.uuid }),
  policy: feedRead,
  live: true,
  subscribes: ['posts'],   // the table `x db gen` grants REPLICA IDENTITY FULL
  sql: ({ orgId }) => from<PostSummary>('posts', repo).where({ orgId }).orderBy('createdAt'),
});
```

Logical replication carries no old row on an `UPDATE` unless the table is `REPLICA IDENTITY FULL`,
so no patch can be computed and `@ultimat3/realtime` refuses the subscription. The table name lives
inside `sql:` — a callback nothing can invoke without valid input — so `x db gen` has no way to
work it out and needs it declared.

Optional: a read that declares nothing behaves exactly as it did, and the generator emits nothing
for it. It is **checked, not trusted** — `toLiveQuery` refuses at the first subscribe when the
relation the read resolves to is not among the declared names (`X_QUERY_SUBSCRIBES_DRIFT`), because
a stale declaration grants the identity to the wrong table and leaves the right one unpatchable in
silence. An empty list, or one on a read that is not `live: true`, is refused at `query()`
(`X_QUERY_SUBSCRIBES_INVALID`). Naming more relations than the shape resolves to is legal — a join
reads relations the shape's single `entity` cannot name.

### Cursor tradeoff (the reconnect risk, stated plainly)

A cursor is not a snapshot. Resume re-runs the **bounded** query from the seek key
(`limit` rows, one indexed keyset read) instead of replaying a per-subscriber change
log, so a sync node holds no history and reconnect cost is O(limit). The price: the
cursor cannot prove that rows sorting *before* it are unchanged, so any epoch change —
new build, new policy, new schema — forces a full refetch instead of a resume. Bounded
server memory bought with an occasional extra page fetch.

## Matcher support

| Shape | Result |
|---|---|
| equality / `!=` / `in` / range filters | patched incrementally |
| `orderBy` (any number of keys) | insert position computed, moves become remove + add |
| `limit` | tail eviction on insert, `refill` patch on removal |
| joins, aggregates, `group by`, subqueries | `X_MATCHER_UNSUPPORTED` with a fix line |

An honest refusal beats a silently wrong result set, so unsupported shapes fail at
**subscribe** time, not on the first change event.

## `search()` — the query factory over a searchable entity

A model call is an `action` and a sweep is a `job`; a search is a **read**, so `search()` returns a
`query`. It inherits the policy, the cache tags, the MCP tool, the typed client, the route and its
manifest row — there is no ninth primitive.

```ts
import { type QueryPolicy, search, type SearchChain, t } from '@ultimat3/query';

interface PostRow {
  readonly id: string;
  readonly title: string;
  readonly createdAt: Date;
}

// `@ultimat3/entity`'s chain, crossed STRUCTURALLY: a real `db.posts` satisfies `SearchChain`
// as written, so this package holds no dependency edge on entity.
declare const db: {
  readonly posts: {
    where(filter: { readonly orgId: string }): {
      orderBy(column: keyof PostRow & string, direction: 'asc' | 'desc'): SearchChain<PostRow>;
    };
  };
};
declare const postRead: QueryPolicy;
declare const orgId: string;

export const searchPosts = search({
  input: { orgId: t.uuid },              // your own keys — `q` and `limit` are added
  policy: postRead,
  page: { max: 50, default: 20 },
  // The chain WITHOUT the term: tenancy, filters, and the order the page is served in.
  in: ({ input }) => db.posts.where({ orgId: input.orgId }).orderBy('createdAt', 'desc'),
});

// A query is CALLABLE — there is no `.run()`; `.as()`, `.page()` and `.client()` are the rest.
await searchPosts({ orgId, q: 'cats -dogs "exact phrase"' });
```

`search()` adds `.search(q)` and `.limit(limit)` and nothing else, which is what makes the term
unable to arrive any other way. A blank term is refused rather than answered with no rows — an
empty box is not an empty result set.

**It serves one page.** The rows come from the entity chain, which pages by its own signed cursor;
that cursor cannot cross the `SqlSource` seam, and slicing in memory instead would cut inside the
page the provider fetched and report `hasNextPage: false` at its edge. So a second page is
refused, and the `fix:` names the chain — `db.posts.search(term).after(cursor).page()`.

## Pagination is cursor-only

`offset` does not exist in this package on purpose: it makes the database count rows it
throws away (O(offset) per page), and any concurrent insert or delete before the offset
shifts every later page, so users see duplicates and holes. Cursors are opaque,
HMAC-signed, and bound to one query + arguments — a cursor from another query is
`X_CURSOR_INVALID`.

`query.page(input, { first, after })` is the only way to ask for one — `paginate` backs it and is
not exported, because a page is the read's own answer rather than an imported helper.

The codec lives in `@ultimat3/core`, not here: `encodeCursor`, `decodeCursor`,
`configureCursorSigning` (set the signing secret once at boot; rotating it invalidates every
open cursor) and `usesDevCursorSecret` are all imported from there. `As of 2026-08`, `x doctor`
reports `X_CURSOR_SECRET_DEV` when a production process is still signing with the key shipped in
the package, and rotating the secret is what invalidates every open cursor. This package supplies
the only thing that is its business — the scope, `queryHash(name, input)` — and re-exports
`CursorInvalidError` so the failure keeps its name on this surface.

The scope's hash is **SHA-256, first 16 hex** — `fingerprint` from `@ultimat3/core`, the primitive
and width `@ultimat3/entity`'s `planScope` already uses, and the same function
`@ultimat3/action`'s `requestHash` and `@ultimat3/realtime`'s `qid` are taken over `As of 2026-08`.
It was FNV-1a/32 until 2026-08 — 4×10⁹ values over input a client chooses, brute-forceable offline
in seconds, and a fingerprint here is a *sharing* key: which read-cache entry two callers are served
from, and which scope a cursor is bound to.

The canonical form is **injective**, which is the other half of the same requirement. It had no
`Date` branch until 2026-08: `Object.keys(date)` is `[]`, so every date rendered `{}` and one key
answered for every date window a read ever served — a real leak on the ordinary HTTP path, since
`coerceQuery` turns a `t.date` member into a `Date` and `input-shape.ts` permits `date` members. A
`Date`, a `Map` and a `Set` are tagged now. Ordinary inputs are byte-identical, so the cost is
confined to reads whose input carries one of the three: those cursors answer `X_CURSOR_INVALID`
once, with "request the first page again" as their fix, and their cache entries are cold once.

A cursor names a **position in the ordering**, never a row and never a count. Both seek paths
answer "is this row after that position?" through the one predicate, `isAfterKey`: `Builder.seek()`
compiles it to SQL — spelled out per key, so a mixed `createdAt desc, id asc` listing is a real
predicate rather than an id tiebreak — and `paginate()` applies the same comparison when a source
has no `seek()`. Filtering by position is what makes a delete between two pages harmless; locating
the cursor's row by id and slicing after it silently restarts the listing the moment that row is
gone. A row with no `id` cannot name a position at all: that is `X_QUERY_NOT_PAGEABLE`, not a
cursor signed over `"undefined"`.

Because the predicate always carries that id, the ordering carries it too: a paged read is served
`order by <declared keys>, "id" asc` — that list is `totalOrder(orderBy)`, exported for the reason
`isAfterKey` is — and the in-memory sort and the live matcher's insertion position read the same
one. Ordering by the declared keys alone leaves rows with equal sort values in whatever order the
database chose, while the cursor reads them as if id had decided — so one of a tied pair comes back
on both pages and the other on neither, and a row the matcher appends after a tie group is a
position no re-read returns.

A **live** read is served that way too, and `SqlSource.total()` is how it says so: the same read
with no cursor and no window, ordered `<declared keys>, "id" asc`. `sourceFor` calls it for
`surface: 'live'` and for nothing else, so the initial window, the patch positions the matcher
computes and the keyset re-read a reconnect resumes with are one ordering. A source that does not
implement `total()` is left alone — it already serves one order it can be resumed in.

## NULL

One rule, three readers: the SQL a source generates, the in-memory execution behind `from()`, and
the live matcher. `null` and a column the row omits are the same absence — `isNull` is the one
definition, exported for the same reason `isAfterKey` is.

| Operator | NULL is | Emitted as |
|---|---|---|
| `=` `!=` `in` | a value — it matches itself and nothing else | `is null` · `is not null` · `is distinct from` · `in (…) or is null` |
| `>` `>=` `<` `<=` | unknown — a NULL on either side matches nothing | `"col" > $n`, which already matches no NULL |
| `order by`, the cursor | the largest value: last ascending, first descending | `asc nulls last` · `desc nulls first` |

`where({ deletedAt: null })` compiles to `"deletedAt" is null` and binds no parameter: `= $1` with
a NULL argument is unknown in Postgres and unknown is never true, so that filter used to match
every row in memory and none in the database. The seek predicate had the same defect one page
later — `"publishedAt" > $1` is unknown for every draft, so page two stopped at the first NULL and
the rows after it were unreachable through a cursor. An ascending key now reaches them
(`("col" > $1 or "col" is null)`); a NULL cursor value drops its own term, nothing sorting after a
NULL under `nulls last`, and the page continues on the id tiebreak, which is never NULL.

`nulls last` / `nulls first` are Postgres' own defaults, written down rather than inherited: it is
the rule `compareValues` implements, so the in-memory sort and the seek predicate can only agree
with it, and a driver whose default differs cannot re-open the divergence.

## Caching

Request memo (same read twice in one render ⇒ one round trip), then the tier ladder
`@ultimat3/cache` has registered — `createCacheStack(registeredTiers())`, read down and promoted
up. Keys are `query:<name>:<authority>:<input fingerprint>:<tags>`. An action's `cache.invalidates`
and a query's `cache.tags` meet in the one graph owned by `@ultimat3/cache`, because there is one
registry and this package holds no store of its own.

**The authority is who the read was answered for, and it is not optional.** `sql(input, ctx)` is
handed the context and `@ultimat3/entity` derives every tenant predicate from `ctx.actor.orgId`,
never from the input — so a key made of the name, the input and the tags did not identify a read's
answer, and the process-wide tier served one org's rows to the next org that asked. `cache.scope`
declares who may be served one entry:

| `scope` | Key holds | Use it when |
|---|---|---|
| `actor` (default) | the actor's kind, id and org | anything. Declaring nothing gets this, and this is always correct |
| `tenant` | the actor's org — the actor itself when there is none | every member of one org sees the same rows |
| `global` | nothing | the rows are the same for everyone, signed-in or not |

The default is the mechanism: forgetting to declare a scope gives the narrowest key. Widening it
is a written statement about the rows, one `grep` away — the same shape `unenforced:` uses for a
skipped policy. `readAuthority(actor, scope)` is the only producer of the component, and it is a
required positional argument of `cacheKeyFor`, because an optional one is one a call site forgets.

**The fill is fenced, best-effort and single-flighted, and none of that is written here.**
`createCacheStack` samples `@ultimat3/cache`'s fence immediately before it runs the source and
re-asks it per rung before each write, so a bust that lands mid-read cannot be republished for the
whole TTL — the caller still gets the rows it read, because those are its answer; only publishing is
refused. Every tier call goes through `bestEffort`, so a Redis refusal is a miss rather than a
failed business read and shows up in `recentTierFailures()` under the name of the tier that
refused. Concurrent misses of one key share one `load()`. `@ultimat3/query` used to carry its own
copy of the first two and none of the third.

`cache.ttlMs` is refused at `query()` unless it is positive and finite
(`X_QUERY_CACHE_TTL_INVALID`): every tier refuses such a lease, so `ttlMs: Infinity` used to make
one read fail permanently at run time with a cause about a cache key.

An entry is written with the read's `cache.tags`, so a row bust (`post:1`) drops the lists that
held the row, exactly as `tagMatches` defines it — and `invalidateTags(tags)`, the call an action's
`cache.invalidates` makes, is the whole of what drops it. There is nothing to install and nothing
to wire: a `cache:` read fills the registered tiers, so a process that registered none reads
uncached rather than filling a store no fan-out can see.

A `cache:` block that omits `ttlMs` gets `DEFAULT_READ_CACHE_TTL_MS` (60s) rather than immortality.
Tags are the primary eviction; the TTL is the backstop for the read whose tags never fire. The
lease handed to the ladder is **relative** — the tier's own clock turns it into an expiry, so a
tier registered with a frozen clock is drivable end to end — and omitting it is how a tier is asked
for its own default. `@ultimat3/cache`'s tiers refuse a non-positive `ttlMs` and have no immortal
entry to offer, so there is no "never" to spell.

The memo entry is the read **in flight**, not its value, so "twice" covers reads that race as
well as reads that follow: five holes rendering concurrently share one execution and one tier
round trip. A rejection is evicted — a failed read is not the request's answer.

| Layer | Applies to | Lifetime |
|---|---|---|
| request memo (`readOnce`) | **every** query, `cache:` or not | the request — a `Ctx`'s identity is the key |
| tag-keyed tier (`readThrough`) | a query that declares `cache:` | `ttlMs`, or until an `invalidates` fan-out drops the tag |

`cache:` buys the tier, never the memo: an uncached lookup called once per row of a list would
otherwise cost one round trip per row. Parsing, the policy and `sql()` still run on every call —
the memo holds the execution, not the decision — and `.as()` reads in a child context, so an
impersonated read never joins one made as someone else.

`fresh: true` skips both on the way in, and **publishes into the memo on the way out**: it is how
a caller reads past a write made earlier in the same request, and the read it just made is the
request's answer from then on, so a later plain read of the same key joins it rather than the entry
the write moved past. Invalidation drops tier entries, not memo entries.

## `rateLimit:` — the read half, and it is enforced

```ts
rateLimit: { limit: 3, windowMs: 600_000 },   // 3 held, one back every three and a bit minutes
```

Symmetric with an action's, and for a reason: without it **every** `GET /_x/query/*` fell to the
`default` bucket — 120 burst, 2/s per actor — so one authenticated caller could hold 120
cross-tenant aggregates in flight and then 2/s indefinitely, from a single account, with no
declaration able to say otherwise. `toQueryRoute` sets the bucket NAME and the NUMBERS, and
`@ultimat3/http`'s `withRouteBuckets` registers them: a name alone falls through to `default`.
The conversion is `toBucket` from `@ultimat3/http` — the same one the action route uses, because
http owns `Bucket` and `action` is the same tier as this package. A pair the limiter cannot run
on is `X_RATE_LIMIT_INVALID`, at projection.

## `deprecated:` — a compat window, not a version

```ts
deprecated: { since: '2026-08-01T00:00:00Z', sunset: '2026-12-31T23:59:59Z', replacedBy: 'searchOrders' },
```

`Deprecation` (RFC 9745) and `Sunset` (RFC 8594) on every answer, a
`link: </_x/query/search-orders>; rel="successor-version"`, the dates on the descriptor, and a
`deprecated_calls_total{primitive,name}` counter so "is anyone still reading it?" has an answer
before the read is deleted. A date that cannot be rendered is `X_QUERY_DEPRECATION_INVALID` at
projection, not on the first read. Versioning is two deployments behind one ingress, never a
router feature here.

## Errors

| Code | When | Fix |
|---|---|---|
| `X_QUERY_DUPLICATE` | two queries under one name | rename one export |
| `X_QUERY_DEPRECATION_INVALID` | `deprecated:` with a `since`/`sunset` that is not a date | use an ISO-8601 instant |
| `X_QUERY_POLICY_MISSING` | registration without `policy:` | add `policy: can('…')` |
| `X_MATCHER_UNSUPPORTED` | live query the matcher cannot patch | reshape it, or `live: false` |
| `X_CURSOR_INVALID` | tampered / foreign / malformed cursor | request the first page again |
| `X_QUERY_NOT_PAGEABLE` | a paged or live read returned a row with no `id` | select the primary key: `db.<rows>.select({ id: true, … })` |
| `X_INPUT_INVALID` | input failed the Standard Schema | `x queries describe <name> --json` |
| `X_QUERY_UNREGISTERED` | used before `registerQueries()` ran | register at boot |
| `X_QUERY_FOREIGN` | a look-alike was projected as a query | declare it with `query({ … })` |
| `X_RPC_FAILED` | `.client()` got a non-`problem+json` failure | check the gateway in front of the app |

Denials re-throw the policy layer's own codes and keep the surface denial on
`QueryDeniedError.denial`, so a live socket closes with 4403 instead of guessing.

## Boundaries

Tier 3. Imports `@ultimat3/core`, `schema`, `cache`, `policy`. Never imports `action`,
`jobs` or `realtime` (same tier) — `realtime` consumes `LiveQuery` from here.
