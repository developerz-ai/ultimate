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
| `liveFeed.live({ orgId })` | the `LiveQuery` `@ultimat3/realtime` subscribes to, carrying the same policy object |
| `liveFeed.tool()` | the MCP read tool. `tool().policy === liveFeed.policy`, and it reads fresh |
| `liveFeed.client({ baseUrl })` | `GET /_x/query/live-feed?orgId=…`, typed both ways |
| `liveFeed.describe()` | the manifest row |

The declaration is lifted too: `.input`, `.policy`, `.cache`, `.mcp`, `.isLive`. `sql` is not
among them — it lives in a private store inside `read.ts`, so `sourceFor` is the only thing
that can build a source and there is nowhere for a second authz path to hide. Something that
merely looks like a query (`kind: 'query'`, no declaration) is `X_QUERY_FOREIGN`.

## What each file owns

| File | Job |
|---|---|
| `query.ts` | the primitive, `describeQuery`, `queryHash` |
| `read.ts` | the one read path — `runQuery`, `sourceFor` — and the declaration store |
| `facade.ts` | binds each projection to the query; re-implements none of them |
| `mcp-tool.ts` | the MCP read descriptor |
| `client.ts` | the typed read client (browser-safe) |
| `naming.ts` | export name → wire path + tool name |
| `live.ts` | the `LiveQuery` descriptor `@ultimat3/realtime` subscribes to |
| `matcher.ts` | change event → minimal patch (`add` / `update` / `remove` / `refill`) |
| `pagination.ts` | signed keyset cursors, `paginate()` |
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

## Pagination is cursor-only

`offset` does not exist in this package on purpose: it makes the database count rows it
throws away (O(offset) per page), and any concurrent insert or delete before the offset
shifts every later page, so users see duplicates and holes. Cursors are opaque,
HMAC-signed, and bound to one query + arguments — a cursor from another query is
`X_CURSOR_INVALID`.

## Caching

Request memo (same read twice in one render ⇒ one round trip), then the tier behind
`ReadCache`. Keys are `query:<name>:<input fingerprint>:<tags>`. An action's
`cache.invalidates` and a query's `cache.tags` meet in the one graph owned by
`@ultimat3/cache`.

## Errors

| Code | When | Fix |
|---|---|---|
| `X_QUERY_DUPLICATE` | two queries under one name | rename one export |
| `X_QUERY_POLICY_MISSING` | registration without `policy:` | add `policy: can('…')` |
| `X_MATCHER_UNSUPPORTED` | live query the matcher cannot patch | reshape it, or `live: false` |
| `X_CURSOR_INVALID` | tampered / foreign / malformed cursor | request the first page again |
| `X_INPUT_INVALID` | input failed the Standard Schema | `x queries describe <name> --json` |
| `X_QUERY_UNREGISTERED` | used before `registerQueries()` ran | register at boot |
| `X_QUERY_FOREIGN` | a look-alike was projected as a query | declare it with `query({ … })` |
| `X_RPC_FAILED` | `.client()` got a non-`problem+json` failure | check the gateway in front of the app |

Denials re-throw the policy layer's own codes and keep the surface denial on
`QueryDeniedError.denial`, so a live socket closes with 4403 instead of guessing.

## Boundaries

Tier 3. Imports `@ultimat3/core`, `schema`, `cache`, `policy`. Never imports `action`,
`jobs` or `realtime` (same tier) — `realtime` consumes `LiveQuery` from here.
