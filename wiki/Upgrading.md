# Upgrading

**`As of 2026-08`. Semver applies from here.** A breaking change to a documented API needs a major. Every `@ultimat3/*` version is pinned exactly and moves in lockstep — never mix versions.

**Eleven majors have shipped, and this page walks all eleven** — 2.0.0's 33 entries joined it `As of 2026-08`, and `scripts/changelog-check.ts` now refuses a summary row whose section the page does not carry, which is how they were missing for six releases. [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) is the source; none ships a codemod, so every entry is a manual edit the entry itself names. **One section per major**, newest first — read the ones between your pin and your target, oldest first.

| From → to | Breaking entries | Read |
|---|---|---|
| 12.x → 13.0.0 | **2**, both narrow: a service factory's parameter type, and one deleted `PageLike` member with zero call sites anywhere in the repository | the `13.0.0` section, in order |
| 11.x → 12.0.0 | **16**, from the widest sweep since 4.0.0 — a keyset defect that dropped rows, a name that reached the DDL unchecked, and eight interfaces that gained a member | the `12.0.0` section, in order |
| 10.x → 11.0.0 | **7** | the `11.0.0` section, in order |
| 9.x → 10.0.0 | **19** | the `10.0.0` section, in order |
| 8.x → 9.0.0 | **5** | the `9.0.0` section, in order |
| 7.x → 8.0.0 | **6** | the `8.0.0` section, in order |
| 6.x → 7.0.0 | **4** | the `7.0.0` section, in order |
| 5.x → 6.0.0 | **7** | the `6.0.0` section, in order |
| 4.x → 5.0.0 | **2**, over six surfaces, each a declaration that promised what the code did not do | the `5.0.0` section, in order |
| 3.0.0 → 4.0.0 | **25**, from a sweep that closed every known gap | the `4.0.0` section, in order |
| 2.0.0 → 3.0.0 | **10**, all from a five-agent bug sweep | the `3.0.0` section, in order |
| 1.x → 2.0.0 | **33** | the `2.0.0` section, in order |
| 1.x → 13.0.0 | **136** | all twelve sections, oldest first |

An entry is a line `CHANGELOG.md` marks `BREAKING —`. The count is derived, never curated:

```sh
grep -cE '^(- \*\*|### )BREAKING —' CHANGELOG.md
# 136 As of 2026-08-25 — the WHOLE file, and all 136 sit inside the section of the major that
# shipped them: the sum of the twelve per-major rows above. `[Unreleased]` holds none, which is what
# a released commit looks like — a `BREAKING —` line left there at a tag is
# X_DOC_CHANGELOG_UNRELEASED_BREAKING, and the release promotes the section rather than appending one.
# Scope the count to one section to read a single row. The range is that section's own heading line
# to the line before the next `## `, and `grep -n '^## ' CHANGELOG.md` prints both —
#   sed -n '<start>,<end>p' CHANGELOG.md | grep -cE '^(- \*\*|### )BREAKING —'
# Line numbers are deliberately not written here: every release moves them.
# `bun run changelog-check` compares both directions: each row against its OWN section, and the
# line above against the file.
```

Each entry changes a surface the table below covers.

> **Move to whatever `latest` is** — only the [footer](_Footer) stamps the number, because a version written into a page goes stale on the next tag. All 31 workspaces resolve at one version — 29 `@ultimat3/*` plus the unscoped `create-ultimate`, `@ultimat3/scraping` and `@ultimat3/flags` included — and every tarball since 3.0.0 was published by the release workflow with a provenance attestation. Resolve before you pin, never take it from this page:

| Check | Command | Answer that means "go" |
|---|---|---|
| what `latest` is | `npm view @ultimat3/core version` | the version you are pinning |
| that a package resolves at it | `npm view @ultimat3/scraping@<version> version` | that version, not `E404` |
| that the tarball is attested | `npm view @ultimat3/core dist.attestations` | a `provenance` object |
| every name that must move together | `bun run scripts/release-workflow.ts --json` | the 30 derived names — check each |

## 12.x → 13.0.0, entry by entry

**Two breaking entries**, and both are compile errors the moment you upgrade. Nothing changes at
runtime, no data migrates, no cursor or protocol moves. This major is wide in what it ADDS —
notifications, full-text search, webhooks, exports, state machines, form binding — and narrow in
what it breaks.

**No `app.config.ts` key moves.** No codemod: each entry names its own manual edit.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `ServiceFactory` receives `CtxFacts`, not `Ctx` | your `defineService` factory annotates its parameter `(ctx: Ctx)`, or reads a **sibling service** off it |
| 2 | `PageLike.content()` is deleted | you called it in an e2e test, or implement `PageLike` yourself |

### 1. `ServiceFactory` receives `CtxFacts`

`defineService`'s factory is handed the framework's own facts — `actor`, `now()`, `clock`, `tz`,
`locale`, `requestId` — and **not** the app's augmented services. It always worked this way; the
type said otherwise.

```ts
// before — compiles, and is circular: the factory that BUILDS ctx.posts
// declares that ctx.posts must already exist
export const posts = defineService('posts', (ctx: Ctx) => ({ … }));

// after — the documented form, which cannot drift from the signature
export const posts = defineService('posts', (ctx) => ({ … }));
```

Drop the annotation. If you genuinely need to name the type, `CtxFacts` is now exported from
`@ultimat3/core` — it was the parameter type all along and the barrel never re-exported it, so no
app could name what its own factory was handed.

**Reading a sibling service inside a factory no longer typechecks.** That was already documented as
unsupported — factories run in registration order and a sibling may not exist yet — but the type
permitted it. Move the read into the method that needs it, where `useService()` resolves at call
time.

### 2. `PageLike.content()` is deleted

`PageLike`'s comment claimed *"every member is one the reference app's e2e suite already calls"*.
An audit found that false for three of eleven: `content()` had **zero call sites anywhere in the
repository**, and `title()` / `reload()` are named only by `x g route`'s generated template, which
nothing executes.

`content()` is gone. `title()` and `reload()` stay, with the caveat recorded on each. If you drive
a browser yourself, delete `content` from your `PageLike` implementation; if you called it, read the
DOM through `evaluate()` instead.

## 11.x → 12.0.0, entry by entry

**Sixteen breaking entries**, in three groups. **Eight** are compile errors the moment you upgrade
(4, 5, 6, 8, 9, 13, 14, 16). **Four** need an action before or at the deploy and nothing fails to
compile (1, 2, 3, 11) — every persisted pagination cursor stops working, rows sharing a sort value
change order, one index migration, and **`sync` nodes and browser clients must ship together**. The
last **four** are visible only to a caller at runtime (7, 10, 12, 15).

**No `app.config.ts` key moves**, because the surface this major opens never had one: `AppConfig` has
never carried an `http` member, so `configureHttp()` is an addition and not a migration — see the
last table. No codemod: every entry names its own manual edit.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | every cursor minted before 12.0.0 is `X_CURSOR_INVALID` | you persisted a cursor — in a URL, a job payload, a client store. Nothing fails to compile |
| 2 | the primary-key tiebreak takes the **last declared** key's direction | you depended on the order of rows sharing a sort value. Nothing fails to compile |
| 3 | an index declaring `where` or `order` is renamed `<table>_<cols>_<hash8>_idx` | you declared one — **a migration, before the deploy** |
| 4 | a physical column or table name must be `[a-z_][a-z0-9_$]*`, at most 63 bytes | you wrote `.column('createdAt')` or an `entity(name)` / `table` that is not lower-snake |
| 5 | `Repo` gains `aggregate` and `approximateCount`; `ReadBuilder` gains five terminals | you implement `Repo` or `Driver` yourself |
| 6 | `Operator` gains `contains`, `contained-by`, `overlaps`, `has-key` | you `switch` exhaustively over `Operator` |
| 7 | `introspect()` returns app tables only | you read its output, or assert how many catalog queries it issues |
| 8 | `rateLimitKey` is deleted; `RateLimitConfig.tenantBucket` is required | you called `rateLimitKey`, or built a full `RateLimitConfig` |
| 9 | `Ctx` gains a required `deadlineAt` | you hand-build a `Ctx` — a test fixture, a custom host |
| 10 | `traceHeaders()` sends the remaining request budget | never for the caller; a downstream service now receives `x-request-timeout-ms` |
| 11 | `PROTOCOL_VERSION` 1 → 2, and five realtime exports are deleted | you imported one — and **every** deployment redeploys clients and `sync` nodes together |
| 12 | MCP rate limits are enforced, 120 read / 20 write per minute per actor | an agent exceeded them; it was previously unmetered |
| 13 | `memoryAuditSink()` is bounded at 1,000 and discards oldest-first | you used it as a system of record, or implement `MemoryAuditSink` |
| 14 | `RouteBudget.css`, `.cls` and `.tbt` are deleted | you declared one — it was ignored, and now it does not compile |
| 15 | `claim({ queues: [] })` is refused; the memory driver's `claim` is `async` | you call a `JobDriver` directly |
| 16 | `DoctorProbe` gains a required `database()` | you implement `DoctorProbe` |

### Entries 4, 5, 6, 8, 9, 13, 14 and 16 — a compile error the moment you upgrade

**4. Spell every physical name lower-snake.** `X_INVARIANT_VIOLATED` at `entity()`, before any
statement runs.

```diff
- createdAt: timestamp().column('createdAt'),
+ createdAt: timestamp().column('created_at'),
```

A **derived** name is unaffected: `columnName` is `meta.name ?? snake(property)` and `snake()`
lower-cases, so `createdAt: timestamp()` still writes `created_at`. What changed is that the derived
branch is now checked too — for three majors only `meta.name` was, so a property named
`n" , "x" text); drop table t; --` put a real `drop table` inside a generated `create table`.
Quoting is not a defence against a value that can close the quote. `entity(name)` and `table` go
through the same assertion.

**5. Implement the two new `Repo` members, or stop hand-rolling one.** `TS2739`.

```diff
  const repo: Repo<Post> = {
    findById, findMany, insert, update, delete: remove, count, countBy,
+   aggregate: (fn, column, args) => driverAggregate(fn, column, args),
+   approximateCount: async () => null,        // `null` is "never analysed", and always legal
  };
```

`approximateCount` may answer `null` unconditionally — that is the documented value for a table
nobody has `ANALYZE`d, and every caller already handles it. `aggregate` cannot be stubbed the same
way: a wrong number is worse than no number, so raise `X_AGGREGATE_UNSUPPORTED` if you will not
implement it.

**6. Widen the `switch`.** `TS2366`, or a silent fallthrough if it had a `default`.

```diff
    case 'is-not-null': return sql`${col} is not null`;
+   case 'contains':      return sql`${col} @> ${bind}`;
+   case 'contained-by':  return sql`${col} <@ ${bind}`;
+   case 'overlaps':      return sql`${col} && ${bind}`;
+   case 'has-key':       return sql`${col} ? ${bind}`;
```

The four exist so a declared `json()` or `arrayOf()` column is no longer write-only from the query
language.

**8. `rateLimitSpends` answers a LIST, not a key.** `TS2305`.

```diff
- const key = rateLimitKey(route, ctx);
- await limiter.assert(key, bucket);
+ for (const spend of rateLimitSpends(route, ctx, config)) {
+   await limiter.assert(spend.key, spend.bucket);
+ }
```

One request spends the caller's bucket and then the tenant's, stopping at the first refusal. The old
builder answered `actor` **else** `org` **else** `ip`, exclusively — and the anonymous actor answers
`null` for both of the first two — so no HTTP request ever spent an org bucket. `RateLimitConfig`
gains a required `tenantBucket: string | null`; `null` is "this app has no per-tenant allowance",
which is the default and the previous behaviour.

**9. Add `deadlineAt` to a hand-built `Ctx`.** `TS2741`.

```diff
  const ctx: Ctx = {
    requestId, traceId, locale, tz, buildId, role, actor, now,
+   deadlineAt: null,        // null is "no deadline", which is what a job or a test has
  };
```

`createContext({ … })` already defaults it, so only a literal pays. It is what
`remainingBudgetMs(ctx)` reads and therefore what entry 10 propagates.

**13. `memoryAuditSink()` is not a system of record.** The interface break is `TS2739` on
`size`/`dropped`; the behaviour break is silent.

```diff
- setAuditSink(memoryAuditSink());
+ setAuditSink(postgresAuditSink({
+   executor: { query: (text, values) => db().query({ text, values }) },
+ }));
```

Past 1,000 records the memory sink drops the **oldest** on every write, so an audited action can run,
succeed, be recorded and leave nothing behind. `{ maxRecords }` raises the bound and does not remove
it. `dropped` is non-zero exactly when the sink is telling you it is the wrong one. `x_audit` is
applied at boot beside the jobs, idempotency and rate-limit tables, so there is no migration to write.

**14. Delete the budget key.** `TS2353`.

```diff
  budget: {
    js: '40kb',
-   css: '12kb',
-   cls: 0.1,
  },
```

There is nothing to replace them with. All three were declared on the route contract, flattened away
by `registerRoute` — which projects a budget to `budgetJs` + `budgetLcp` and nothing else — and read
by no consumer anywhere, so a declared CSS budget was ignored while the `budgets` step reported
green. A new budget key is now a build error until the descriptor projects it
(`_EveryBudgetKeyIsProjected`, `packages/render/src/type-pins.tsx`). `budget.lcp` survives and is
**published, not enforced**: nothing in the build observes a paint.

**16. Implement `DoctorProbe.database()`.** `TS2741`. Only a hand-written probe pays — `x doctor`'s
own is unchanged.

```diff
  const probe: DoctorProbe = {
    bunVersion, root, port, production, devCursorSecret, devStorageSecret,
+   database: () => probeDatabase(process.env['DATABASE_URL']),
  };
```

`x doctor` answered "shippable" while probing the web port alone: a wrong password or a database that
does not exist accepts the socket and refuses the session, which a port check cannot see. It now
probes both ports and the database.

### Entries 1, 2, 3 and 11 — do this before the deploy

**1. Drop every persisted cursor.** Nothing fails to compile; a stored cursor is refused at decode
with `X_CURSOR_INVALID`.

| Where a cursor lives | Do this |
|---|---|
| a URL a client holds | nothing — request the first page (`after: null`) and re-mint |
| a job payload, a resumable `inBatches()` position | re-enqueue from the start, or from a business key of your own |
| a client store, a saved view | clear it on the version bump |

Two changes make an old cursor unreadable, and both were forced by one defect. A `timestamp()` sort
key is now carried as a **microsecond epoch** rather than an ISO string, because `ORDER BY` evaluates
`timestamptz` at microsecond precision while the seek treated a whole millisecond as one equality
class — two different equality classes over one page boundary. Reproduced against Postgres 16: three
rows inside one millisecond, uuid-v7 ids, `orderBy('createdAt','desc').limit(1)` returned **1 of 3
rows and stopped**, every time. And every entry is **tagged** — `~` for an absent value, `!` before a
present one — so an absence can be told from the text that spells it, which is what nullable sort
keys need.

The seek is now a plain `<` / `>` / `=` against `$n::timestamptz`; `nextMillisecond` and the
`>= v and < v + 1ms` window are gone. A read ordered by a `timestamp()` column carries one extra
output column on the wire, `"<col>$US"` — a name no entity can declare, stripped by `decodeRow`, so
it reaches no caller's row. **Only a test that asserts SQL text sees it**, which is exactly the suite
that hid this defect for three majors.

**2. The default total order is uniform-direction.**

```diff
- ORDER BY created_at DESC, id ASC
+ ORDER BY created_at DESC, id DESC
```

`totalOrder` appends the primary key in the **last declared** key's direction rather than always
ascending, so `orderBy('createdAt','desc')` runs `created_at desc, id desc`. **Rows sharing a sort
value come back in the opposite order to before**, and no page is lost either way — the seek matches
the order it is built from.

Two things follow. A mixed-direction order was un-indexable by this framework's own index DSL, so the
default one could never be served by a declared index. And a uniform order is now emitted as a row
comparison `(a, b) < ($1, $2)`, measured on PG16 as an `Index Only Scan` against `BitmapOr` + `Sort`
for the or-chain. The or-chain remains for an order you wrote as mixed yourself, and for one whose
keys are not all `NOT NULL`: a row comparison has no null ordering, so a NULL on either side makes
the whole comparison unknown.

**3. Rename the indexes that declare `where` or `order`.** A declared index is matched by name, so
the old one is not dropped and the new one is not created until you say so.

```sh
x db gen "rename partial and ordered indexes"   # then read the emitted up/down before applying
```

```sql
-- what the generated migration looks like, one pair per affected index
alter index posts_author_id_idx rename to posts_author_id_9f2c1ab4_idx;
```

The discriminator is `sha256("<order>|<where>")`, first 8 hex. **Plain and `unique()` names are
unchanged**, deliberately: Postgres names a column-level `unique()` index `<table>_<column>_key`
itself, so a discriminator there would make the generator emit a second `create unique index` for an
index that already exists (`42P07`), and a foreign key's own index is deduped against a hand-declared
one by the plain name.

Without it, two **different** partial indexes on one column were one name — `posts_author_id_idx` for
both `where status = 'published'` and `where status = 'draft'` — and the second was dropped with no
error, no warning and no drift finding. So this migration may create an index you declared years ago
and never had. A name over 63 bytes is now refused at declaration rather than truncated by the server
in silence.

**11. Redeploy clients and `sync` nodes together.** `PROTOCOL_VERSION` moves 1 → 2 and a skewed peer
is refused with `X_PROTOCOL_VERSION`, in **both** directions — a cursor rides the client's `subscribe`
and the node's `snapshot`, and the deleted fields were decoded through `str()` / `num()`, which throw
on absence. There is no rolling window in which the two versions interoperate.

```diff
- import { digestOf, DIGEST_UNVERIFIED, fnv1a } from '@ultimat3/realtime';
+ // nothing replaces them
```

`LiveCursor.digest` and `LiveCursor.count` are gone with them. Every snapshot ran `canonicalJson`
over every row and hashed it for a value no code path read — a full serialize-and-hash of every
result set, per live query, per reconnecting socket, in the restart storm this package is benchmarked
on. `count` would have been wrong had it ever gained a reader: `advance` seeds its set from the
already-truncated `ids`, so a delete past `CURSOR_ID_LIMIT` never decremented it. `@ultimat3/flags`
and `@ultimat3/ai` keep their own `fnv1a` and are untouched.

### Entries 7, 10, 12 and 15 — a caller can see the difference

**7. `introspect()` returns app tables only.**

| Relation | Before | Now |
|---|---|---|
| an ordinary or partitioned table | returned | returned |
| a view, a materialised view, a foreign table | returned | **excluded** |
| anything Postgres records as extension-owned (`pg_depend`, `deptype = 'e'`) | returned | **excluded** |
| a table someone created by hand | returned | returned, and still `unexpected-table` |

`IntrospectOptions.exclude` no longer decides the set on its own — it narrows what survives the rule
above, and cannot bring an excluded relation back. **This is what makes a stock managed Postgres
deployable**: `create extension pg_stat_statements` in `public` is the CNPG, RDS, Supabase and Neon
default, and its view read as `unexpected-table` with `x db gen "add pg_stat_statements"` as the
printed fix — so every deploy failed terminally and following the fix would have written an
extension's internal view into the app's migration set. Ownership rather than a name prefix, because
that rule covers the view and misses PostGIS's `spatial_ref_sys`.

**Edit only if a test asserts the statement count**: it issues four catalog queries where it issued
three.

**10. A downstream service now receives `x-request-timeout-ms`.** No edit on the calling side —
`traceHeaders()` is spread by both typed clients before your own headers, so an explicit value still
wins.

| Situation | Header sent |
|---|---|
| in a request with 12s left of its budget | `x-request-timeout-ms: 12000` |
| in a request whose budget is spent | none — **never `0`**, which the far side reads as "the caller asked for nothing" |
| in a job, a test, a browser | none; there is no ambient deadline |

The receiving end may only be **shortened** by it: `resolveTimeoutMs` takes the minimum of its own
configured budget and the header. Before this, a 30s gateway budget already spent to t=29 handed the
next service a fresh 30s, so work ran for another half minute holding a pool slot and a vendor
connection after the caller's socket had already been answered `X_TIMEOUT`.

**12. MCP callers are metered.** 120 read and 20 write per minute, per actor, per class —
`X_MCP_RATE_LIMITED`, 429, with `Retry-After`.

```ts
mcpHttpRoute({ server, resolveToken, rateLimits: { read: 600, write: 60 } });
// or defineAppMcp({ …, rateLimits: { read: 600, write: 60 } })
```

A `tools/call` naming a `destructive: true` tool spends `write`; **so does any call this server
cannot resolve**, fail-closed, so a probing client never gets the cheap bucket. Everything else,
`initialize` included, spends `read` — a coarse per-route rule would have thrown an agent off on its
handshake. The key names the actor and never reaches the caller.

**Behind more than one replica, pass the store too** — the default counts per process, which is
honest for `x mcp serve` and a lie for N replicas behind one URL, each enforcing the full allowance
on its own:

```ts
mcpHttpRoute({ server, resolveToken, rateLimitStore: postgresRateLimitStore({ executor }) });
```

`X_MCP_RATE_LIMITED` is its own code and not `X_RATE_LIMITED` because the knob differs: that one's
`fix:` names the HTTP pipeline's buckets, which do not govern this route, so raising them would run
and change nothing.

**15. Name the queue.** `X_JOB_CLAIM_QUEUES_EMPTY` from both drivers.

```diff
- await driver.claim({ queues: [], limit, visibilityTimeoutMs, workerId });
+ await driver.claim({ queues: ['default'], limit, visibilityTimeoutMs, workerId });
```

An empty list named no queue and meant two different things: **every** queue on the memory driver,
**the `default` queue** on Postgres, with `ClaimOptions.queues` documenting neither. Each meaning is
silently wrong in the other's deployment — one takes work this worker was never configured for, the
other drains nothing and reads as an idle queue. There is no third meaning to pick.

`createWorker` passes exactly one queue per pass, so only an embedder calling a driver directly is
affected. The memory driver's `claim` is now `async` to raise the refusal, so a caller that read its
return synchronously gets a `Promise`.

### Added and fixed in the same release, and none of it costs an edit

Read these if you built a workaround for one.

| Change | What it means |
|---|---|
| **read replicas** | `DATABASE_REPLICA_URL` plus a `withReplicaReads(fn)` scope. Opt in **twice** and byte-identical when unconfigured. Read-your-writes is the rule, not an option: one write at any depth pins the rest of the scope to the primary, and a transaction is always the primary's. Three consecutive replica failures park it for ten seconds. **The URL must name a read-only standby** |
| **`configureHttp()`** | the entire HTTP tuning surface — CORS origins, body limit, request timeout, max in-flight, rate-limit buckets — was reachable from **no app config key that existed**. `AppConfig` has never had an `http` member, so every `fix:` line naming `http.<key>` in `app.config.ts` resolved against nothing. Call it at module scope in a file under `apps/*/`. `rateLimit.scope` stays boot-owned |
| **a durable audit sink** | `postgresAuditSink({ executor })`, append-only, no purge — retention is a legal question with a different answer per app. The row is a fixed allow-list and never a walk of the `Ctx`, which on an HTTP surface carries the caller's `Authorization` and `Cookie` |
| **aggregates and containment** | `sum` / `avg` / `min` / `max` / `approximateCount`, and four containment operators. `min`/`max` on text is refused (Postgres orders by collation, JS by code unit); `avg` over money is refused, naming `sum()` + `count()` |
| **nullable sort keys order** | `asc nulls last` / `desc nulls first`, with the null position carried in the cursor. Only a nullable **primary-key** column is still refused — `null = null` is unknown, so the tiebreak cannot break a tie. The refusal also moved to plan time: it used to fire only when a next page existed, so it was green on 15 seeded rows and `X_INVARIANT_VIOLATED` on the first real read |
| **a `policy` gate step**, twentieth | every permission an app grants or requires must be one it declares. the scaffold shipped an app that answered `X_PERMISSION_UNKNOWN` on two of its three routes — status 500 — under a green gate. It skips in the framework monorepo, which declares no roles |
| **`X_MANIFEST_MISSING`** | an app root with no `x.manifest.json` fails the `manifest` step. Nothing ever ran `x manifest`, so the file did not exist in any app `x new` produced while the step reported green. Run `x manifest` once and commit it |
| **`scripts/declaration-readers.ts`** | every leaf key of every primitive declaration needs a reader in shipped source. 173 leaves across 18 roots, ratchet at zero |
| MCP `minLength` / `maxLength` count code points | the validator counted UTF-16 code units while the schema that publishes those numbers counts code points, so an astral-character argument was passed and then refused by the action's own parse, or refused outright on a bound the agent had obeyed |
| `x i18n add <locale>`, `x dev --port N` | a locale file that turned the gate red printing a fix that repaired nothing; and a dev server dying on port N+1 with a caught `Error` rendered into the cause and `X_CLI_UNEXPECTED` rather than a stable code |

## 10.x → 11.0.0, entry by entry

**Seven breaking entries, from a shutdown, cache and disclosure sweep.** Four are compile errors the
moment you upgrade. Three are not — and one of those changes what a CDN is allowed to store for a
signed-in visitor, so read entries 3, 4 and 5 even if nothing here fails to compile. **No
`app.config.ts` key moves in this major**, so there is no config edit to start with. No codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `isrKey(url, locale)` takes the negotiated locale, and it is part of the store key | you call `isrKey` — the document a multi-locale `isr` route serves changes either way |
| 2 | `IsrStore` gains a required `markStale(path)` | you implement `IsrStore` yourself |
| 3 | `HttpConfig.drainTimeoutMs` is `number \| null`, default `null` | you read the resolved field — and the drain budget moves 15s → 25s for an app that declared neither |
| 4 | an unclassified 5xx problem document carries no exception text | a client reads `title` / `detail` / `cause` off a 500 |
| 5 | a request carrying an identity gets `private, max-age=0`; every shared response varies on `cookie` and `x-timezone` | never — a CDN leak, closed. Personalised pages stop being shared-cacheable, which is the fix |
| 6 | `initialsOf(name, locale)` takes a required locale | you call `initialsOf` directly; `<Avatar>` is unchanged |
| 7 | `@ultimat3/pwa` deletes `RetryPolicy`, `DEFAULT_RETRY`, `retryDelayMs`, `shouldRetry` and `BackgroundSyncOptions.retry` | you imported one **from `@ultimat3/pwa`**. `@ultimat3/jobs` exports two of those names and is untouched |

### Entries 1, 2, 6 and 7 — a compile error the moment you upgrade

**1. Pass the negotiated locale to `isrKey`.** `TS2554`, one argument short.

```diff
- const served = await isr.serve(isrKey(url), () => renderPage(url));
+ const served = await isr.serve(isrKey(url, ctx.locale), () => renderPage(url));
```

`isrKey` is on `@ultimat3/render/server`, where 9.0.0 put it. The locale rides in a reserved query
parameter — `__x_locale`, exported as `ISR_LOCALE_PARAM` — and not as a prefix, because `routePathOf`
splits a key at its `?`: an `es:/blog` key matches no route, so `descriptorFor` answers `undefined`
and a declared `revalidate: { ttl }` silently becomes tag-only.

One entry per path served visitor 2 the document negotiated for visitor 1 — `<html lang>`, every
`t()` — for the whole TTL, and `s-maxage` told the CDN to do the same. `toResult` emits
`vary: accept-language` now for the CDN half; the rest of the shared key comes from `@ultimat3/http`'s
`cache-headers` stage, which sees the actor this function cannot.

The **time zone is deliberately not a dimension**: a locale set is declared and bounded, a zone list
is not. A date on an `isr` page belongs in a zone the page itself names, or the page belongs in `ssr`.

**2. Implement `markStale` in place.** Only a custom `IsrStore` pays this — `memoryIsrStore()` has it.

```diff
  const store: IsrStore = {
    get: (path) => map.get(path),
    set: (entry) => { map.delete(entry.path); map.set(entry.path, entry); },
+   markStale: (path) => {
+     const entry = map.get(path);
+     if (entry === undefined) return false;
+     map.set(path, { ...entry, stale: true });   // in place: the position IS the eviction order
+     return true;
+   },
    delete: (path) => { map.delete(path); },
    paths: () => [...map.keys()].sort(),
  };
```

**Never `set({ ...entry, stale: true })`** — that read-modify-write is the defect the member exists to
end. `set` means "this page was just generated" and a store is entitled to order eviction by exactly
that, so marking through it made the **stalest** page the newest: a tag bust protected the pages that
most needed regenerating.

Second half, and it costs nothing: `regenerate` samples a cache fence **before** the render and does
not store an entry the fence invalidated. A bust landing mid-render was previously erased by
`store.set({ stale: false })`, and for a tag-only route `isFresh` is true forever — so the process
served pre-write HTML for the rest of its life.

**6. Pass the locale to `initialsOf`.** `TS2554`.

```diff
- initialsOf(member.displayName)
+ initialsOf(member.displayName, useUi().locale)
```

`<Avatar>` reads `useUi().locale` itself, so a component tree pays nothing. A bare
`toLocaleUpperCase()` reads the **runtime's** default locale — a server's `LANG`, a browser's UI
language, never the request's — so one Turkish name uppercased to `İ` on the server and `I` in the
browser, out of identical props. `@ultimat3/ui` has no ambient locale to fall back on, by rule.

**7. Delete the import; there is nothing to replace it with.** `TS2305`.

```diff
- import { backgroundSyncSource, DEFAULT_RETRY, type RetryPolicy } from '@ultimat3/pwa';
+ import { backgroundSyncSource } from '@ultimat3/pwa';

- backgroundSyncSource({ flushEndpoint, retry: { ...DEFAULT_RETRY, maxAttempts: 5 } });
+ backgroundSyncSource({ flushEndpoint });
```

`BackgroundSyncOptions` is `{ flushEndpoint?: string }` and nothing else. This package schedules no
retry and never did: the one-shot `sync` handler rejects and the **platform** decides when to wake it
again. Of the policy only `maxAttempts` reached the emitted worker, as a `SYNC_MAX_ATTEMPTS` constant
nothing read, and `X_PWA_SYNC_INCOMPLETE`'s `fix:` told the reader to raise
`pwa.backgroundSync.retry.maxAttempts` — a key `PwaConfig` has never carried, because
`backgroundSync` is a boolean. [Error codes](Error-Codes) already says so.

**`@ultimat3/jobs` is a different package carrying two of those names.** `RetryPolicy` and
`DEFAULT_RETRY` are still exported from it, still read by the worker, unchanged. Only pwa's copies are
gone, and a `RetryPolicy` on a `job()` is not one of them.

### Entries 3, 4 and 5 — nothing fails to compile, and a caller can see the difference

**3. `drainTimeoutMs` is `number | null`, and `null` means "this app did not say".**

| What the app declared | Drain deadline before | Now |
|---|---|---|
| nothing | 15,000ms | **25,000ms** — core's own `DEFAULT_DEADLINE_MS` |
| `configureLifecycle({ deadlineMs: 600_000 })` | **15,000ms** — reverted by the next line of boot | 600,000ms |
| `defineHttpConfig({ drainTimeoutMs: 5_000 })` | 5,000ms | 5,000ms |

`createServer` calls `configureLifecycle({ deadlineMs })` only when the app declared one
([`packages/http/src/server.ts:101`](https://github.com/developerz-ai/ultimate/blob/main/packages/http/src/server.ts#L101)).
Unconditional, with `defineHttpConfig` defaulting the number, that line reverted the exact edit
`X_SHUTDOWN_TIMEOUT`'s own `fix:` prints — silently, in every process that serves web.

**Edit only if you relied on the 15s default** — write it down:

```diff
- defineHttpConfig({ rateLimit: { scope: 'process' } })
+ defineHttpConfig({ rateLimit: { scope: 'process' }, drainTimeoutMs: 15_000 })
```

The INPUT field is still `number | undefined`, so a declaration compiles unchanged. The RESOLVED
field is `number | null`, so `const ms: number = config.drainTimeoutMs` is `TS2322` — that is the
compile half, and it reaches only a caller that reads the merged config back.

**4. An unclassified 5xx says nothing about the exception that caused it.**

| Member | On a 5xx nobody classified | On a coded refusal |
|---|---|---|
| `type`, `status`, `code`, `fix`, `docs`, `requestId` | unchanged | unchanged |
| `title` | `unhandled server error` | the code's own title |
| `detail`, `cause` | one fixed sentence pointing at this process's logs, under the request id | the authored cause |

"Unclassified" is `X_INTERNAL`, or a code with no row in `@ultimat3/http`'s table **and** no
`registerErrorStatus` row — deliberately not `status >= 500`, which would have blanked `X_DRAINING`'s
one instruction. `dev: true` is unchanged, and the text is not lost: the `error-map` stage logs it as
a redactable field and reports every 5xx to the error monitor, both keyed by `requestId`.

A `pg` message quoting the rejected row, a driver message quoting the DSN, went to any non-HTML client
in production. `error-page.ts` had locked the browser out of exactly this, so the two audiences
disagreed about one condition.

**Edit only if a client parsed those members.** Match on `code`, correlate on `requestId`. A 5xx of
your own that should keep its authored cause needs a status of its own — that is what makes it
classified:

```ts
registerErrorStatus({ X_PAYMENTS_UNREACHABLE: 502 });   // from @ultimat3/http, once at boot
```

**5. A request carrying an identity is `private, max-age=0`, whatever the handler declared.**

```diff
- cache-control: public, max-age=0, s-maxage=30, stale-while-revalidate=300
+ cache-control: private, max-age=0
```

The `cache-headers` stage **reviews** a `cache-control` the handler wrote instead of standing down: a
declaration offering the response to a shared cache (`public`, or an `s-maxage`) plus a non-anonymous
actor is replaced. `immutable` is the one exception — it asserts the body is a function of the URL
alone, which a content-addressed island chunk or image is, and demoting those re-downloads every
chunk on every navigation for every signed-in user.

An **anonymous** shared response is unchanged except that it now carries
`vary: accept-language, cookie, x-timezone`. Both halves are needed: `private` for the identified
request, `vary: cookie` for the shared one.

What was happening: `ssrHeaders` offers any route without a `policy` to a CDN for 30 seconds, and
`meta.auth` is `'public' | 'required'` — so the commonest page in any app, public but greeting you by
name when you are signed in, is a `'public'` route whose own header said `s-maxage`. That is the shape
`x g route --surface app` scaffolds.

**No edit, and expect the shared-cache hit rate on personalised pages to go to zero** — that is the
fix, not a regression. A route that really is a function of the URL alone says so:
`cache-control: public, max-age=31536000, immutable`.

### Fixed in the same release, and none of it costs an edit

Read these if you built a workaround for one.

| Fix | What stops happening |
|---|---|
| the framework's CSP admits its own hydration runtime in production | **no island booted after deploy, anywhere the policy is enforced.** `script-src` was `'self' 'wasm-unsafe-eval'` with no hash while the runtime is an inline module — report-only under `x dev`, enforced in a container. `startWeb` now hashes the seven `HYDRATE_RUNTIME_BODIES` into `script-src`, as it already did for styles |
| a browser gets an error page, not `problem+json` | a 404 or a 500 rendering the internal `cause` and the author-facing `fix:` into a visitor's window. Copy is the catalog's `errors.*` keys; override per status with `apps/web/site/errors/<status>.html`, and `x dev` keeps the overlay |
| `worker`, `scheduler` and `sync` drain in two phases, and `holdUntilShutdown` reaches the exit | one `accept` hook spending the whole budget before "stop listening" and "stop upgrading" had been invoked at all — 4 hooks started, none finished — and an overrun wedging the process until the kubelet's SIGKILL, where the job lease lapsed and another worker re-ran it. **Behaviour change**: a job outrunning `configureLifecycle({ deadlineMs })` is abandoned (`jobs.worker.drain-abandoned`) and the queue redelivers it, where the teardown used to hang forever with the driver open. Raise the budget past your slowest job |
| a worker's fleet slot is released before the driver closes, and a renewal interval is `unref`ed | a `concurrency: 1` job unclaimable by the replacement pod for a full visibility window after every deploy, and a refed interval holding a drained process open until SIGKILL |
| the scheduler re-asserts leadership before **every** task, not once per round | the tail of a round dispatching under a lease another node already took. The occurrence key does not absorb it: `SQL_ENQUEUE`'s conflict target is partial over the live states, so a duplicate landing after that job finished inserts a new row and the handler runs twice |
| a replayed backfill batch writes no ledger row | 4,800 `x_backfills` UPDATEs before a resumed 5M-row sweep read a single new row, on every attempt, inside the visibility lease |
| a server render gets a live client instead of a 500 | a page whose body reads a live query failing on the server; it renders its loading branch and the browser takes over on hydrate. `mutate()` / `drain()` there are `X_LIVE_SERVER_RENDER` |
| `createLogger({ level: 'verbose' })` is refused at construction | an unknown level failing **open** — every level emitted |
| one documented first run, and it is `bin/setup` | `cd myapp && x dev` failing on `X_BUILD_FAILED` because `x new` installs nothing — which eight doc pages, and `x new`'s own closing line, told the reader to do. `wiki/Installation.md` also listed six `x new` flags that do not exist |

## 9.x → 10.0.0, entry by entry

**Nineteen breaking entries, from a twelve-audit correctness sweep.** Every one deletes or corrects
a declaration that promised something the code did not do. **One `app.config.ts` edit.** Six compile
errors. Five that no compiler will find — read those even if nothing else here applies. Four refuse
a declaration that was *already* broken, and three are corrected underneath you at no cost. No
codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `ERROR_DOCS_BASE` and `errorDocsUrl(code)` are deleted | you construct an `UltimateError` with an explicit `docs:` |
| 2 | a problem document's `type` is `urn:ultimate:error:<CODE>` | a client matches on that string |
| 3 | `@ultimat3/time` refuses a malformed locale with `X_LOCALE_INVALID` | you catch `RangeError` around a formatter |
| 4 | `realtime.tier` and `RealtimeTier` are deleted | your `app.config.ts` sets `realtime.tier` — **the one config edit in this major** |
| 5 | the WAL decoder returns parsed values, not Postgres' own text | you name `PgOutputMessage`, `entityRow` or `PhysicalRow` |
| 6 | a delta resume no longer seats a pre-policy cursor | never — a cross-tenant leak, closed |
| 7 | `verifyDigest()` is deleted from `@ultimat3/realtime` | you called it, which nothing could have |
| 8 | `defineAuth({ providers })` defaults to `[]` | you serve an OAuth route and name no provider |
| 9 | `@ultimat3/auth` writes `x_accounts.access_token` / `refresh_token` as `null` | your own SQL reads either column |
| 10 | a multi-audience id token needs a matching `azp`; a future `nbf` is refused | your OAuth provider issues multi-audience id tokens, or a host clock is ahead |
| 11 | `MemoryAdapter.createUser` enforces `x_users`' two UNIQUE constraints | a test registers one address twice |
| 12 | two admin resources may not claim one `path:` | your `defineAdmin` already had four screens unreachable |
| 13 | `registerLayout(name, layout)` refuses a name already taken | two modules register one layout name |
| 14 | `assertReadOnly` returns a `ReadOnlyVerdict` | you call it from `@ultimat3/admin/dev` |
| 15 | `generate()` no longer collects a LOCAL refusal | you catch `X_AI_PROVIDER_UNAVAILABLE` to mean "the model call failed" |
| 16 | `@ultimat3/render`'s graph-based island budget API is removed | you imported `routeJsBytes`, `graphFor`, `checkBudget`, `checkBudgets` or `assertBudget` |
| 17 | `@ultimat3/pwa`'s `routeRules` orders by specificity, wildcards last | you ship a generated `sw.js` |
| 18 | `subscriptionState` takes a `Clock` | you passed epoch milliseconds |
| 19 | `StaticReport` gained a required `unmeasured` | you construct one by hand |

### Start here — the one config edit

```diff
  realtime: {
    enabled: true,
-   tier: 'live-queries',
    transport: 'nats',
    urlEnv: 'NATS_URL',
  },
```

`TS2353`, and nothing else. `RealtimeConfig` is `{ enabled, transport, urlEnv }` —
[`packages/core/src/config.ts:132`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts#L132).

`tier` accepted `'channels' | 'live-queries' | 'local-first'`, defaulted, was documented with
per-value semantics, and was set by both tracked apps and every scaffolded app — and **nothing read
it**. No comparison, no branch, no dereference. `tier: 'local-first'` bought exactly what
`'channels'` bought, and the durable local store it advertised does not exist. Which tier an app is
on is decided by what it **declares**: a `channel()` topic, a `live: true` query, a local store.

**Leaving the line in also works, and that is the hazard.** `section()` copies an unknown key
through, so a stale `tier:` still boots and still does nothing; an app that builds its config into a
variable before passing it to `defineConfig` loses excess-property checking and sees no error at
all. Same shape as `jobs.driver` in 5.0.0 and `realtime.heartbeatMs` in 4.0.0 — the thirteenth
instance of that class. `bun run scripts/config-readers.ts` is what keeps the fourteenth out.

### Entries 1, 7, 14, 16, 18 and 19 — a compile error the moment you upgrade

**1. Omit `docs:`; do not substitute the new constant.**

```diff
- import { errorDocsUrl, UltimateError } from '@ultimat3/core';
+ import { UltimateError } from '@ultimat3/core';

  export class BillingDeclinedError extends UltimateError {
    constructor(cause: string) {
-     super({ code: 'X_BILLING_DECLINED', cause, fix: 'retry with another card', docs: errorDocsUrl('X_BILLING_DECLINED') });
+     super({ code: 'X_BILLING_DECLINED', cause, fix: 'retry with another card' });
    }
  }
```

The constructor already resolves `docs` from the registry, so passing it by hand is a second
declaration of one fact. `ERROR_DOCS_URL` is exported from `@ultimat3/core` for a caller rendering
the link *outside* an error — not as a drop-in for the deleted function.

Why: `https://ultimate.dev/errors/<code>` answered **HTTP 404**, host included, on every error this
framework has ever thrown, including the first line a new agent reads. One URL rather than one per
code, because codes live on [Error codes](Error-Codes) in **table rows** and a row has no anchor —
a `#X_DB_DRIFT` fragment would be a second dead declaration, not a fix for the first.

**7. Delete the `verifyDigest()` call.** That is the whole migration, and nobody had one to delete:
a delta-resumed cursor carries `DIGEST_UNVERIFIED`, so the check answered `false` for every cursor
drift can occur in, and `identity-map.ts` merges columns across queries by design — any app with two
reads over one entity would have reported permanent drift. Drift is the server's `desynced` mark.

**14. `assertReadOnly` returns a verdict, and the verdict carries the string to run.**

```diff
- const refusal = assertReadOnly(sql);
- if (refusal !== null) return { refused: refusal };
- const rows = await client.query(sql);
+ const verdict = assertReadOnly(sql);
+ if (verdict.kind === 'refused') return { refused: verdict.refused };
+ const rows = await client.query(verdict.sql);
```

`ReadOnlyVerdict` is `{ kind: 'runnable'; sql } | { kind: 'refused'; refused }`. **Execute
`verdict.sql`, never the string you passed in**: every check ran on a stripped form and the verdict
is the reconciled one. The `/_x` panel discarded it and ran the textarea's own bytes, so two callers
of one guard disagreed about which string runs.

**16. Delete the import.** Removed from `@ultimat3/render`: `routeJsBytes`, `graphFor`,
`checkBudget`, `checkBudgets`, `assertBudget` and their types. Every one was exported from the
barrel and called by nothing; the budget gate that actually runs is `@ultimat3/cli`'s and it
measures the emitted document. `parseByteBudget`, `defaultIslandBudget` and `islandModuleIds` are
unchanged.

**18. `subscriptionState` takes a `Clock` where it took epoch milliseconds** — `TS2345` on a
`number`. The parameter is optional and defaults to `systemClock`, so most callers delete an
argument:

```diff
- subscriptionState(record, lastStatus, Date.now())
+ subscriptionState(record, lastStatus)
+ subscriptionState(record, lastStatus, frozenClock(NOW))   // a test, from @ultimat3/core
```

**19. `StaticReport` gained a required `unmeasured`** — every budgeted route a build could not
weigh, with the reason, which is the list `X_BUDGET_UNMEASURED`'s `fix:` cites by name and which
until now reached no `x` command's output at all.

```diff
  const report: StaticReport = {
    target: 'static', out, buildId, emitted, skipped,
+   unmeasured: [],
  };
```

**Reading one costs nothing**: `parseStaticReport` takes the field as optional and answers `[]` when
it is absent, so a `.x/static-report.json` written by an older build still parses. Only
hand-construction moves.

### Entries 2, 3, 8, 15 and 17 — nothing fails to compile, and a caller can see the difference

**2. A problem document's `type` is a URN, per code.**

```diff
- if (problem.type === 'https://ultimate.dev/errors/X_RATE_LIMITED') …
+ if (problem.type === problemTypeFor('X_RATE_LIMITED')) …
```

`problemTypeFor(code)` is `urn:ultimate:error:${code}`, exported from `@ultimat3/http`. **`code` is
unchanged and is the simpler match** — `problem.code === 'X_RATE_LIMITED'` needs no import. `type`
and `docs` used to carry the same dead link on every 4xx and 5xx; they are two values now because
they answer two questions — `type` is RFC 9457's identifier for the problem *kind*, a URN so it has
no host left to rot, and `docs` is the one wiki page.

**3. A malformed locale is refused with a code instead of dying as a bare `RangeError`.**

| Tag | Before | Now |
|---|---|---|
| `en`, `en-GB`, `de-DE` | formats | formats |
| `zz` — well-formed, unknown | `Intl` falls back | `Intl` falls back, **still not refused** |
| `en_US`, `''`, a raw `Accept-Language` value | bare `RangeError` out of `Intl`, several frames from the header it came from | `X_LOCALE_INVALID`, with a runnable `fix:` |

Every `@ultimat3/time` entry point taking a `locale` passed the caller's raw tag to an `Intl`
constructor. `assertLocale` is the single gate now, and the list is one command:

```sh
grep -rn 'assertLocale(' packages/time/src
```

**Edit only if you catch `RangeError`** around a formatter; screen header input with
`Intl.DateTimeFormat.supportedLocalesOf([tag])`. The code's row is on [Error codes](Error-Codes).

**8. `defineAuth({ providers })` defaults to `[]`, not the live OAuth registry.**

```diff
  export const auth = defineAuth({
    adapter,
+   providers: ['github', 'google'],
  });
```

An app already passing `providers:` needs nothing. An app that passed none now serves **no**
`/auth/oauth/<id>` route — name the ones you mean. The default was every provider any dependency had
registered, so the uniform 404 the option exists for could never fire, and an import decided the
app's login surface. With the credentials fix in the same release, that closed an enumeration
oracle: 500 meant registered, 404 meant not, and the 500 published the app's own `*_CLIENT_ID` and
`*_CLIENT_SECRET` names.

**15. `X_AI_PROVIDER_UNAVAILABLE` now means one thing: the transport failed, on every provider
tried.** A *local* refusal reaches the caller with its own code and its own runnable `fix:`.

| Code | Raised when | Its `fix:` |
|---|---|---|
| `X_AI_KEY_MISSING` | no key configured and none passed | `export ANTHROPIC_API_KEY=<key>`, or pass `{ apiKey }` to the provider |
| `X_AI_REQUEST_INVALID` | a reasoning control the chosen model does not have | set `model:` on the `llm()` request |
| `X_AI_PROVIDER_UNAVAILABLE` | a non-2xx, an in-band `error` event, or a stream cut before `message_stop` | retry, or configure a second provider |

A `catch` treating `X_AI_PROVIDER_UNAVAILABLE` as "the model call failed" stops seeing the two
misconfigurations, which is the point: collecting one discarded its instruction and made
`generate()` and `stream()` answer one misconfiguration two ways.

**17. Regenerate `sw.js` — with the call, because no command writes it.** `x build` emits no service
worker and nothing in the framework calls `generateServiceWorker`; the generated file's own
`regenerate:` header names the call for that reason.

```ts
generateServiceWorker(routes, config, buildId);   // from @ultimat3/pwa
```

The emitted file changes for any app with a dynamic route above a static sibling. `ruleFor` returns
the **first** pattern that matches and the order was alphabetical: `:` (0x3A) and `*` (0x2A) sort
before every letter, so `/posts/:id` shadowed `/posts/new`, and a single `/*` shadowed the whole
table — every `PRECACHE_MANIFEST` entry downloaded at install and then never looked up. Path is
still the tie-break, so identical input still emits an identical file.

### Entries 10, 11, 12 and 13 — a refusal of something that was already broken

**If one of these fires, your app was half-broken before the upgrade** — each produced a declaration
that was silently unreachable, not a rule the framework tightened for its own sake. The refusal
names the finding.

| # | Refuses | Code | What had been happening |
|---|---|---|---|
| 10 | an id token naming several audiences whose `azp` is not this client, and an `nbf` in the future | `X_OAUTH_TOKEN_INVALID` | both only narrow, on the `ID_TOKEN_CLOCK_SKEW_MS` `id-token.ts` already exported to `workload.ts` and did not itself enforce — an `nbf` ten years out verified, and a token an OP minted for another client that also lists yours verified with it (OIDC Core 3.1.3.7) |
| 11 | a second `x_users` row with one `email`, or with one `external_id` | `X_AUTH_WRITE_FAILED` | `MemoryAdapter` is what `x new` scaffolds and what every test runs against, so the duplicate path was exercised only against the permissive half of the seam: two `register()` calls at one address made two rows, and the second was unreachable forever |
| 12 | two `defineAdmin` resources claiming one `path:` | `X_ADMIN_PAGE_PATH_INVALID` | eight routes over four paths, with the second resource's four screens silently unreachable. The `fix:` hands you a `path:` for one of them |
| 13 | `registerLayout(name, …)` on a name already registered | `X_MAIL_DUPLICATE` | `layouts.set` answered whichever module ran last, `base` included, so a dependency could re-shell every framework mail in silence |

### Entries 5, 6 and 9 — corrected underneath you

| # | What changed | What you do |
|---|---|---|
| 5 | the WAL decoder returns the values a repository row holds. `PgOutputDecoder` decoded a `timestamptz` as `'2026-08-09 12:00:00+00'`, a `text[]` as `'{a,b}'` and a `bytea` as `'\x0102'`, while the shared live window holds rows `@ultimat3/entity` parsed — and `compareValues` normalises a `Date` to its epoch, so **an edit to any column of any row jumped that row to the top of every `orderBy('createdAt', 'desc')` feed for every subscriber**, carrying the raw string into the window. `post.tags.map(…)` threw on the first patch | nothing, unless you name `PgOutputMessage`, `entityRow` or `PhysicalRow` from `@ultimat3/realtime/server` — `after`/`before` and `entityRow`'s return widen to `PhysicalRow`. It is a wire **convergence**: only a real walsender diverged, because `setRowObserver` emits already-parsed rows and the parity test handed the same object to both sides |
| 6 | a delta resume no longer seats a pre-policy cursor. `resumeFrom` advanced across the retained patch list, which is pre-policy by design, so a subscriber reconnecting inside the retain window gained the id of every row inserted for every **other** actor while it was away — and then received a `delete` frame carrying another tenant's row id | nothing. The leak `subscriber-gate` exists to close, re-opened one layer up and closed again |
| 9 | `@ultimat3/auth` no longer persists provider access or refresh tokens. `x_accounts.access_token` and `refresh_token` held live third-party credentials in the clear under a `tables.ts` header promising "no column holds a plaintext secret", and nothing ever read either one back | nothing, unless **your own** SQL selected either column — both are written `null` now. The type and the DDL are unchanged; keep a token you actually call out with in your own table, encrypted |

### Fixed in the same release, and none of it costs an edit

Read these if you built a workaround for one.

| Fix | What stops happening |
|---|---|
| `Gateway.stream()` resolved the provider between `reserve()` and the `try/finally` that releases it | a registered model no configured provider serves debited the estimate and never credited it back — on `MemoryBudgetStore`, which is per process and never expires, **five refused streams spent an org's whole ceiling with nothing ever sent**, and every later call was `X_AI_BUDGET_EXCEEDED` for the life of the process ([#319](https://github.com/developerz-ai/ultimate/issues/319)) |
| a successful login cleared the per-IP failure bucket | one credential the attacker owns bought unlimited stuffing — 4 guesses, 1 login, repeat: 160 guesses from one address against a 5-attempt limit, never locked ([#317](https://github.com/developerz-ai/ultimate/issues/317)) |
| the OAuth callback published uncoded internal exception text to an unauthenticated caller | connection strings and bind passwords reaching the browser, on two independent paths. The token-endpoint body is no longer reflected either — that request carries `client_secret` ([#318](https://github.com/developerz-ai/ultimate/issues/318)) |
| `readonly-sql` ended a `--` comment at `\n` only | a CR terminated the comment for Postgres and not for the scanner, hiding the payload from all four layer-3 checks — including `select pg_advisory_lock(42)`, whose **session** lock survives `ROLLBACK` and outlives the read on a pooled connection ([#316](https://github.com/developerz-ai/ultimate/issues/316)) |
| `diffRows` threw on a `money()` column | every `adminUpdate` on a money-bearing entity failed with an uncoded `TypeError` **after** `repo.update()` committed, landing zero audit entries ([#321](https://github.com/developerz-ai/ultimate/issues/321)) |
| `x db gen --allow-destructive` emitted a migration Postgres refuses | `drop table` with no preceding FK drop, tables ordered alphabetically rather than by dependency — `SQLSTATE 2BP01` during `ROLE=migrate`, with a `down` that cannot restore |

## 8.x → 9.0.0, entry by entry

**Five breaking entries, from closing the ten findings the 8.0.0 sweep filed rather than absorbed.**
Four are compile errors the moment you upgrade. The fifth changes what your cache ladder *is*, at
runtime, and it is the one to read even if nothing else here applies. No codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `@ultimat3/render` splits into `.` and `./server` | you import a build-time name, or relied on importing the barrel to install the `.tsx` loader |
| 2 | `cache.tiers` names the ladder's own rungs, and is now read | your `app.config.ts` sets `cache.tiers` — **runtime behaviour changes even if it compiles** |
| 3 | `@ultimat3/storage` renames `IMAGE_FORMATS` / `ImageFormat` | you imported either |
| 4 | `@ultimat3/pwa` drops the forced-reload half of `version-skew` | you called `updateSignal` or `updatePolicy` |
| 5 | `@ultimat3/core` replaces `CacheTier` with `CacheTierName` | you named the type |

### 1. `@ultimat3/render` splits into `.` and `./server`

```diff
- import { defineRoute, renderToHtml } from '@ultimat3/render';
+ import { defineRoute } from '@ultimat3/render';
+ import { renderToHtml } from '@ultimat3/render/server';
```

55 names moved: the render pipeline (`renderToHtml`, `renderSsr`, `renderStatic`, `renderStreamHtml`,
the ISR controller) and the loaders (`installRenderLoader`, `compileStylesheet`, `stylesFor`,
`transformTsx`). `.` keeps the authoring vocabulary — `defineRoute`, `h`, `Fragment`, `island`,
`hydrate*`, the registry, the mode tables.

**Second, easily-missed half: importing `@ultimat3/render` no longer installs the `.tsx`/`.scss`
loader.** `@ultimat3/render/server` does. A test that did `await import('@ultimat3/render')` before
loading a page module must now import `/server`.

Why: `bun build --target=browser` on the barrel failed outright — *"Browser polyfill for module
`node:url` doesn't have a matching export named `fileURLToPath`"*, out of `css-modules.ts`. The
island this framework tells you to write could not be bundled.

### 2. `cache.tiers` names the ladder's rungs, and the ladder is now that declaration

```diff
- cache: { tiers: ['memo', 'lru', 'shared', 'isr'] }
+ cache: { tiers: ['request-memo', 'lru', 'redis'] }
```

`memo` → `request-memo`, `shared` → `redis`, and **delete `isr`** — it is a `RenderMode`, and the
routes that want it declare `render: 'isr'`. It named a cache rung that never existed.

**Read this even if your config already compiles.** The key was previously read by *nothing*:
`startCacheTiers` registered memo + lru unconditionally, redis on `REDIS_URL`, cdn on a purge
credential. An app declaring `tiers: ['request-memo']` measurably got
`['request-memo', 'lru', 'redis', 'cdn']`. Now the ladder is the declaration, which means:

- naming a rung the environment cannot supply **refuses the boot** — `redis` without `REDIS_URL`,
  `cdn` without a purge credential — rather than quietly building a shorter ladder
- an environment offering a rung the config does not name logs `cache.tier.unnamed` and builds nothing

If you relied on the old always-on `lru`, or on `REDIS_URL` adding a tier your config never
mentioned, **name it**.

### 3. `@ultimat3/storage` renames its image vocabulary

```diff
- import { IMAGE_FORMATS, type ImageFormat } from '@ultimat3/storage';
+ import { VARIANT_FORMATS, type VariantFormat } from '@ultimat3/storage';
```

Both packages exported those two names over **different sets**, so a storage caller narrowing on
storage's type had a type saying `gif` cannot occur and a value from core's probe that was one. If
you were probing rather than minting variants, the six-format set is `IMAGE_FORMATS` from
`@ultimat3/core` — which is what you actually had.

`variantKey()` also now refuses a format outside `VARIANT_FORMATS` instead of returning a key ending
`.undefined`.

### 4. `@ultimat3/pwa` drops the forced-reload half of `version-skew`

Removed: `updateSignal`, `updatePolicy`, `DEFAULT_GRACE_MS`, and the types `ForceReason`,
`UpdatePolicy`, `UpdatePolicyInput`, `UpdateSignalInput`. `AppUpdateAvailable` narrows to
`{ type, to }`, losing `from`, `forced` and `deadlineAt`.

Nothing performed the reload they described, and no runtime could have called them: `@ultimat3/http`
(tier 2) and `@ultimat3/realtime` (tier 3) both sit *below* `pwa` (tier 4). **Forcing a reload is not
a capability this framework has.** Notification is, and is complete — read
`useConnection().updateAvailable`, or compare the worker's posted `to` with `detectSkew`, and render
your own affordance.

### 5. `CacheTier` → `CacheTierName` in `@ultimat3/core`

The type behind entry 2. `@ultimat3/cache` still exports a `CacheTier` — it is the tier *interface*,
a different thing, and it is unchanged. The two sharing one name is what made a type error about
`CacheTier` unreadable.

## 7.x → 8.0.0, entry by entry

**Six breaking entries, from one whole-repo bug sweep.** Five are compile errors the moment you
upgrade. The sixth is a **silent** behaviour change, and it is the one to read even if nothing else
here applies to you. No codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `@ultimat3/realtime` has two entries | you import a **server** name — NATS, pg replication, the sync node, the channel hub |
| 2 | `IdempotencyStore.settle` / `fail` take a reservation id | you call either, **or implement the interface** |
| 3 | `pwa.installPrompt`, `auth.afterSignInPath`, `ai.modelEnv` deleted | your `app.config.ts` sets one |
| 4 | `@ultimat3/manifest` drops `canonical` | you imported it |
| 5 | `@ultimat3/render` drops `matchRoute` / `RouteMatch` | you imported either |
| 6 | `SQL_CANCEL` projects its columns | you asserted on that constant's text |

### 1. `@ultimat3/realtime` splits into `.` and `./server`

```diff
- import { ChannelHub, createSyncNode, LiveQueryRegistry } from '@ultimat3/realtime';
+ import { ChannelHub, createSyncNode, LiveQueryRegistry } from '@ultimat3/realtime/server';
```

Client names — `useLive`, `liveHookFor`, `LiveClient`, the offline queue, rebase, the wire protocol,
cursors — are **unchanged on `.`**. A file importing both halves now writes both imports.

Why: the single barrel carried `useLive` beside `openNatsClient`, so `bun build --target=browser` on
an entry importing *only* the hook failed with *"Browser build cannot require() Node.js builtin:
`stream/web`"*, out of `nats`. **The island this framework tells you to write could not be bundled.**

The two barrels are **disjoint** — `./server` re-exports no client name — so which half a symbol
lives in is checkable rather than conventional. If an import stops resolving, the name moved to
`./server`; nothing was deleted.

### 2. `IdempotencyStore.settle` and `fail` take the reservation id

```diff
- await store.settle(key, value);
+ await store.settle(key, value, reservation.record.id);
```

`reservation` is what `store.reserve(key, hash)` answered. Same shape for `fail`.

**Read this if you implement the interface — it is the one silent entry in this major.** A store with
the old two-parameter method **still compiles**, because a shorter function is assignable to a longer
signature, and it **silently loses the fence**. Both statements now match on **id and state**, so a
straggler from a slow first attempt can no longer overwrite a replacement reservation still in
flight. The `fail` half was the worse one: a straggler's failure marked a *live* replacement
`failed`, and the replacement's own settle was then fenced out.

### 3. Three config fields are deleted

```diff
- pwa: { enabled: true, offline: 'runtime', installPrompt: true },
+ pwa: { enabled: true, offline: 'runtime' },
- auth: { signInPath: '/signin', afterSignInPath: '/dashboard' },
+ auth: { signInPath: '/signin' },
- ai: { mcp: { expose: true, path: '/mcp' }, modelEnv: 'ANTHROPIC_MODEL' },
+ ai: { mcp: { expose: true, path: '/mcp' } },
```

**There is no replacement key, because there was never a behaviour.** Each was declared, defaulted,
merged, and read by nothing. Use `createInstallController` from `@ultimat3/pwa`, send the visitor
from your own sign-in route, and pass `model` on the `llm()` request.

`ai.modelEnv`'s own doc comment argued for its deletion: *"an intention, not a behaviour… nothing
consumes the merged value… So the exact thing this key exists to prevent — a model string baked into
the image — is what actually happens."*

Same precedent as `JobsConfig.driver` in 5.0.0 and `realtime.heartbeatMs` in 4.0.0. All three fail at
**typecheck only** — and an app that builds its config into a variable before passing it loses
excess-property checking and sees no error at all. `scripts/config-readers.ts` now keeps the class out.

### 4. `@ultimat3/manifest` no longer exports `canonical`

Use `canonicalJson` from `@ultimat3/core`. It was the third of five copies of one serialiser;
`manifest`'s fed `buildId` **and the contract-diff equality**, so a `-0`/`NaN`/`Date` fold could make
a breaking API change diff as *"no change"* and ship silently.

### 5. `@ultimat3/render` no longer exports `matchRoute` or `RouteMatch`

Two exported route matchers existed with different precedence. `@ultimat3/http`'s trie is the live
one; render's had zero consumers repo-wide.

### 6. `SQL_CANCEL` projects its columns instead of `returning *`

It fed `toJobRecord`, which does `Number(row.run_at)` — so against a text-decoding `PgExecutor` every
timestamp came back `NaN`. Only an edit if you asserted on the constant's SQL text.

## 6.x → 7.0.0, entry by entry

**Four breaking entries, and only one of them can reach you at runtime.** Three are compile errors
the moment you upgrade; the fourth is a type you may never have named. None ships a codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `ScrapeTarget.pageErrors` | you implement `ScrapeDriver`/`ScrapeTarget` yourself |
| 2 | `PwaRenderMode` | you import that type name |
| 3 | `PwaOfflineStrategy` | you import that type name |
| 4 | `PrerenderReport.skipped` | you read `x build --target static --json`, or the report in code |

### 1. `ScrapeTarget` gains a required `pageErrors: PageErrorRing`

**Only a third-party driver author pays this**, and nothing in an ordinary app implements
`ScrapeTarget`. If you build one — the shape `packages/scraping/README.md`'s driver-author example
builds — construct the ring and, if your transport can observe uncaught page exceptions, push to it.

```diff
+ import { createRing, type PageErrorRing } from '@ultimat3/scraping';

  const target: ScrapeTarget = {
    // …
+   pageErrors: createRing(200),
  };
```

A driver that **cannot** observe them builds the ring and never pushes — which is exactly what the
offline targets do. That is the whole migration.

**Required rather than optional, deliberately.** An optional ring lets a driver stay *silent* about
errors it can see, which is the gap this closed: nothing in `@ultimat3/scraping` subscribed to
`pageerror` at all, so an island that **threw** was invisible. A throw calls no console method, so
`console()` answered `[]` and a page whose script had died read as clean.

New on `ScrapePage`, and additive — no edit needed to consume them: `pageErrors()` and
`pageErrorsDropped()`. The dropped count makes the list a **floor**, not a total.

### 2 and 3. `PwaRenderMode` and `PwaOfflineStrategy` are deleted from `@ultimat3/pwa`

Two type-only renames. No member changed — only the name the type is declared under.

| Was | Is | Members, unchanged |
|---|---|---|
| `PwaRenderMode` | `RenderMode` | `'static' \| 'isr' \| 'ssr' \| 'stream'` |
| `PwaOfflineStrategy` | `OfflineStrategy` | `'precache' \| 'runtime' \| 'network-only'` |

```diff
- import type { PwaRenderMode, PwaOfflineStrategy } from '@ultimat3/pwa';
+ import type { RenderMode, OfflineStrategy } from '@ultimat3/pwa';
```

`@ultimat3/pwa` re-exports both under the canonical name, so the import path does not have to move —
`@ultimat3/core` is where they are declared and is equally correct.

**Why the alias existed and why it could not stay.** Tier 4 may not import tier 4, so `@ultimat3/pwa`
wrote its own copy of a set `@ultimat3/render` already had. That copy is what kept `spa` mapped to
`cache-first` after `spa` was deleted in 6.0.0 — the one strategy that gives an `app/` route a
**shared** cache entry, i.e. one signed-in member's HTML served to the next. The vocabulary is now
declared once at tier 0, and `bun run scripts/render-modes.ts --json` refuses a second declaration
anywhere in `packages/*/src`.

### 4. `PrerenderReport.skipped` carries the reason, not just the path

`readonly string[]` → `readonly SkippedRoute[]`, where a `SkippedRoute` is
`{ route, surface, render, reason, why }`. `PrerenderedPage` also gains `route`, the declared path a
concrete URL came from.

```diff
- for (const path of report.skipped) console.log(`skipped ${path}`);
+ for (const skipped of report.skipped) console.log(`skipped ${skipped.route}: ${skipped.why}`);
```

`x build --target static --json` now returns `emitted` and `skipped`, and the human path prints the
same rows.

**Why it changed.** `.x/static/` held a partial site and said nothing about the difference: `app/`
routes exist only through the server, so a tool pointed at the directory filed *"the island did not
mount"* against a route that was never emitted. A list of paths cannot distinguish "not emitted
because it needs a server" from "not emitted because it is broken", and those are opposite facts.

## 5.x → 6.0.0, entry by entry

**Installable `As of 2026-08-21`** — `npm view @ultimat3/core version` answers `7.0.0`, so 6.0.0 is behind `latest` and every entry below is a step you take on the way to it. Run that command anyway rather than trusting this line; a version written into a page goes stale on the next tag.

Seven breaking entries, and the first is a **runtime** refusal with no compile error in front of it.

### Start here — the one edit

Every single-label timezone name except `UTC` is refused. `isValidTimeZone` answers `false`, `canonicalTimeZone` answers `undefined`, `assertTimeZone` throws `X_TIMEZONE_INVALID` — and every `@ultimat3/time` formatter is downstream of that one call. **43 names change answer**, tabulated once under [the `6.0.0` section of `CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md#600); that table is the source and is deliberately not copied here.

```diff
- formatDate(at, { locale, zone: 'CET' })
+ formatDate(at, { locale, zone: 'Europe/Paris' })
```

### Which class the name is in decides whether the swap is mechanical

| Class | Names | Replacement |
|---|---|---|
| geographic link — 24 of the 43 | `Japan`, `GB`, `Hongkong`, `NZ`, … | the `Area/Location` spelling: `Asia/Tokyo`, `Europe/London`, `Asia/Hong_Kong`, `Pacific/Auckland`. Textual — identical wall clock, identical offset |
| UTC alias | `UCT`, `Universal`, `Zulu` | `UTC` |
| the `GMT` family | `GMT`, `GMT0`, `GMT+0`, `GMT-0`, `Greenwich` | `Etc/GMT`, which still renders the label `GMT`. **Not `UTC`**, which renders `UTC` — same instant, different text on any surface that prints the zone name |
| abbreviation | `CET`, `EET`, `MET`, `WET`, `EST`, `MST`, `HST`, `EST5EDT`, `CST6CDT`, `MST7MDT`, `PST8PDT` | **none, and that is the defect.** An abbreviation names no jurisdiction and carries no DST rule, so only the author knows which city's clock was meant: `Europe/Paris` for `CET`, `America/New_York` for `EST5EDT`, `America/Phoenix` for `MST` |

`Etc/GMT+2` is unaffected — only a **leading** sign is a bare offset, and that `+` sits inside a real zone name. `US/Eastern` and `Asia/Calcutta` are unaffected too: a deprecated two-label alias is still `Area/Location`.

### Where the names hide, and why no build error finds them

`TimeZone` is `string` in `@ultimat3/time`, so `'CET'` compiles. Nothing fails until the call runs.

| Site | Spelling | At 6.0.0 |
|---|---|---|
| a formatter, or zone arithmetic | `zone:` on `formatDate`, `formatDateTime`, `formatRange`, `zonePartsAt`, … | throws `X_TIMEZONE_INVALID` on the first call |
| a scheduled task | `tz:` on `task()` | refused where the task is declared — `task()` validates through `isValidTimeZone`, so this one is caught at boot |
| `app.config.ts` | `defaultTimeZone` | refused at boot — `defineConfig` validates through core's own statement of the structural rule, so a stale key is `X_CONFIG_INVALID` naming the field, with the swap in its `fix:` |
| a client's `x-timezone` header | any of the 43 | no error — `resolveTimeZone` falls through to the configured default, so a hand-written client sending `CET` silently renders in your default zone. Browsers are unaffected: `Intl.DateTimeFormat().resolvedOptions().timeZone` is always `Area/Location` |

Find every candidate:

```sh
grep -rnE "(zone|tz|defaultTimeZone): *'[^/']+'" --include='*.ts' --include='*.tsx' .
```

Run it from the app root. Every hit is a single-label zone; `'UTC'` is the only one already correct.

### Why it changed

`Intl` answers "can I format this", never "is this an IANA zone", and at ICU 78 the two stopped agreeing: Bun 1.4 resolves `CET`, `EST`, `GMT` and `MST` where ICU 75 threw. A **runtime upgrade alone** therefore reopened the "no date without an explicit IANA zone" rule — silently, and in the direction that fails dangerous, because an abbreviation carries no DST rule. The judgement is now structural instead of delegated: an identifier is `Area/Location`, and `UTC` is the one legal exception. That refuses the single-label `backward` links along with the abbreviations, and is meant to — no structural rule keeps `CET` out while letting `Japan` in, both being one label, and the alternative is a denylist that grows with every tzdata release. [#251](https://github.com/developerz-ai/ultimate/issues/251), and [Timezones and dates](Timezones-And-Dates) for the rule it restores.

### Fixed, and neither costs an edit

| Fix | What changes for you |
|---|---|
| island JSX compiles through `babel-preset-solid` | client-side Solid reactivity inside an island works at all. An island containing JSX compiled to `React.createElement` and threw `ReferenceError: React is not defined` on first interaction, with the gate green. Two build-time dependencies join `@ultimat3/cli`; zero bytes reach your client bundle ([#243](https://github.com/developerz-ai/ultimate/issues/243)) |
| `@ultimat3/core` loads in a browser bundle | **core's** three module-scope `AsyncLocalStorage` constructions — the request context, the active span, the impersonation reason — moved onto one lazy seam, so `@ultimat3/ui` no longer throws `TypeError: undefined is not a constructor` at module evaluation ([#244](https://github.com/developerz-ai/ultimate/issues/244)). Six more constructions **outside** core were untouched at 6.0.0 and carry the same defect — `@ultimat3/db`, `@ultimat3/entity`, `@ultimat3/ai`; they are `[Unreleased]`, along with the guard that makes the rule a build error ([#255](https://github.com/developerz-ai/ultimate/issues/255)) |

Rebuild to pick either up.

## 4.1.0 → 5.0.0, entry by entry

Two breaking entries over six surfaces, one of which needs an edit. There is no codemod, and there
does not need to be: **the whole migration is deleting one line, and only if you wrote it.**

### Start here — the one edit

```diff
  jobs: {
-   driver: 'postgres',
    queues: ['app-default'],
    concurrency: 8,
  },
```

`jobs.driver` accepted `'postgres' | 'redis' | 'nats'` and had **no reader anywhere**. Boot always
built `createPgDriver`, so setting it to `redis` did not throw, did not warn and did not boot Redis
— it changed nothing and you silently got Postgres. If you were relying on it doing something, it
was not: you were on Postgres the whole time.

Which driver runs is `setJobDriver(driver)`, and only that:

```ts
setJobDriver(createPgDriver({ executor }))   // production
setJobDriver(createMemoryDriver())           // a test
```

`JobsDriver` (the type) goes with it. `JobsConfig.driver` was its only use.

**Leaving the line in also works.** A spread carries a key no type names, so a stale
`app.config.ts` still boots and the field still does nothing — `packages/core/src/config.test.ts`
pins exactly that. TypeScript will flag it; the runtime will not.

### The other four need no edit unless you wrote a test driver

They are `@ultimat3/testing`'s `subscribe` fixture, which was **declared and had no driver** — so
nothing could have been implementing these types. They changed because they described an API that
could not work: `LiveTarget` was `{ name, queryHash }`, and a node keys a subscription by
`(name, input)`; a hash is the input already thrown away.

| Was | Is |
|---|---|
| `Subscribe = (target) => Promise<LiveFeed>` | `(target, input, actor?) => Promise<LiveFeed>` |
| `LiveTarget = { name, queryHash }` | `{ name }` — the query itself |
| `LiveFeed` had no `reconnect()` | it has one |
| `DRIVER_FIXTURE_NAMES` held `subscribe` | `FRAMEWORK_FIXTURE_NAMES` does; the framework builds it |

A test that destructured `subscribe` and called it now reads:

```diff
-const feed = await subscribe(liveFeed.as(actorFor(ada), { orgId: acme.id }));
+const feed = await subscribe(liveFeed, { orgId: acme.id }, actorFor(ada));
```

The actor is the third argument rather than baked into the target because that is where the
framework puts it: the shared window is built with **no subject**, and every decision about an
actor is per subscriber.

### Behaviour that changed without breaking a type

**Error fields are escaped where they are built.** `UltimateError` and `SchemaError` run
`singleLine` over `code`, `title`, `cause`, `fix` and `docs` in their constructors, so `.message`,
`.cause`, `format()`, `toJSON()` and any renderer you write are one line by construction. Measured
over every shipped `cause:`/`fix:` literal: none contains a newline, so no framework message
changed. If you build error text from a value a CALLER controls, you no longer have to remember —
and if you were already escaping, `singleLine` is idempotent, so nothing doubles.

**One `fix:` line changed text.** `X_REPLICATION_FAILED` on SQLSTATE `42704` said
`x db replication init`, which is not a command — `x db` takes `gen`, `migrate`, `reset`, `seed`,
`studio`, `branch`, `backfill`. It now names the `CREATE PUBLICATION` an operator can paste.

### One thing to know before you subscribe to a projected live query

Not a change in this release — a defect it made visible. If a `query({ live: true })` declares an
`orderBy` on a column its rows do **not** carry (a projection that omits it), every change to a row
reads as a move, and the re-delivered row is the raw entity row rather than the projection. Columns
you left out of the projection reach the subscriber. [#230](https://github.com/developerz-ai/ultimate/issues/230),
and [Known gaps](Known-Gaps) carries it. Until it is fixed, order a live query by a column its rows
carry.

## 3.0.0 → 4.0.0, entry by entry

Twenty-five `BREAKING —` entries. Most are one of two shapes: a **declaration nothing read**, deleted rather than implemented, and a **surface that answered the wrong thing**, corrected. Full rationale per row in [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md)'s `4.0.0` section.

**Start here — these three change behaviour whether or not you edit anything:**

| Surface | The edit |
|---|---|
| `on delete` now reaches the generated SQL. Any app that ever declared `references(…, { onDelete })` generates **different DDL** | run `x db gen` and read the diff before migrating. Every `add constraint` this framework had ever emitted dropped the rule, so the database has been refusing deletes under a declared `cascade`. Drift also gains `changed-foreign-key`, whose `fix:` hands over a `drop constraint` / `add constraint` pair — `add constraint` alone is `42710` on a name already taken |
| `llm()`'s `cache.semantic.scope` receives `{ input, ctx }` and **defaults to the calling actor**, not `'global'` | `scope: (input) => input.orgId` → `scope: ({ ctx }) => ctx.actor.orgId ?? 'none'`, or delete `scope` and take the default. A semantic lookup is a cosine nearest-neighbour with no tenant predicate, so the old shared store answered one tenant with another tenant's completion — reproduced at similarity 1.0. A deliberately shared cache must now say so |
| `reapBranches()` skips branches whose base is not `current_database()` | none, and re-read it if you run two Ultimate apps on one Postgres: `listBranches()` walks `pg_database` for the whole server, so one nightly sweep was dropping the *other* app's branches. A pre-4.0 marker records no base and is now skipped rather than dropped; the next `createBranch` writes it down, so it self-heals with no migration |

**Deleted because nothing read them** — in every case the edit is "delete the option":

| Surface | The edit |
|---|---|
| `CaptureOptions.timeoutMs` and `CaptureRequest.timeout` (`@ultimat3/scraping`) | delete them. The port required a timeout, `page-over-target.ts` threaded it, and **no driver honoured it** |
| `ScrapeTarget.click`'s `index` parameter | delete it. It was unreachable from the public vocabulary — `ScrapeFrame.click` takes `(selector, options?)` and has no index — and the two drivers disagreed on it |
| `PrecacheAsset.critical` (`@ultimat3/pwa`) | delete it. `buildPrecacheManifest` never copied it, and the documented promise ("critical assets are precached even if large") was vacuous — there is no size filter at all |
| `PERIODIC_SYNC_TAG`, `BackgroundSyncOptions.periodicMinIntervalMs` (`@ultimat3/pwa`) | delete them. Periodic Background Sync was never implemented in any sense: no listener, no registration, no capability flag |
| `realtime.heartbeatMs` (`RealtimeConfig`) | delete the key — `RealtimeConfig` is now `{ enabled, tier, transport, urlEnv }`. The socket beat is `new LiveClient({ heartbeatMs })` (browser code, which cannot read server config) and the presence beat is derived. **There is no runtime refusal**: `section()` copies unknown keys through, so a stale key is silently inert |
| `@ultimat3/seo` no longer exports `extensionOf` | delete the import; `parseImageQuery` reads the format off the query |
| `@ultimat3/realtime` no longer exports `qidOf` or `canonicalJson` | change the import: `queryHash` from `@ultimat3/query`, `canonicalJson`/`fingerprint` from `@ultimat3/core`. **No live subscription re-keys** — the two spellings differed only on values JSON cannot carry |

**Corrected, because they answered the wrong thing:**

| Surface | The edit |
|---|---|
| `adminResource` no longer pluralises an entity name | set `path:` explicitly if you relied on the doubled URL. Every entity in both tracked apps is already named plural, so `entity('orgs')` was served at `/admin/orgses`. Which plural a name takes is an app's convention, not a mechanism the framework can own (axiom 8) |
| A local disk's signed URLs carry the **registered disk name**, not the driver kind | none, if you use `defineStorage` — it calls `registerAs(diskName)` at boot. A disk registered as `uploads` used to 404 every signature it had just written |
| `ordinal(value)` takes no locale | delete the second argument. It picked the plural category with your locale and appended the **English** suffix regardless, so `ordinal(1, 'de')` was `'1th'` |
| `registerFrameworkCatalog()` and `registerMailCatalog()` take no `locale` | delete the argument. `defineCatalogs` called them once per locale, seating the English-only catalog under **every** locale an app declared — an app shipping only `es` served English chrome with `isMiss` reading `false`, which is a fallback locale chain the i18n package forbids by name |
| `t.date` refuses a date-time with no offset and no `Z` | send `2026-08-19T10:00:00Z`. `2026-08-19T10:00` resolved against the **host process's** zone, so one wire value meant a different instant on each pod — reachable from a request through `coerceQuery`, and published as `format: 'date-time'`, which RFC 3339 requires an offset for |
| `in` with a non-array operand matches **no** rows on both drivers | pass an array. It matched one row in Postgres (the scalar was wrapped) and none in memory; `in` with a NULL in the list disagreed in the other direction, and the SQL now emits `(col in (…) or col is null)` |
| `isValidCron` / `parseCron` refuse an unsatisfiable day/month pair (`'0 0 30 2 *'`) | fix the expression; the refusal names the pair. It used to parse clean and then burn ~184ms of blocking CPU per tick in the scheduler's leader loop before throwing |
| `createRateLimiter({ now })` → `createRateLimiter({ clock })` | `{ config, now: () => t }` → `{ config, clock: { now: () => new Date(t) } }`. Callers that passed neither are unaffected |
| `requiresApp` is enforced by the dispatcher | none, unless a script matched on the old message. Outside an app, `x secrets set` and its siblings now answer `X_NOT_IN_APP` |
| `NackOptions.countsAsAttempt: false` no longer files a job `suspended` | none. "Do not burn an attempt" and "this is a `step.sleep` suspension" were one flag, so the worker's limiter and `job.concurrency` sheds pushed rows out of `ready` — and `queue_depth` / `queue_oldest_ready_seconds` under-reported because of it |
| A read whose input carries a `Date`, `Map` or `Set` gets a new cache key and cursor scope, **once** | none. `Object.keys(date)` is `[]`, so every date rendered `{}` and one key answered for every date window a read ever served. Affected cursors answer `X_CURSOR_INVALID` once with "request the first page again"; ordinary inputs are byte-identical |

**Type-level, for hand-built literals and exhaustive switches:**

| Surface | The edit |
|---|---|
| `ColumnDescription` / `ReferenceDescription` gain `onDelete: OnDelete \| null` | add the field to hand-built description literals (a test fixture, a custom generator). `null` is Postgres' `no action` and is the old behaviour |
| `DriftKind` gains `changed-foreign-key` | a `switch` over `DriftKind` with no `default` no longer compiles |
| `BranchInfo` gains `base: string \| null` | re-type if you built the shape by hand |
| Five generators write **typed** test filenames | re-run the generator, or rename by hand. `x verify` selects a suite by filename, so a generated `contractTest(…)` inside a plain `*.test.ts` ran under `unit` while `x test contract` answered `X_TEST_NO_FILES` — a step that passed by having nothing to run. `x g action`/`x g mutator` now also write `<name>.contract.test.ts`, `x g query --live` writes `<name>.live.test.ts`, and `x g job`/`x g task`/`x g backfill` write `<name>.job.test.ts` |

**One migration to run:** the `x_jobs` idempotency index gains the tenant. It was `(name, idempotency_key)` while the row already carried `tenant_id`. `x db migrate` applies it.

## 2.0.0 → 3.0.0, entry by entry

Ten `BREAKING —` entries, all from one bug sweep. Each was a documented surface that did nothing, or did the wrong thing; the fix is the edit named beside it. Full rationale per row in [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md)'s `3.0.0` section.

| Surface | The edit |
|---|---|
| `defineAuth({ mfa: { required: true } })` — refused at boot (`X_CONFIG_INVALID`), and `AuthMfaPolicy.required` narrowed to the literal `false` | delete `mfa.required`; enforce the requirement in your own enrolment flow. Nothing ever read the flag, so a user who never enrolled got a fully-privileged session under it |
| `enrolTotp(input)` → `enrolTotp(auth, input)`; `input.issuer` is now optional | pass the `auth` you built with `defineAuth`. The configured issuer never reached the `otpauth://` URI before |
| `@ultimat3/http` no longer exports `appErrorStatus()` | read your own registration module. `registerErrorStatus()` and `statusFor()` are unchanged |
| `SyncSocket.lastSeenAt` → `lastSeenMonotonicMs`, on `Clock.monotonic()` | rename the read. If you were formatting it as a date you were already wrong — the rename makes `new Date(...)` a compile error |
| `SQL_OUTBOX_RELEASE` and `SQL_OUTBOX_MARK_PUBLISHED` take one more parameter each (1 → 2, 2 → 3): the claimant | pass the claimant. `OutboxStore.release`/`markPublished` take it as an optional trailing argument, so an unfenced store still compiles |
| `SocketRegistry.sweepIdle()` → `idle()`, which returns the over-budget sockets and removes nothing | call `idle()` and evict through the node, or set the budget with `createSyncNode({ idleTimeoutMs })` |
| `DESCRIPTION_MIN_LENGTH` deleted from `@ultimat3/seo` | delete the import. There is no replacement and no minimum description length is checked — the constant was documented as enforced and was read by no validator |
| A metric redeclared with different `bounds` or a different `observe` is refused (`X_METRIC_NAME_INVALID`) | make the second declaration state the same `bounds`/`observe`, or fetch the handle without options — `gauge(name)` is unchanged |
| `Seed.run()` resolves with `SeedRun` instead of `void` | re-type the result if you typed it `void`. Awaiting it for the side effect alone is unaffected |
| `SeedContext.insert` skips a stored row instead of overwriting it | expect `skipped`, not an overwrite. `upsert` is the verb for a row the table keys |

`cachedFormatter` and `canonicalLocale` moved from `@ultimat3/time` to `@ultimat3/core` and are re-exported from `time`, so **no import breaks** — it is listed here because the move is real, not because it costs an edit.

## 1.x → 2.0.0, entry by entry

**Thirty-three `BREAKING —` entries — the largest major this project has shipped, and the first one semver covered.** Written up here `As of 2026-08`; the page carried a row pointing at this section for six releases and never carried the section. Full rationale per entry in [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md)'s `2.0.0` section — the numbers below are that section's own order. No codemod.

Two things are not compile errors and are the ones to read first: the **seven behaviour changes** under *Start here*, and the **one migration** every app with a `money()` column owes.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `x db branch` takes a verb | you ever ran the bare-name form, which created a database |
| 2 | `x new` writes no migration | you scaffold a new app, or your app carries a hand-written `0000_initial.sql` |
| 3 | an MCP tool is named by its export name, verbatim | you read a tool name off `openapi.json`, `describe().mcp.tool` or `.tool().name` |
| 4 | `selectMailDriver` refuses with no mail credential | you send mail from `staging` or `production` |
| 5 | a lapsed fleet slot cannot be renewed by its holder | a job run outlives its slot lease |
| 6 | `@ultimat3/query` ships no read-cache seam of its own | you called `setReadCache`, `invalidateQueryTags`, or imported `ReadCache` |
| 7 | `@ultimat3/auth` drops `requireRole` / `requireScope` | you gate a route with either |
| 8 | `@ultimat3/db` drops `readOnly()` and its four companions | you imported any of them |
| 9 | `@ultimat3/seo` drops the performance-budget surface | you imported `checkBudgets`, `parseBytes`, a `Budget*` type, or set `RouteRecord.budget` |
| 10 | `@ultimat3/seo` drops `renderLd` | you called it |
| 11 | seven zone and locale helpers are gone | you imported `attachTimeZone`, `timeZoneOf`, `attachLocale`, `localeOf`, `negotiateLocale`, `isValidTimeZone` or `resolveTimeZone` |
| 12 | `@ultimat3/seo` drops `renderHeadTags` | you called it |
| 13 | a derived `BudgetLedger` bills its parent | you already sit at an `llm()` budget ceiling — no signature changed |
| 14 | `idempotencyKeyFor` takes the actor, required and third | you call it, **or** you hold idempotency records written before the deploy |
| 15 | `Idempotency-Key` is enforced at 255 characters | a client sends a longer key |
| 16 | `@ultimat3/action`'s `fingerprint` is SHA-256/16 | you enqueue an action job across the deploy boundary |
| 17 | `markReady()` throws `X_LIFECYCLE_DRAINED` after a drain | a test or a process drains and then starts a role |
| 18 | a drain is bounded at 25s, and a hook that outruns it is abandoned | your drain legitimately takes longer |
| 19 | `cacheKeyFor` takes a fourth, required `authority` | you call it directly |
| 20 | the query fingerprint is SHA-256/16 hex | you hold cursors minted before the deploy |
| 21 | `semantic.remember` refuses a TTL the tiers refuse | you passed a non-finite or negative lease |
| 22 | `OutboxRelay.stop()` returns `Promise<void>` | you await teardown, or implement the interface |
| 23 | `TierFailure.tier` is `TierLabel` | you `switch` over it with no `default` |
| 24 | `hello` carries no cursors | you build a `hello` frame by hand, or read `FRAME_LIMITS.resume` |
| 25 | three more `@ultimat3/realtime` surfaces move | you call `qidOf`, read a mutation's `status` after a drain, or implement `SyncNode` |
| 26 | four projection changes — what a value becomes when it leaves the process | you have a `money()` column (**a migration**), read `schema.nullable`, pass an unclonable `.default`, or take a nested object as `query({ input })` |
| 27 | `EPOCH` is gone; call `epoch()` | you imported it, or declare a 6-field cron |
| 28 | `job()` and `backfill()` require a `tenant` | you declare any job or backfill |
| 29 | one `resolveEnvironment`, and it is `@ultimat3/core`'s | you imported seo's, or wrote `'preview'` |
| 30 | the NATS wire client is `nats@2.29.3`, behind the same transport seam | you imported a hand-rolled NATS name, or faked a byte stream in a test |
| 31 | `@ultimat3/cli` exports `checkSourceDrift`, not `checkDrift` | you imported the CLI's |
| 32 | `invariants` is a function, and `invariant()` takes a built expression | you declare an entity with invariants |
| 33 | the framework's version is a call, not a constant | you imported `FRAMEWORK_VERSION`, `DEFAULT_SERVER_INFO` or `CLI_VERSION` |

### Start here — entries 4, 5, 13, 15, 17, 18 and 21 change behaviour with nothing failing to compile

| # | What changes | What you do |
|---|---|---|
| 4 | with neither `SMTP_URL` nor `RESEND_API_KEY`, `staging` and `production` install a driver that rejects every send with `X_MAIL_CREDENTIAL_MISSING`. `development` and `test` are unchanged, and an app that sends no mail still boots — the refusal is on the send, not at boot | set one of the two env keys in every environment that sends. The SMTP `Message-ID`, and so `SendResult.id`, is now content-derived and stable across attempts of one send |
| 5 | `SQL_LEASE_RENEW` fences on `expires_at > now()` as well as `holder`, matching the memory store. A run whose slot lapsed is cancelled with `X_JOB_SLOT_LOST` instead of running on uncapped past `job.concurrency` | nothing, unless a handler holds a slot longer than its lease — raise the lease, or shorten the run. This is what the documented contract already said and what `x dev` already did |
| 13 | a derived ledger bills its parent, so a call that used to slip past a `request` ceiling can throw `X_AI_BUDGET_EXCEEDED`, and `gateway.spent()` returns a larger — correct — number | raise the ceiling, or accept the refusal. Listed as breaking because it is observable to an app already at its limit, even though it makes *"derive can only tighten"* true for the first time |
| 15 | `Idempotency-Key` is enforced at 255 characters. The OpenAPI operation published `maxLength: 255` all along and nothing checked it | shorten the key. A client sending longer keys worked by accident and now gets a 400 |
| 17 | `markReady()` throws `X_LIFECYCLE_DRAINED` on a drained lifecycle instead of declining in silence | call `resetLifecycle()` between a drain and the next start — which is what three test files were already doing by hand. A process that drains and then starts a role now fails at the mistake rather than binding a socket that answers 503 forever |
| 18 | a drain is bounded at **25s** by default and a hook that outruns it is **abandoned, not stopped** — it is still running when the process exits. `drainDeadlineMs()` returns a `number` always, and `remainingBudget()` is a `number` rather than `number \| undefined` | if your drain legitimately takes longer, say so — and move the pair together, or you have only relocated the kill |
| 21 | `semantic.remember` puts its TTL through `assertTtl` like every other write, with `jitterFraction: 0` | pass a finite, non-negative lease. It used to compute `ttlMs` itself and hand a tier a value no other write path can produce |

Entry 18's pair, both sides or neither:

```ts
configureLifecycle({ deadlineMs: 600_000 });   // and terminationGracePeriodSeconds >= 600
```

`jobs` and `realtime` are the two roles that most need a bound and declared none, so before 2.0.0 they drained unbounded — a worker pod holding a long job past `terminationGracePeriodSeconds` is `SIGKILL`ed by the kubelet mid-statement, which is the failure the deadline exists to prevent.

### 26. What a value becomes when it leaves the process — and the one migration

A `money()` property is **three** physical columns, not two: `<p>_minor`, `<p>_currency` and the new `<p>_scale`. **Every existing app needs a migration** — without the column, every read of that table names a column it does not have.

```sql
alter table "<t>" add column "<p>_scale" integer check (<p>_scale is null or (<p>_scale >= 0 and <p>_scale <= 15));
```

Byte-for-byte what `generateMigration`'s `columnClause` emits. `NULL` is the right value for every existing row: it means *the currency's own minor unit*, which is what those rows always meant, where `0` would mean whole units. `examples/dummy/packages/db/migrations/0002_money_scale.sql` is the worked example, hand-written because `x db gen` answers `X_MIGRATION_SNAPSHOT_MISSING` in an app whose `0001` records no snapshot.

The other three projections in the same entry:

| Was | Now |
|---|---|
| `t.nullable(x)` emitted `{ …converted, nullable: true }` | `{ anyOf: [<converted>, { type: 'null' }], …annotations }`. `nullable` is an OpenAPI 3.0 keyword no later draft defines, so every validating consumer rejected `null`. A hand-written consumer reading `schema.nullable` reads `schema.anyOf` instead |
| `.default(value)` accepted any value | a default `structuredClone` refuses — a function, a class instance, a `Proxy` — throws `X_SCHEMA_DEFAULT_UNSHAREABLE` at the **first import of the file that declares it**. Pass a plain value, or a factory the handler calls |
| `query({ input })` accepted any schema | an input that cannot survive a query string is refused at `query()` with `X_QUERY_INPUT_UNENCODABLE`, in the declaring file. A read is `GET /_x/query/<name>`, so its input is characters: flatten the nested object, or make it an `action` |

### Entries 6, 14, 16 and 20 — state that does not survive the deploy boundary

No edit for most apps, and each is a one-time cost worth knowing before it is a support ticket.

| # | What goes cold, or re-runs | Why, and what to do |
|---|---|---|
| 6 | a cached query is cold once | `@ultimat3/query` no longer ships its own read-cache seam. Removed: `setReadCache`, `getReadCache`, `invalidateQueryTags`, `MemoryReadCache`, `DEFAULT_READ_CACHE_MAX_BYTES`, and the types `ReadCache` and `ReadCacheEntry`; `DEFAULT_READ_CACHE_TTL_MS` stays. A Redis deployment's read path changes in **both** directions — it was the Redis tier alone, so every cached read was a network round trip; it is now read-down/promote-up across `request-memo → lru → redis`, and concurrent misses of one key share a single load |
| 14 | an in-flight idempotency record is unreachable | the stored key's shape changed with the signature, so on the shared Postgres store a retry crossing the deploy boundary finds no record and **re-runs the handler**, inside the 24h window. `truncate x_idempotency` after deploying makes that state honest rather than half-reachable. The memory store dies with its process and is unaffected |
| 16 | an action job does not dedupe against its pre-deploy row | `@ultimat3/action`'s `fingerprint` is SHA-256/16, so `job-handle.ts`'s dedupe key `action:<name>:<fingerprint>` changed. Action idempotency itself is unaffected in practice, because the key changed too |
| 20 | a cursor minted before the deploy is rejected once | the query fingerprint is SHA-256/16 hex where it was FNV-1a/32 — 4×10⁹ values, brute-forceable offline in seconds, and a fingerprint here is a **sharing key over client-chosen input**. The canonical form is unchanged, so only the hash moved; `X_CURSOR_INVALID`'s `fix:` is already *request the first page again* |

An app that installed its own read cache registers it where every other cached surface already took one:

```diff
- setReadCache(myCache);
- invalidateQueryTags(tags);
+ registerTier(myTier);        // from @ultimat3/cache
+ invalidateTags(tags);        // literally the same call
```

A process that registers no tier reads **uncached** rather than filling a store no fan-out can see.

### Entries 1 and 2 — the CLI

`x db branch` takes a verb. The argument *was* the branch name and the dispatcher fell through to it, so `x db branch ls` — the `fix:` line the planned `x branch` command hands out — cloned the database into one called `ls`. A stray database is not a typo an agent can see: it is a copy of production-shaped data with a name nobody will recognise a week later.

```diff
- x db branch feat-new-billing
+ x db branch create feat-new-billing
```

| Verb | What it does |
|---|---|
| `x db branch create <name>` | the old bare-name form, said out loud |
| `x db branch ls` | name, location, created-at, size |
| `x db branch drop <name>` | what only `dropBranch('<name>', { force: true })` could do before |

Every verb is itself a legal branch name, so verb-first is the only shape where a name cannot be read as a subcommand. A word outside that set is `X_CLI_UNKNOWN_COMMAND`, and its `fix:` hands your own word back inside the command that still creates it. `drop` takes no confirmation flag deliberately — it may only remove what `ls` shows. `branchSql` is removed with the `psql` shell-out it was the text for; an external clone now runs through `@ultimat3/db`'s `createBranch()`, which is what makes `ls` work at all — the old path wrote the database and no marker comment, so every branch the CLI made was invisible to the only lister the framework has. Branches created by the old path carry no marker and are listed and dropped by neither.

`x new` writes no migration: `packages/db/migrations/0000_initial.sql` and its `.hash` are gone from the scaffold, and `x db gen` is that directory's single writer (axiom 1). A hand-written first migration could not carry the `.snapshot.json` only the generator produces. **A scaffold that declares an entity is therefore red on `x verify`'s `drift` step until the first generate runs, and that is correct behaviour:**

```sh
x db gen "initial"
x db migrate
```

`bin/setup` runs both for you, generating only when the directory holds no `.sql`.

### 3. An MCP tool is named by its export name, verbatim, on every surface

`snake_case` tool names are gone, and so is `toToolName`. One primitive was reachable under one name and published under another — the **served** name has only ever been the export name, while three *publishers* spelled the same tool `publish_post`. So an agent handed `openapi.json` called `tools/call { name: "publish_post" }` and got ToolNotFound: the catalog it was given was the wrong one.

| Was | Now |
|---|---|
| `publishPost.tool().name` → `'publish_post'` | `'publishPost'` |
| `openapi.json` → `"x-ultimate": { "mcpTool": "publish_post" }` | `"mcpTool": "publishPost"` |
| `publishPost.describe().mcp.tool` → `'publish_post'` | `'publishPost'` |
| `import { toToolName } from '@ultimat3/action'` / `'@ultimat3/query'` | removed from both — there is no derivation left to call |

Nothing that *worked* moves: a `tools/call`, a `scopes:` entry and a `visibleTo` list were already spelled verbatim, and a snake_case `scopes:` entry was already `X_MCP_SCOPE_UNKNOWN` at boot. What moves is everything read off the published contract — run `x manifest` to regenerate `openapi.json`, then re-point any agent prompt, saved tool allowlist, generated client or test that took its tool name from `x-ultimate.mcpTool`, `describe().mcp.tool` or `.tool().name`. `x.manifest.json` is unaffected: its `mcp` fact never carried a tool name.

### Entries 27, 29, 31 and 33 — renamed, one import each

```diff
- import { EPOCH } from '@ultimat3/time';
+ import { epoch } from '@ultimat3/time';        // 27 — call it: epoch()

- import { resolveEnvironment } from '@ultimat3/seo';
+ import { resolveEnvironment } from '@ultimat3/core';   // 29

- import { checkDrift } from '@ultimat3/cli';
+ import { checkSourceDrift } from '@ultimat3/cli';      // 31 — same signature, same findings

- import { FRAMEWORK_VERSION } from '@ultimat3/core';
+ import { frameworkVersion } from '@ultimat3/core';     // 33 — call it: frameworkVersion()
```

| # | Why the spelling had to move |
|---|---|
| 27 | `EPOCH` was one shared mutable `Date` exported from a tier-1 package, so any consumer calling `EPOCH.setUTCFullYear(...)` corrupted it for every other consumer in the process, permanently and silently. A `Date` cannot be frozen — `Object.freeze` does not close `setTime` — so it could not be fixed in place. `instant()` also returned the caller's own object and now does not, and `describeCron` **refuses** a 6-field expression with `X_CRON_NOT_DESCRIBABLE` where it used to return a wrong sentence |
| 29 | the name existed in `@ultimat3/core` and `@ultimat3/seo` with different parameters and different return unions — the axiom-1 violation the 1.1.0 notes named and deferred. Core's takes an options object, `resolveEnvironment({ env })`, and **throws** `X_ENVIRONMENT_INVALID` on a typo'd `ULTIMATE_ENV`; `tryResolveEnvironment()` is the caller that must answer rather than fail |
| 31 | two functions named `checkDrift` answered two different questions. `@ultimat3/db`'s keeps its name and its meaning — the live database against the ledger. The CLI's is the entity source hashed against what `x db gen` recorded, no database. Nothing an app writes calls either |
| 33 | read at module scope, the version resolved before `main` in every process that imported core, so `x build --target binary` produced an executable that threw at import. `@ultimat3/mcp`'s `DEFAULT_SERVER_INFO` becomes `defaultServerInfo()` and `@ultimat3/cli`'s `CLI_VERSION` becomes `cliVersion()` for the same reason — a constant holding the result is the module-scope read again, one import away |

Entry 29 also renames one environment across seo's surface. `isIndexable()` and `RobotsConfig.environment` take core's `Environment`, so `'staging'` is accepted and `'preview'` is a compile error; **no `robots.txt` body changes**, because neither spelling was ever indexable and only the `# environment:` comment line moves.

```diff
- buildRobots({ environment: 'preview' })
+ buildRobots({ environment: 'staging' })
- import type { SeoEnvironment } from '@ultimat3/seo';
+ import type { Environment } from '@ultimat3/core';
```

### 30. The NATS wire client is `nats@2.29.3`, and the transport seam did not move

`@ultimat3/realtime` hand-rolled the protocol — framing, parser, PING/PONG, TLS upgrade, inbox muxing and reconnect, 1,019 LOC plus a 431-line fake nats-server to test it. All of it is deleted, on [`docs/idea/18-build-vs-wrap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/18-build-vs-wrap.md)'s criterion: own what must join the transaction, context and error machinery; wrap a wire protocol with a dominant maintained client, because an agent knows that client's semantics from training and can never know a reimplementation. `nats` is the first external runtime dependency any `@ultimat3/*` package has taken, pinned exact, importable from exactly one file.

`Transport`, `NatsTransport`, `NatsTransportOptions` and `selectTransport` are the same seam and cost no edit. The test seam moved up one level, from an injected byte stream to an injected client:

```diff
- new NatsTransport({ url, bucket, open: (target) => Promise.resolve(stream) });
+ new NatsTransport({ url, bucket, connect: fakeNatsConnect(broker) });
```

| Direction | Names |
|---|---|
| removed | `NatsConnection`, `NatsConnectionOptions`, `NatsConnectOptions`, `NatsProtocolParser`, `NatsOperation`, `NatsServerInfo`, `NatsStream`, `natsStreamOver`, `bunNatsStream`, `FakeNatsServer`, `fakeNatsStream` |
| added | `NatsClient`, `NatsConnect`, `NatsClientOptions`, `NatsRequestOptions`, `NatsRequestManyOptions`, `openNatsClient`, `FakeNatsBroker`, `fakeNatsConnect` |
| unchanged, moved to `nats-client.ts` | `NatsHeaders`, `NatsMessage`, `NatsMessageHandler`, `NatsSubscription`, `NatsTarget`, `parseNatsUrl` |

The JetStream KV layer stays ours: this client's KV abstraction expresses neither per-message TTL nor a batch `multi_last` direct get.

### Entries 7–12 and 24 — deleted because nothing read them

Every one had zero callers in the framework and in both tracked apps. In each case the edit is *delete the import*, and the replacement — where there is one — is named beside it.

| # | Gone | Instead |
|---|---|---|
| 7 | `requireRole` / `requireScope` (`@ultimat3/auth`) | declare the rule as a `Policy` — `can('admin:access')`. They decided a 403 outside `@ultimat3/policy`, so a route gated that way reported `policy: null` in `x routes`, in `framework.manifest.json` and in `openapi.json`, and `x policy list` reported its permission unenforced. `requireActor` / `currentActor` stay — those assert *authentication* |
| 8 | `readOnly()`, `assertReadOnly()`, `inspectStatement()`, `MutationVerdict`, `ReadOnlyOptions`, `readonlyViolation()` (`@ultimat3/db`); `X_READONLY_VIOLATION` is retired | `readOnly(db()).query(f)` → `readOnlyQuery(text, { role: await ensureReadOnlyRole() })`, which reports which defences engaged. The deleted lexer judged statement keywords and nothing else, so `select pg_sleep(60)` and `select pg_read_file('/etc/passwd')` both read as reads |
| 9 | `checkBudgets`, `assertBudgets`, `parseBytes`, `DEFAULT_BUDGET`, `BUDGET_UNITS`, the four `Budget*` types, `budgetExceeded()`, `RouteBudget`, `RouteRecord.budget` (`@ultimat3/seo`); `X_SEO_BUDGET_EXCEEDED` is retired | nothing to call — the gate that runs is `@ultimat3/cli`'s, raising `@ultimat3/render`'s `X_BUDGET_EXCEEDED`. seo is tier 1 and cannot see a build's bytes, so it was never the package that could answer. The retired code's row moves under *Reserved codes* so an old log line still resolves |
| 10 | `renderLd` (`@ultimat3/seo`) | `ld.*` and `meta.ld` — `renderMeta` already emits one `<script type="application/ld+json">` per node, and an app calling both emitted its graph twice |
| 11 | `attachTimeZone`, `timeZoneOf` (`@ultimat3/time`), `attachLocale`, `localeOf` (`@ultimat3/i18n`), `negotiateLocale`, `isValidTimeZone`, `resolveTimeZone` (`@ultimat3/http`) | write the zone with `createContext({ tz })` or `withChildContext({ tz })`, read it with `currentTimeZone()`, and take the other three from the packages that own them. `HttpConfig.locale` and `HttpConfig.tz` hold header and cookie **names** only |
| 12 | `renderHeadTags` (`@ultimat3/seo`) | `renderHead(headFromMeta(meta, seoRenderers()))`. It escaped `</` and nothing else and had no caller, while `renderHead` — the path every `x dev` and every build takes — escaped nothing at all: two serializers, the unused one weaker and the used one vulnerable. It could not borrow render's escapers, because `xml.ts` escapes **into** entities, which is right for XML and exactly wrong inside a raw-text element |
| 24 | `HelloFrame.resume` and `FRAME_LIMITS.resume` | drop the key. A cursor rides its own `subscribe` frame, which is where resume was always decided — the node replied `resume: []` and read the field from nobody, so every reconnect shipped each cursor twice, up to 512 ids per subscription, during the exact restart storm the herd bound exists to flatten |

`PROTOCOL_VERSION` was deliberately **not** bumped for entry 24: `decode` builds a whitelist, so a new node drops an old client's `resume` and an old node reads a new client's omission as the empty list it always received. Both skews are readable, and bumping would refuse every in-flight client on a rolling deploy to buy nothing — the version guards incompatibility, not novelty.

Entry 11 also brings a stricter zone rule with it: `CET`, `EST5EDT`, `+01:00` and `''` are refused, and a resolved zone comes back canonically spelled, so one zone is one formatter-cache key. The supported locale set and fallback are `defineCatalogs({ locales, default })`; the fallback zone is `configureTime({ defaultZone })`. `TimeZoneSources` gains `cookie`, and the default order is `user, cookie, query, header` — explicit before inferred.

### Entries 19 and 28 — a required argument, because an optional one is one a call site can forget

```diff
- cacheKeyFor(name, input, tags)
+ cacheKeyFor(name, input, tags, readAuthority(ctx.actor, 'actor'))
```

`readAuthority(actor, scope)` is the only thing that produces the value, and `'actor'` keeps 1.2.0 behaviour for a per-caller read. The forgotten authority is a cross-tenant read, which is why it is positional and required rather than an option with a default. Entry **14** is the same argument on `idempotencyKeyFor(name, input, actor)`, where the forgotten one is a cross-actor replay.

Entry 28 puts one new line on every `job()` and every `backfill()`:

```diff
  export const notifySubscribers = job({
    input: t.object({ postId: t.uuid, orgId: t.uuid }),
    idempotencyKey: ({ postId }) => `notify:${postId}`,
+   tenant: ({ orgId }) => orgId,
    retry: { attempts: 5, backoff: 'exponential' },
    async run({ input, ctx }) { /* … */ },
  });
```

A definition with no `tenant` is `X_JOB_TENANT_REQUIRED` at declaration. `tenant: 'none'` is the other legal answer and means the **opposite thing on each side of the factory**: on a `job()` it declares the body touches no tenant-scoped table, because every scoped read then fails closed with `X_TENANCY_ACTOR_ORG_REQUIRED`; on a `backfill()` — which forwards `tenant` verbatim — it is how a sweep declares it spans every tenant, and `backfillPass` opens the bounded `crossTenant` scope for it, never the author.

In the same slice, on the read primitive, a bare boolean policy bypass gains a reason:

```diff
- sourceFor(target, input, { ctx, enforce: false })
+ sourceFor(target, input, { ctx, unenforced: 'explain returns no rows' })
```

The reason is required, a blank one is refused before the source is built, and one `query.policy.unenforced` audit line is written at `debug`.

### Entries 22, 23, 25 and 32 — types, and anything implementing an interface structurally

| # | Was | Now |
|---|---|---|
| 22 | `OutboxRelay.stop()` returned `void` | `Promise<void>`. It cleared the timer and returned *underneath* the pass in flight, so a role shutdown that awaited it resumed while a publish and its `markPublished` were still running — a torn write against a closing pool. Callers ignoring the return value keep compiling and keep the old race |
| 23 | `TierFailure.tier` was `TierName` | `TierLabel = TierName \| 'query-read'`, because `@ultimat3/query`'s read tier degrades through the same `bestEffort` wrapper and had nowhere to report as. A `switch` over it needs a `'query-read'` arm |
| 25 | `qidOf(name, input)` was `<name>:<fnv1a 32-bit>` | `<name>:<first 16 hex of SHA-256>`. A `qid` is a **sharing** key — a hit hands back the seated window, carrying the first subscriber's input and rows — and input is client-chosen, so 32 bits is a collision found offline in seconds and one client served out of another's window. A rolling deploy costs one bounded snapshot per subscription |
| 25 | `queue.drain(send)` marked each mutation `acked` when `send` resolved | a drained mutation stays `inflight` until the server settles it with `ack`/`fail` or `requeueInflight()` returns it. `DrainReport.remaining` is now what is still **sendable**; a UI rendering *unsynced* should read `pending()`, which is unchanged and still counts both |
| 25 | `SyncNode` had one teardown, `stop()` | it also declares `stopAccepting()`, called by the SIGTERM `accept` phase — additive for a `createSyncNode` caller, **breaking** for anything implementing the interface structurally. `SyncNode.websocket` no longer carries `publishToSelf` |
| 32 | `invariants: [ invariant(name, (c) => …) ]` | `invariants: (c) => [ invariant(name, …) ]` — see the diff below |

`SyncSocket.subscribeTopic` / `unsubscribeTopic` no longer call Bun's `ws.subscribe` / `ws.unsubscribe` either: every channel message is one filtered `send` per socket through `SocketRegistry.deliver`, because a native publish cannot be refused per socket, cannot report the frame it dropped and cannot mark a subscriber desynced.

Entry 32 is mechanical — move the `[` to after `(c) => `, drop each `(c) =>` inside `invariant()`, drop every `!`:

```diff
- invariants: [
-   invariant('post_title_not_blank', (c) => c.title!.trimmed().minLength(1)),
-   invariant('post_price_non_negative', (c) => c.price!.minor.atLeast(0)),
- ],
+ invariants: (c) => [
+   invariant('post_title_not_blank', c.title.trimmed().minLength(1)),
+   invariant('post_price_non_negative', c.price.minor.atLeast(0)),
+ ],
```

The defect it fixes is why every generated entity needed a `!`: `InvariantColumns` was an index-signature type, so under `noUncheckedIndexedAccess` every `c.title` was `ColumnExpr | undefined`. It is now a mapped type over the declared columns, so `c.title` is a `ColumnExpr` and `c.titel` is `TS2551: Property 'titel' does not exist … Did you mean 'title'?`. `unique()` and `satisfies()` take `keyof C & string`, so a typo in a column *list* is caught too. `indexes[].where` is unchanged — it was already a callback, and its `c` is now typed too.

## What semver covers

| Surface | From |
|---|---|
| `X_*` error codes | already stable forever — a shipped code never changes meaning and is never reused |
| The eight primitive shapes | `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` and their declared fields — 1.0.0 |
| The `x` CLI surface | commands, flags, exit codes, and `--json` output shape — 1.0.0 |
| The import tier table | which package may import which — 1.0.0 |
| `app.config.ts` field names | renaming or removing a field is a major — 1.0.0 |

| Bump | Means | Examples |
|---|---|---|
| **major** | a covered surface changed incompatibly | a removed config field, a renamed CLI flag, a changed primitive field, a narrowed tier |
| **minor** | additive, old code still compiles and still passes `x verify` | a new optional field, a new command, a new driver behind an existing interface |
| **patch** | no surface change | a bug fix, a perf change, a corrected `fix:` line |

1.0.0 means a stable API under semver. It is not a claim about your infrastructure.

## Release policy

| Rule | Detail |
|---|---|
| Pinned exact versions | no `^`, no `~`, in the framework or in a generated app. A range is a silent upgrade |
| Lockstep releases | one release bumps all 30 packages — 29 `@ultimat3/*` plus the unscoped `create-ultimate` — to the same version. One version, one commit, one tag. A mixed set is unsupported |
| Published with provenance | npm via OIDC trusted publishing. Every tarball from 3.0.0 onward carries an attestation — verified through 5.0.1; **2.0.0's do not**, that release went out by hand. Per version: `npm view @ultimat3/core@<version> dist.attestations` |
| Breaking changes land with the edit named | **no release has shipped a codemod** and `x upgrade` is not implemented, so every `BREAKING —` entry names the manual edit itself. A section of this page walks it |
| Dependency upgrades are framework work | Solid is pinned to **`1.9.14`, the stable line** — Solid 2 is still prerelease (`2.0.0-beta.N`, DOM renderer split into `@solidjs/web`) and every app inherits whatever core this repo pins. Bumping it is a framework release, never an app-level `bun update`. There is no ArkType or Drizzle pin to carry: `@ultimat3/schema` ships dependency-free builtin validators (ArkType is an optional provider you adapt yourself) and `@ultimat3/entity` ships its own `postgresDriver()` |
| Bun floor | `>=1.3`, target 2.0. Below the floor → `X_BUN_VERSION` |
| Not shipped `As of 2026-08`, behind the interfaces that ship today | realtime tier 3 (`persist: true`, local-first), the plugin API, multi-region replication, and the Redis/NATS **job** drivers — the last throw `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

Do not upgrade a transitive dependency of a `@ultimat3/*` package by hand. Open an issue instead — the pin is deliberate.

## `x upgrade` — **planned, not shipped**

`As of 2026-08` this command exits `X_NOT_IMPLEMENTED` ([`packages/cli/src/cmd-planned.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/cmd-planned.ts)). Its own `fix:` line names what to run instead, and that is the upgrade path today:

```
bun update --latest && x verify     # the shipped path
```

Everything the manual path skips, you do yourself: bump every `@ultimat3/*` pin to **one** exact version, then `x manifest` and `x verify`. There are no codemods to run, because no release has shipped one yet.

The design below is what the command will do, kept here because the **classes of breakage it automates are real today** and the next section is how each one is detected with or without it.

| # | Step | Detail |
|---|---|---|
| 1 | Resolve the target release | all `@ultimat3/*` at one version; refuses a partial set |
| 2 | Bump `package.json` pins | every workspace, exact versions |
| 3 | Run codemods | per-release, idempotent, AST-based. Each prints the files it touched |
| 4 | Regenerate `x.manifest.json` | routes, entities, actions, jobs, policies, tags, budgets |
| 5 | Regenerate `openapi.json` | HTTP surface from action/query declarations |
| 6 | Run `x verify` | the gate. Not green = the upgrade is not done |

`--dry-run`, once it exists, performs 1, 3 (in-memory), and reports the diff without writing. Output carries every changed file, every codemod name, and every check that would fail.

## Breaking-change classes and how each is detected

Nothing here relies on you reading a changelog carefully. Each class is a build error.

| Class | Detected by | Code | Fix |
|---|---|---|---|
| Action/query contract change | `x verify`'s `contract-diff` step, against the committed `x.manifest.json` | `X_MANIFEST_BREAKING` | `x verify --json` to read the finding, then bump the major version or restore the input/output shape |
| Breaking published surface | manifest contract diff, breaking subset | `X_MANIFEST_BREAKING` | bump the app's major version; old clients keep the old shape |
| Schema vs migrations | schema introspection vs migration history | `X_DB_DRIFT` | `x db gen "<message>"` then `x db migrate` |
| Stale generated facts | manifest freshness check | `X_MANIFEST_STALE` | `x manifest` |
| Import-tier change | `scripts/boundaries.ts` re-run over the new tier table | `X_BOUNDARY_VIOLATION` | move the import down a tier or invert the dependency |
| Budget ratchet | a release lowering a default budget | `X_BUDGET_EXCEEDED` | fix the regression, or set an explicit `budget` on the route |
| Config field rename/removal | config schema parse, and the compiler before it — an unknown key is an excess property on `Input<AppConfig>`, so it fails `typecheck` rather than reaching a runtime parse | `X_CONFIG_INVALID` | the cause names the field. No codemod has shipped yet, so this is a manual edit |
| Env schema change | typed env parse at boot | `X_ENV_MISSING` | add the key; fails in ~40ms, not as a later 500 |
| Renamed job step | duplicate/unknown step names in one `run` | `X_STEP_DUPLICATE` | renaming a step invalidates its stored result — treat as a new step |

Budgets ratchet **down** across releases. That is intentional: a framework release that makes bundles smaller should not leave your app's slack unclaimed.

## Version skew during a deploy

A client running build `A` requesting an asset from build `B` is the failure mode that actually breaks PWAs — not caching strategy.

| Mechanism | Behavior |
|---|---|
| Immutable build ID | content hash of the build, stamped into `sw.js`, the HTML, every asset path, and `x.manifest.json`. Never a timestamp, never `latest` |
| Client sends its build ID | `X-Ultimate-Build` on RPC, query, and WS handshake — so the server answers "you are stale" instead of guessing |
| N-deploy asset retention | the last **3** builds' assets stay served — `retentionPlan(deploys, keep = 3)` in [`packages/pwa/src/version-skew.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/version-skew.ts). A count of deploys, with **no time component**: there is no 7-day half, and **no `pwa.retention` field** — `PwaConfig` was `{ enabled, offline, installPrompt, backgroundSync, push }` at 7.0.0 (`installPrompt` is deleted in 8.0.0). Pass `keep` at the call site to hold more |
| `AppUpdateAvailable` signal | a Solid signal flips when the server reports a newer build. Your app renders its own "Update available — reload". No forced navigation, no lost form state |
| Forced reload | **not a capability this framework has, `As of 2026-08`.** 9.0.0 deleted `updateSignal`, `updatePolicy`, `DEFAULT_GRACE_MS` and their types — they computed a grace, a `forced:` flag and a `deadlineAt`, and nothing performed the reload, nor could: `@ultimat3/http` (tier 2) and `@ultimat3/realtime` (tier 3) both sit below `pwa` (tier 4). Notification is complete — read `useConnection().updateAvailable`, or compare the worker's posted `to` with `detectSkew`, and render your own affordance. `x deploy --critical` was **removed in 4.0.0** for the same reason: echoed into the deploy plan, read by nothing |
| Skew is observable | the `/_x` live panel reports the build-ID distribution of connected clients. `x status --json` is **planned**, not shipped |
| The realtime **wire** is versioned separately | `PROTOCOL_VERSION` is a small integer in `@ultimat3/realtime`, `2` `As of 2026-08-24`. It is not the build id and it does not move per release: it moves only when a frame one side writes is a frame the other cannot read. A mismatch is `X_PROTOCOL_VERSION` on the frame — **clients and `sync` nodes are redeployed together across a bump**, because a cursor rides both the client's `subscribe` and the node's `snapshot`, so the skew breaks resume from either end ([Realtime](Realtime#wire-protocol-version)) |

Server behavior on a stale build ID:

| Request | Response |
|---|---|
| Asset within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`; the SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; otherwise `X_BUILD_SKEW` with a `fix:` line |
| WS handshake | accepted, then an `update-available` frame carrying the server's `buildId` → signal flips. The socket is **not** killed |

Full detail: [PWA and offline](PWA-And-Offline).

## Migrating jobs between drivers — **still nowhere to migrate to**

**There is no `jobs.driver` field.** 5.0.0 deleted it, because it selected nothing: boot always built `createPgDriver`, so `jobs: { driver: 'redis' }` gave you Postgres in silence. Which driver runs is `setJobDriver(driver)` at boot, and only that.

`x jobs drain --to` takes **`memory` \| `redis` \| `nats`**, and `memory` is the only target that lands a job: `redis` and `nats` are interface-complete stubs that throw `X_NOT_IMPLEMENTED`. So **there is no driver migration to perform** `As of 2026-08` — `x jobs drain --to redis` constructs the target and fails on its first enqueue. Postgres is the source, never a `--to` value.

`x jobs drain --to memory` works today, and it is the same command, so the procedure below is written against the interface that already ships and applies unchanged the moment a driver does:

| Order | Step |
|---|---|
| 1 | deploy with the old driver still installed |
| 2 | `x jobs drain --to <driver> --dry-run --json` — read the plan; a skipped candidate is a job whose `runAt` has not arrived, not an error |
| 3 | `x jobs drain --to <driver>` — leases the batch off the old queue, copies steps, enqueues, then acks |
| 4 | change the `setJobDriver(…)` call at boot, `x verify`, deploy |
| 5 | confirm with `x jobs ls --json` that the old queue is empty before removing its infra |

Job code never changes across a driver: `steps` is a driver member, so step persistence is identical on all of them. The outbox table stays the transactional record. At-least-once delivery is preserved; atomicity is not negotiable ([Jobs and workflows](Jobs-And-Workflows)).

## Migrating realtime tiers

| From → to | Change | Notes |
|---|---|---|
| tier 1 → tier 2 | `live: true` on the query | needs a `replicator` role and `orderBy` + `limit` on the `sql` |
| tier 2 → tier 3 | `persist: true` on the query | not shipped `As of 2026-08`. No new mutators, no new authz, no new server code |
| `memory` → `nats` transport | `realtime.transport`, and **`realtime.urlEnv`** — the env *key name*, not a URL. There is no `realtime.url` field | roll `sync` and `replicator`; clients reconnect with server-directed backoff. What actually decides the transport at boot is **`NATS_URL` being set**: `selectTransport(env)` never reads `config.realtime.transport`, so the config field documents intent and the env var makes the switch ([Configuration](Configuration)) |

## Where the facts live

| Source | Contents |
|---|---|
| [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) | Keep a Changelog format, `Added` / `Changed` / `Removed`. A `BREAKING —` entry names its manual edit **inline**; there is no per-entry `Migration` block convention and never a codemod name — `grep -c '\*\*Migration' CHANGELOG.md` answers `9` `As of 2026-08-23`, against 111 breaking entries |
| [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md) | the twelve milestones, 0–10 shipped. Milestone 11's two-platform deploy proof is the one item still open |
| [`docs/idea/15-risks.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/15-risks.md) | what could still change shape — the sync engine is roughly 70% of total effort |
| [`docs/architecture/19-cutting-a-major.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/19-cutting-a-major.md) | how this page is maintained: one section per major, written when the first breaking change lands. Maintainer-facing — read it if you are opening a PR against the framework, not if you are upgrading an app |
| `x.manifest.json` | generated, per build. Diff two manifests to see exactly what a release changed in your app |

Read the changelog **backwards from your current pin to the target**, and read the `BREAKING —` entries only — the rest is regenerated for you.

## When an upgrade fails

```
git revert <the upgrade commit>      # or redeploy the previous image tag
x verify --json > verify.json
```

| Situation | Do |
|---|---|
| Prod is already rolling | redeploy the previous image tag. Assets from the previous build are inside the retention window, so sessions survive |
| An entry's named edit did not compile | keep the diff. It is the most useful part of the bug report, and it is the entry that is wrong |
| `x verify` fails on one check | read that step's findings from `x verify --json`, then reproduce it with the command its `fix` names |
| Cause is unclear | `x errors explain <CODE> --json` |

File an issue with `verify.json` attached, your previous and target versions, and the entry you were following. The JSON is the report — do not paraphrase the terminal.

Symptom-first fixes: [Troubleshooting](Troubleshooting). Code index: [Error codes](Error-Codes).
