# 02 — Bugs: tiers 2–3

> Part of [`overview.md`](overview.md). Depends on: none (independent of 01). Tiers: 2–3.

`entity` · `policy` · `http` · `auth` · `action` · `query` · `jobs` · `realtime`. Every new failure
mode gets a registered code, a runnable `fix:`, a `wiki/Error-Codes.md` row, then `bun run manifest`.

## Critical

- `packages/query/src/cache.ts:34` — the read-cache key omits the actor and the tenant, so any query
  declaring `cache:` serves one actor's rows to the next. `cacheKeyFor(name, input, tags)` returns
  `query:<name>:<fingerprint(input)>:<tags>`, and `readThrough` (`read.ts:169`) writes it into the
  **process-wide** tier (`read-cache.ts:94`, a module-level `MemoryReadCache`) — while `sql(input,
  ctx)` is handed the `Ctx` and documented as scoping by the actor (`http.ts:74-78`), and
  `@ultimat3/entity` scopes every tenant-scoped read off `ctx.actor.orgId`
  (`packages/entity/src/tenancy.ts:151-164`). Proven: a `cache: { tags: [], ttlMs: 60_000 }` query
  filtering on `ctx.actor.orgId` returned `{id:'a1',orgId:'org-a',secret:'ALPHA'}` to an `org-b`
  actor. The request memo above it is safe — keyed on `ctx` identity (`cache.ts:22`) — only the tier
  key is wrong. Fix: fold the read's authority into the key (`ctx.actor.orgId` at minimum,
  `ctx.actor.id` when the read is per-user). Follow `packages/entity/src/batch-read.ts:63-82`, whose
  `scopeKey` puts every predicate including the derived tenant one into the sharing key for exactly
  this reason.

## High

- `packages/action/src/invoke.ts:230` with `packages/action/src/http.ts:56` — an `Idempotency-Key`
  header present but empty is treated as a real key, and keys are never scoped to the caller, so one
  actor's response is replayed to another. `Headers.get()` returns `''` for `Idempotency-Key:`, and
  `'' === null` is false, so the call proceeds with `idempotencyKeyFor(name, '')` = `"<action>:"` —
  one shared record. Separately `idempotencyKeyFor` (`idempotency.ts:142`) namespaces by action name
  only, so key `abc` from actor A and actor B is one record. Proven both ways: bob received
  `{chargedTo: "alice:…"}`. With a differing payload the second caller instead gets
  `X_IDEMPOTENCY_CONFLICT` — a cross-actor DoS on a guessable key. Fix: treat a blank header as
  absent, and put the actor into the namespace — `idempotencyKeyFor(name, actorScope, key)`, the
  shape `packages/jobs/src/scheduler.ts:153` already uses.

- `packages/realtime/src/channel.ts:151-161` — `ChannelHub.#bridge` is check-then-act across an
  `await`, so two concurrent subscribes to one topic open **two** transport subscriptions; the first
  is orphaned forever and every message on that topic is delivered twice. `#bridge` reads
  `this.#bridges.get(name)`, then `await this.#transport.subscribe(...)`, then `set(...)`;
  `packages/realtime/src/sync-node.ts:348-372` runs every inbound frame in its own detached
  `void (async () => …)()` with no per-socket serialization. Proven: `created: 2, live: 1` after one
  unsubscribe. The orphan is unreachable by `#release`, survives socket close, `teardown` and
  `hub.close()` (which iterates `#bridges` only), and keeps invoking `SocketRegistry.deliver` for the
  life of the node. Fix: publish the in-flight promise before awaiting it and share it, as
  `packages/realtime/src/query-window.ts:114-125` (`startRead`) does.

- `packages/realtime/src/live-query.ts:173` and `packages/realtime/src/channel.ts:77` — both
  subscription caps are check-then-act across awaits, so a client bypasses `maxPerSocket`,
  `maxPerTenant` and `maxTopicsPerSocket` by batching its subscribes. `assertCapacity` runs at the
  top; the registration that grows the count (`#attach` → `socket.queries.set`, `#book.add`) happens
  only after `await authorize`, `await prepare` and `await #read`. One WebSocket write containing N
  subscribe frames — dispatched concurrently by `sync-node.ts:348` — passes a check that still reads
  `size === 0`, N times. Each live subscribe builds a query entry, a matcher and a snapshot read, so
  the one mechanism bounding that work does not bound it (`subscription-book.ts:66-69` calls it
  "load shedding, not a crash"). Fix: reserve the slot synchronously before the first await and
  release it on the failure path, or serialize inbound frames per socket in `sync-node.message`.

- `packages/http/src/error-map.ts:12-119` — the closed status table omits framework codes reachable
  from a request and caused by the caller, so each answers **500** and pages the on-call:
  `statusFor` falls through to `DEFAULT_STATUS` and `packages/http/src/stages.ts:295` calls
  `reportError` for every `status >= 500`.

  | Code | Owner | Should be |
  |---|---|---|
  | `X_IDEMPOTENCY_CONFLICT` | action | 409 |
  | `X_IDEMPOTENCY_REPLAYED_FAILURE` | action | 409 |
  | `X_CURSOR_INVALID` | core (thrown by entity's `seekFrom`) | 400 |
  | `X_TENANCY_ACTOR_MISMATCH` | entity | 403 |
  | `X_TENANCY_ACTOR_ORG_REQUIRED` | entity | 403 |
  | `X_TENANCY_CROSS_DENIED` | entity | 403 |
  | `X_PASSWORD_WEAK` | auth | 422 |
  | `X_DB_UNIQUE_VIOLATION` | db | 409 |
  | `X_DB_FOREIGN_KEY_VIOLATION` | db | 409 |
  | `X_QUERY_NOT_PAGEABLE` | query | 400 |
  | `X_LOCALE_UNSUPPORTED` | i18n | 400 |

  Sharpest instance is a self-contradiction inside one package: `packages/action/src/http.ts:151`
  publishes `'409': problemResponse('X_IDEMPOTENCY_CONFLICT')` in the OpenAPI operation while the
  runtime answers 500 for that code. Same failure the file's own comment at `:59-63` describes for
  `X_INPUT_INVALID`. Fix: add the rows, **and** add a verify step failing when a manifest code owned
  by a tier ≤ 4 package has no row — the table is closed by design, so completeness must be
  enforced (axiom 3).

## Medium

- `packages/auth/src/jwks.ts:174-178` — the unknown-`kid` refetch is not rate-limited, contradicting
  `:96-102` ("One refetch, not one per token … rate-limited by the same TTL"). `known` is false for
  every invented `kid`, so `load()` runs on every attempt; `inflight` coalesces only *concurrent*
  callers, so sequential forged tokens each issue an outbound GET to the IdP's `jwks_uri`, amplified
  from this node. Fix: track `lastUnknownRefreshAtMs` and refetch on an unknown `kid` only past
  `+ ttlMs`.

- `packages/realtime/src/live-query.ts:29` — `qidOf` is a **32-bit** FNV-1a (`json.ts:62-69`,
  explicitly "Not cryptographic") over client-controlled input, and that qid is the sharing key for
  a cross-subscriber row window, the retained change buffer and every cursor. 4×10⁹ values is
  offline-brute-forceable in seconds. `#entryFor(qid, …)` returns an **existing** entry on a hit and
  `live-definition.ts:76-78` returns the seated `SharedWindow` — both carrying the *first* input, so
  a colliding subscribe passes `authorize` on its own input and is served from another's window. A
  row rule reading `args.row` still fails closed; an `allow()` policy scoping on `input.orgId` leaks
  the other tenant's rows. CONFIDENCE: medium on exploitability, high on the weakness. Fix: use the
  primitive `entity` chose — `new Bun.CryptoHasher('sha256')…slice(0,16)`, as
  `packages/entity/src/cursor.ts:145-155` (`planScope`) does. The same 32-bit hash also backs
  `packages/action/src/stable.ts:66` (the idempotency `requestHash`) and
  `packages/query/src/query.ts:267` (`queryHash`, the cursor scope).

- `packages/realtime/src/channel.ts:157` with `packages/realtime/src/socket.ts:123-131` — Bun's
  native pub/sub is wired on the subscribe side and **nothing ever publishes to it**, so every
  channel frame is an O(all sockets) linear scan. `subscribeTopic` calls `this.#ws.subscribe(topic)`
  and `sync-node.ts:330` sets `publishToSelf: false`, but no `server.publish` / `ws.publish` exists
  anywhere in the repo; every delivery walks the whole socket map in `SocketRegistry.deliver`
  (`socket.ts:214-220`), whose own comment at `:212-213` calls that "the fallback used when a frame
  must be filtered per socket". On the 50,000-socket node the README benchmarks, one channel message
  costs 50,000 `Set.has` probes. `WsLike.subscribe`/`unsubscribe` and `publishToSelf` are
  exported-but-never-wired. Fix: publish through `server.publish(topic, encode(frame))` in
  `#bridge`'s handler and keep `deliver` for the filtered path — or delete the native subscribe
  calls and the flag so the code says what it does.

- `packages/jobs/src/worker-fleet-slots.ts:70-72` — a fleet-slot renewal answering `false` is
  discarded (`void options.leases?.renew(...).catch(noop)`), so `job.concurrency` is silently
  exceeded. `LeaseStore.renew` is documented at `packages/jobs/src/leases.ts:29-30` as "`false`
  means the slot is no longer this holder's", and `SQL_LEASE_RENEW`
  (`driver-pg-sql.ts:206-211`) is guarded on `holder = $3` for exactly that. A worker stalling past
  the slot TTL keeps running after another worker takes slot 0 — two concurrent runs under
  `concurrency: 1`, nothing logged. The file's claim that "the heartbeat is what reports a lost
  lease" is wrong: the heartbeat renews `x_jobs.visible_at`, a different row on a different clock.
  Fix: on `renew() === false`, stop the timer and report as `packages/jobs/src/heartbeat.ts:110-112`
  does (`reportLost(undefined, 'not-ours')`) plus an abort on the run's signal.

- `packages/realtime/src/channel.ts:96-107` — `onActorChange` drops a topic when the guard *failed*,
  not only when it denied: `try { await this.#authorize(...) } catch { this.unsubscribe(...) }`
  catches everything. `LiveQueryRegistry.reauthorize` (`live-query.ts:265-281`) distinguishes with
  `isPolicyDenial(error)` and keeps the subscription on a failure, because "destroying it would
  report a database timeout as a revoked grant, and a client does not resubscribe to a denial". A
  guard is app code and may reach a database. During a re-auth pass (`sync-node.ts:180-208`) with a
  timing-out store, every topic on every re-authenticated socket is dropped silently. Fix: mirror
  `reauthorize`.

- `packages/entity/src/entity.ts:232` — `$parse` treats an explicit `null` as absent
  (`input[property] ?? defaultValue(...)`), so clearing a nullable column that has a declared default
  silently writes the default. `posts.insert({ publishedAt: null })` on a
  `timestamptz().nullable().default(now)` column stores `now()`. `Object.hasOwn` is the
  discriminator this package uses everywhere else for this exact question (`bulk-write.ts:29`,
  `pg-row.ts:69`, `tenancy.ts:257`). Fix: `Object.hasOwn(input, property) ? input[property] :
  defaultValue(...)`.

- `packages/http/src/request.ts:18-27` — `parseQuery` builds a bare `{}` and assigns by key, so a
  repeated `?__proto__=` parameter rewrites the returned object's prototype: the second iteration
  reads `out['__proto__']` (= `Object.prototype`), sees a non-array, and assigns
  `out['__proto__'] = [Object.prototype, 'a']`. Proven: `?__proto__=a&__proto__=b&x=1` yields an
  object whose prototype is an Array, inheriting `length === 3`, `push`, `map`. Contained to the one
  object, but `queryRaw()` hands it to `coerceQuery`/`validateSync` and any schema or handler probing
  `'length' in values` now sees truthy. Fix: `Object.create(null)`, as `packages/i18n/src/catalog.ts:59`
  already does for the same reason.

- `packages/http/src/validate.ts:33` — `if (result.issues !== undefined && result.issues.length > 0)`
  reads an empty `issues` array as success and returns `value`, which is `undefined` on a failure
  result. `packages/query/src/read.ts:199` spells the same check as `if (result.issues !== undefined)`,
  so two layers disagree about a degenerate schema result. CONFIDENCE: low on real-world
  reachability. Fix: drop the `.length > 0` clause.

## Low

- `packages/jobs/src/driver-memory.ts:209` — `attempt: counts ? record.attempt : record.attempt - 1`
  has no floor where the Postgres driver clamps (`SQL_NACK`: `greatest(attempt - 1, 0)`). Repeated
  suspensions drive `attempt` negative in memory only — a two-driver parity break the package's own
  `*-parity` rule exists to prevent.
- `packages/jobs/src/driver-memory.ts:71-79` — `introspect.list` sorts `createdAt` **ascending**
  while `createPgDriver` sorts `created_at desc`. One call, two answers.
- `packages/action/src/idempotency-postgres.ts:84-86` — `SQL_IDEMPOTENCY_SETTLE` carries no
  `where status = 'in-flight'` fence, unlike `SQL_ACK`/`SQL_NACK`
  (`packages/jobs/src/driver-pg-sql.ts:81,93`) whose comments call that fence load-bearing. A late
  settle overwrites a record already replaced by an out-of-window reserve.
- `packages/http/src/overlay.ts:9-14` — `escapeHtml` does not escape `'`. Every interpolation is
  currently inside a double-quoted attribute or element text, but `href="${escapeHtml(facts.docs)}"`
  will follow a `javascript:` value from an error's own `docs` field. Dev-only surface.

## Tests

- Failing-first per finding. Key ones: two actors, one `cache:` query, different rows
  (`bun test packages/query/src/cache.test.ts`); empty `Idempotency-Key` is treated as absent and two
  actors with one key do not share a record; two concurrent `#bridge` calls create one subscription;
  N batched subscribes are capped at `maxPerSocket`; every code in the table above maps to its
  status; a stalled worker whose slot renewal answers `false` aborts; `insert({ x: null })` on a
  defaulted nullable column stores `null`; `?__proto__=a&__proto__=b` leaves the prototype intact.
- New verify step: every manifest code owned by a tier ≤ 4 package has an `error-map.ts` row.

## Done when

- Every Critical/High/Medium fixed with a failing-first test; Low fixed or carrying a
  `wiki/Known-Gaps.md` row.
- The error-map completeness check is a verify step, not a convention.
- New codes registered + documented + `bun run manifest`; `bun run verify` green.
