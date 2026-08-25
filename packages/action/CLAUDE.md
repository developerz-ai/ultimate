# @ultimat3/action

Owns the `action` + `mutator` primitives and their six projections. Tier 3.

## Boundary

- May import: `core`, `schema` (t0), `cache`, `i18n`, `time` (t1), `entity`, `policy`, `http` (t2).
- Never import: `query`, `jobs`, `realtime` (sideways), or any tier 4-5 package.
- Never re-implement authz, validation or caching — call `policy`, `schema`, `cache`.

## Files

| File | Job |
|---|---|
| `action.ts` | the primitive: `action()`, `describeAction`, the registry-facing name stamp |
| `invoke.ts` | **the one execution path** + the private declaration store `handle` lives in |
| `facade.ts` | the fluent surface — binds each projection to the action, re-implements none |
| `mutator.ts` | action + optimistic `.local` twin + authoritative `.server` + `.conflict` |
| `registry.ts` | export-name registration, collisions, `describeActions()` |
| `define-api.ts` | `defineApi({ actions, mutators, queries, llm, jobs, tasks })` — the app's one boot call |
| `http.ts` | route projection (`enforcedBy: 'handler'`) + OpenAPI operation |
| `openapi.ts` | deterministic OpenAPI 3.1 document |
| `client.ts` | typed RPC client (browser-safe: no server imports) |
| `wire-issues.ts` | the ONE reader of a problem document's `issues` member — an untrusted array back into `@ultimat3/schema`'s `ValidationIssue` shape |
| `transition.ts` | `transition()`: a MUTATOR factory over one entity column's state machine. Declares no error code — entity's three propagate |
| — | opt-in flight control is **`@ultimat3/core`**'s `client-flight.ts` + `client-wire.ts`, re-exported from `src/index.ts`. There is no local copy and must not be one |
| `wire-headers.ts` | `BUILD_ID_HEADER` + `IDEMPOTENCY_HEADER`, and nothing else. Their own module so `client.ts` can name them without importing `http.ts` |
| `mcp-tool.ts` | MCP descriptor, same `invoke` |
| `job-handle.ts` | the `.job()` projection: an action as a queueable payload. **Not** consumed by `@ultimat3/jobs` — see Invariants |
| `contract-test.ts` | assertions `x g action` emits |
| `sample-input.ts` | a value `input:` accepts, from its own IR — what makes the policy assertion reach a policy |
| `idempotency.ts` | the store SEAM: types, the installed-store slot, the scope declaration + `assertIdempotencyScope`, and `withIdempotency` — the replay-or-run gate |
| `idempotency-key.ts` | the namespaced key — action + actor + the caller's key, as one JSON tuple — and the refusal of one that names no request |
| `idempotency-memory.ts` | the process default: bounded, swept, `scope: 'process'` |
| `idempotency-postgres.ts` | the SHARED store — one table, one `insert … on conflict` |
| `deprecation.ts` | `Deprecation` + the RFC 9745/8594 render + the `deprecated_calls_total` counter |
| `policy-gate.ts` | **the only** runtime edge to `@ultimat3/policy` (`errors.ts` takes `SurfaceDenial` as a type, which erases) |
| `cache-gate.ts` | the post-commit bust — **the only** file that calls `invalidateTags` |
| `audit.ts` | the audit seam: `AuditRecord`, `AuditSink`, the installed-sink store |
| `audit-memory.ts` | the process default: a bounded ring that DROPS, and counts what it dropped |
| `audit-postgres.ts` | the DURABLE sink — one append-only `x_audit` table, one insert per record |
| `audit-input.ts` | what may be written DOWN: an `input` redacted through core's table and made JSON-representable on every path |
| `audit-gate.ts` | **the only** file that calls a sink, and where the two failure policies live |
| `type-pins.ts` | compile-time assertions `tsc` checks — what the erased view projects, and why `client()` is not part of it |
| `naming.ts`, `validate.ts`, `json-schema.ts`, `stable.ts` | pure helpers. `stable.ts` is the DOCUMENT serializer plus a re-export of core's `isJsonObject` — the hash form is `@ultimat3/core`'s `canonicalJson`/`fingerprint` |

## Invariants

- **`X_INPUT_INVALID` carries the rejections TWICE, and they are one value.** The flattened line
  stays in `cause` — it is what an operator reads in a log and what a non-form caller sees — and
  `meta.issues` carries the same list structured, so a client rebuilding a form knows WHICH field
  each rejection belongs to instead of splitting a string on `'; '` and guessing. `validate.ts` is
  the one caller that passes both, and `validate.test.ts` pins `cause` to
  `formatIssues(issues).join('; ')`; the rendering deliberately does NOT happen inside
  `InputInvalidError`, because that module is reachable from browser-safe `client.ts` and
  `@ultimat3/schema` declares no `sideEffects`, so a value import of `formatIssues` there would drag
  that package's whole barrel into every bundle holding the typed client.
- **`toValidationIssues`, never a library's raw issues.** A conforming schema library's issue object
  may carry members Ultimate's shape does not — including the rejected VALUE — and this list is
  handed to an HTTP surface that returns it to the caller. Four members travel. The same rule on the
  way back in: `issuesFromWire` REBUILDS each entry member by member rather than copying it.
- **`X_OUTPUT_INVALID` keeps the line alone.** An output rejection is a server defect whose remedy
  is a code change; no client can act on a per-field list, and shipping the handler's internal
  projection to a caller is new surface for nothing.
- **An `issues` list off the wire is all-or-nothing.** A partly-parsed list would DROP the entries
  it could not read, and a caller that finds `meta.issues` uses it INSTEAD of `cause` — so a dropped
  entry is a rejection the user never hears about. `MAX_WIRE_ISSUES` bounds it, because whoever
  displays the list renders it into a DOM.
- **`transition()` is a factory, not a primitive, and it decides nothing about the machine.** It
  returns a `mutator`, so every projection is inherited rather than re-declared, and it holds no
  legality rule: `X_STATE_TRANSITION_ILLEGAL`, `X_STATE_CONFLICT` and `X_STATE_UNDECLARED` are
  `@ultimat3/entity`'s and propagate untouched. `from` is REQUIRED — it is the UPDATE's predicate,
  which is what makes the refusal free; defaulting or inferring it is the lost update coming back.
  `conflict: 'server-wins'` is fixed (the server is the half that refused), and `audit` is OFF
  unless declared (`audit: true` with no sink is `X_AUDIT_SINK_MISSING` before the input parse, so
  defaulting it on would hold the factory hostage to an unrelated decision).
- Every surface goes through `invoke`: parse input, evaluate policy, handle, parse
  output. Adding a second execution path is the one unforgivable change here.
- **An explicit `ctx` is INSTALLED, never merely passed** (`As of 2026-08`). `invoke` entered
  `runWithContext` only when `options.actor` was supplied; given `options.ctx` alone it called
  `core(target, raw, options.ctx, options)` directly. So `guard()` decided about that actor while
  everything reading the AMBIENT context — above all `@ultimat3/entity`'s tenant guard, which
  derives from `tryUseContext()` and not from the ctx it is handed — saw a different identity, or
  none: `writeAnywhere.job().invoke(input, ctxAsOrgA)` wrote a row naming org B while the identical
  call under an ambient context was `X_TENANCY_ACTOR_MISMATCH`. Absent a `ctx` this reinstalls the
  ambient one, a no-op on every path that already worked. The twin fix is `@ultimat3/query`'s
  `asActor`, and `invoke-context.test.ts` asserts an EQUALITY between the three spellings of one
  caller — ambient, `options.actor`, `options.ctx` — because three independent expectations are
  exactly what let this ship.
- The declaration never leaves `invoke.ts`. `defOf`/`stashDef` are internal and must
  never be re-exported from `src/index.ts` — that absence is the enforcement, and
  `index.test.ts` is what makes it one.
- **`toRoute` sets `enforcedBy: 'handler'`, so the HTTP pipeline's authz stage stands down.**
  `invoke` is the route's single evaluation and the only one holding the row `def.row` loaded;
  a stage deciding first would decide the same policy from `row: null`, deny the row's own
  author, and never reach the evaluation that had the row. `meta.policy` stays set — dropping
  it would read as "this action is unguarded" in `x routes` and the manifest. `http.test.ts`
  drives a row-level action over the real pipeline and counts the evaluations: exactly one.
- **`meta.auth` is derived from a WALK of the policy tree**, never from the root combinator.
  `def.policy.kind === 'allow'` answered `'required'` for `or(allow(), can('x:y'))`, so the
  pipeline's `auth` stage 401'd an anonymous caller the policy itself ALLOWS — while the MCP tool
  and the job handle let that caller through the same object. One policy, a different answer per
  surface, which is the thing `enforcedBy: 'handler'` exists to prevent. `'public'` here is not
  "unguarded": `invoke` still evaluates the policy for every call.
  **`admitsAnonymous` is `@ultimat3/policy`'s** (`policy.ts`, beside `policyPermissions`) and
  reaches this package through `policy-gate.ts` like every other authz question — never a copy
  here. It cannot be one: `@ultimat3/query` needs the identical answer and is the same tier, so a
  copy in either is a second answer for the other, and the walk is a property of the combinators
  `policy.ts` declares. It is EXACT rather than heuristic — with `actor === null`, `can()`
  short-circuits before its predicate and `allow()`/`deny()` ignore their arguments, so the tree
  alone decides. `packages/policy/src/policy.test.ts` asserts it against
  `policy.run({ actor: null })` itself, case for case; `http.test.ts` proves this projection reads
  the answer, over the real pipeline.
- **`stable.ts` holds the DOCUMENT form and NOTHING else, `As of 2026-08`.** `stableStringify` is
  published as `openapi.json` by `serializeOpenApi` and re-read with `JSON.parse` by
  `json-schema.ts`, so a non-finite number has to be `null` and a `Date` has to be its ISO string —
  the bare token `NaN` would make a published spec unparseable. The HASH form left this file:
  `canonicalJson` + `fingerprint` are **`@ultimat3/core`'s**, because `@ultimat3/query` and
  `@ultimat3/realtime` each held their own copy of the identical function and all three are tier 3,
  so no two of them could import each other and a copy in any was a second answer for the other
  two. They had already diverged — query's had no `Date` branch, so every date window of a read
  shared one cache key. Nothing about this package's keys moved: `fingerprint` is the same code at
  the same width, `stable.test.ts` still pins the document duty (a `JSON.parse` of what it emits)
  and now pins the byte-equality against core's form for an ordinary payload, which is what says no
  idempotency record and no enqueued job moved.
  **Why the hash form must be a separate function at all** — the reason that survives the move.
  `NaN`, `±Infinity` and JSON `null` all encoded as `'null'` and `String(-0)` is `"0"`, so four
  distinct inputs shared one `requestHash` (one caller handed another's stored response on replay)
  and one job dedupe key. And three more values folded onto `{}`, the first of which `t.date`
  produces on every parse: a `Date`, a `Map` and a `Set` have no own enumerable key, so
  `Object.keys` was empty and the object branch rendered all three `{}` —
  `fingerprint({ x: new Map([['a', 1]]) })` equalled `fingerprint({ x: new Set([1, 2]) })` equalled
  `fingerprint({ x: {} })`, and an `idempotent: true` action taking `t.object({ at: t.date })`,
  called twice under one key with two DIFFERENT dates, handed the second caller the first one's
  stored response with no `X_IDEMPOTENCY_CONFLICT` and the handler run once. The two forms disagree
  about all four exactly as they disagree about numbers: the document form is `JSON.stringify`'s own
  rendering, and the hash form TAGS them — `Date(<epoch>)`, `Map(k:v,...)`, `Set(v,...)`. The tag is
  not decoration: an untagged epoch is the same token a `t.number` field holding that epoch emits.
  Map and Set entries are SORTED, as object keys are.
- **`tagKeys` is `@ultimat3/cache`'s, not this package's — moved 2026-08.** `packages/action/src/tags.ts`
  and `packages/query/src/tags.ts` were byte-identical, and both packages are tier 3, so neither can
  import the other and a copy in either is a second answer for the other. `tagKey` went with it: it
  was `serializeTag` under a second name with zero call sites. Same shape as `toBucket`. Never
  restore a local one, and never reach for `@ultimat3/render`'s same-named `tagKeys` — that one
  preserves declaration order and is a different function.
- **`toBucket` is `@ultimat3/http`'s, not this package's — moved 2026-08.** http owns `Bucket` and
  the limiter maths, and `@ultimat3/query` needs the identical conversion while being the same
  tier as this package, so a copy in either is a second answer to "what does this limit mean" for
  the other. It is re-exported from `src/index.ts` so an action file still reaches it through one
  import, and it raises http's `X_RATE_LIMIT_INVALID`; `X_ACTION_RATE_LIMIT_INVALID` is gone with
  the copy. Never restore a local one.
- **`rateLimit:` reaches the limiter, not only the spec.** `toRoute` sets `meta.rateLimit` (the
  bucket name) **and** `meta.rateLimitBucket` (`toBucket(name, def.rateLimit)`), and
  `@ultimat3/http`'s `withRouteBuckets` registers the second under the first. Until 2026-08 only
  the name was set, so `bucketFor` fell through to `default` — 120 burst / 2 per second for an
  action that declared 5, with the declared numbers published in `x-ultimate.rateLimit` all the
  same: looser in practice than what the author wrote, which is the dangerous direction. `toBucket`
  is the **only** conversion between `{ limit, windowMs }` and `{ capacity, refillPerSecond }`, and
  both projections that read the declaration call it, so the spec cannot publish a pair the limiter
  refuses. http's `X_RATE_LIMIT_INVALID` covers all three checks, and the third is the one that is
  easy to miss: the **computed** rate, not just the two declared halves. `windowMs: 0` is an
  infinite refill, and so is `{ limit: Number.MAX_VALUE, windowMs: 1 }` — two finite positive
  numbers whose division enforces nothing. `limit` must also be at least one whole token, or the
  first caller is already refused and the endpoint is closed rather than limited.
- **Everything `withIdempotency`'s `run` throws is treated as possibly-committed.** `guard()` and
  `validateInput` both run before the gate (`invoke.ts`), so by the time `run` is called the only
  things left are the handler and `validateOutput` — and the second throws *after* the first has
  committed. The reservation is therefore SETTLED as a failure and the retry replays it under the
  first attempt's own code; `release()` is reserved for a pre-handler failure, of which this gate
  has none. Releasing there is what turned a rounding change in an `output:` schema into a second
  charge: `X_OUTPUT_INVALID` dropped the record and the client's automatic retry re-ran a handler
  that had already taken the money. A `settle` that itself refuses leaves the record **in flight**
  for the same reason — a 409 the caller can act on beats a silent re-run. A store with no `fail`
  slot gets the same fail-closed treatment. `idempotency-failure.test.ts` drives the
  post-commit-throw path first, because that is the one that shipped.
- **An idempotency record belongs to ONE CALLER, and a key that names no request is refused**
  (`As of 2026-08`). The namespace was the action name alone, so `idempotencyKeyFor` filed every
  caller's `k1` under one record: alice POSTed `charge`, bob POSTed `charge` with the same header
  and was handed alice's stored response — and with a *differing* payload bob got
  `X_IDEMPOTENCY_CONFLICT` instead, so any key he guessed was a key he could deny her. The key is
  now `JSON.stringify([action, actor.kind, actor.id, actor.orgId ?? null, key])`, and the encoding
  is a **JSON tuple, never a joined string**, for `readAuthority`'s reason: an actor id is app data,
  so under `a:b:c` an id of `alice:x` with key `y` is the same record as `alice` with key `x:y`.
  Separately, `req.header()` is `Headers.get()`, which answers `''` for `Idempotency-Key:` and
  never `null` — so a blank header was itself a shared key. It is `X_IDEMPOTENCY_KEY_INVALID`, a
  4xx raised before the handler, and **not** read as "no key": the quiet reading loses the retry
  protection exactly when a client's key interpolation broke, and the double charge lands on the
  client's own automatic retry. `@ultimat3/jobs` refuses an empty key at the enqueue for the same
  reason and uses `assert` because *its* empty key is the app's declaration, not a caller's header.
  What this does NOT close: an anonymous actor is one identity, so anonymous callers of a public
  idempotent action still share a key space — nothing at this tier can tell two apart, and keying
  on an IP or a cookie would break the retry the header exists to serve.
- **Both stores FENCE a settlement on the reservation `id` AND on `in-flight`**, as
  `@ultimat3/jobs`' `SQL_ACK` fences on `id = $1 and state = 'running'`. A reservation whose window
  lapsed is reclaimed by the next caller (`on conflict … do update`), so a straggler from the first
  one used to overwrite a record it no longer owned and the next replay answered a retry with a
  value produced for a different request. Postgres fences in SQL and returns `key`, so the no-op is
  observable and logged; memory checks the id and status it holds. It is logged and never thrown —
  a settlement is post-commit, so raising there would turn a durable write into the caller's error.
  **The status alone was not enough**, which is why `settle(key, value, reservationId)` and
  `fail(key, failure, reservationId)` carry the id: a reclaimed record is `in-flight` AGAIN, so a
  straggler satisfied a status-only fence exactly and overwrote a LIVE reservation — and the
  replacement's own settle was then fenced out. Public API, changed in the 8.0.0 major; callers
  pass `reservation.record.id`, which `withIdempotency` already holds.
- **A stored status is NARROWED, never cast.** `isIdempotencyStatus` decides, and an unknown word
  is `X_IDEMPOTENCY_STATUS_UNKNOWN` at `toRecord`. `row.status as IdempotencyStatus` let one
  through and `withIdempotency` has no branch for it: the record fell past `in-flight` and
  `failed` and answered `{ value: null, replayed: true }` — "this already ran, here is its result"
  — for a row nobody could read. The record was written by whatever build was deployed when the
  first attempt ran, which on a rolling deploy is not this one. Same rule, same column shape, as
  `@ultimat3/jobs`' `statusIn`.
- **Where the idempotency records live is DECLARED, and refused at registration.**
  `IdempotencyStore.scope` says what a driver provides; `configureIdempotency({ scope })` says what
  the deployment requires; `assertIdempotencyScope` compares them inside `registerAction` — the
  funnel every registration path shares, and one that necessarily runs before a route is mounted.
  `'shared'` over a per-process store, or over a store declaring **no** scope, is
  `X_IDEMPOTENCY_NOT_SHARED` before the socket opens. The exact shape of `assertRateLimitScope`
  and `assertRouteBuckets`, and for the same reason: what cannot be shown to hold is not assumed
  to hold. The default is `'process'`, because one process is the only thing a framework can
  promise without being told — nothing here reads an environment to guess a replica count.
- **The memory store is bounded, and the eviction order is part of the guarantee.** A key is
  caller-supplied, so its cardinality is the write rate: unbounded, 500 idempotent writes a second
  is 43M immortal entries a day. Expired records go for free (past the window a record answers as
  a missing one); past the cap, **`in-flight` records are the last to go** — one of those is the
  reservation that stops a concurrent duplicate from running the handler twice. That is the mirror
  of `memoryRateLimitStore` evicting the fullest bucket first; never swap either for an LRU.
- **`postgresIdempotencyStore` is the shipped shared store, and it must be CALLED.** A mechanism
  built and never wired is the defect this package has shipped twice. It takes a structural
  `PgExecutor` — the same shape `@ultimat3/jobs`' pg driver declares, satisfied by `Bun.sql` and by
  a Tx — so there is no `action -> db` package edge and the app wires it:
  `setIdempotencyStore(postgresIdempotencyStore({ executor: Bun.sql }))` then
  `configureIdempotency({ scope: 'shared' })`, at boot, before `registerActions()`.
  `SQL_IDEMPOTENCY_TABLE` is applied the way `SQL_JOBS_TABLE` is. The reservation is ONE statement:
  a returned row always means this caller owns it, because the `do update` fires only for a row
  already outside the window.
- **`deprecated:` is a compat WINDOW and versioning is deliberately not here.** One declaration,
  four projections: `Deprecation`/`Sunset` headers on every response *including the failures* the
  handler raises, a `rel="successor-version"` link derived through `derivePath` (never a second URL
  derivation), `deprecated: true` in the OpenAPI operation, and `deprecated_calls_total`. The
  headers are rendered ONCE at projection, so a date that cannot become one is
  `X_ACTION_DEPRECATION_INVALID` at mount rather than on the first request — the rule `toBucket`
  follows. Running two versions side by side is two deployments behind one ingress (axiom 7); a
  path prefix, a second registry or a version router would all be a ninth thing to maintain.
  `deprecation.ts` is TWINNED in `@ultimat3/query`, because both are tier 3 and the shared home is
  `@ultimat3/http` if it ever grows one — the same compromise `naming.ts` is ported under.
- **The span wraps `execute` whole, and carries attributes.** It used to wrap `def.handle` alone
  and set nothing, so `def.row()` — the loader a row-level policy needs — ran inside no span at
  all: a 2s p99 reported 40ms and the missing 1.96s read as framework overhead. Attributes are
  chosen for bounded cardinality (surface, actor KIND, outcome, booleans) with one exception, the
  namespaced idempotency key, which is the single fact that joins a retry to the call it retries —
  and is never a metric label. `telemetry.test.ts` asserts the EXTENT structurally, by reading
  `currentSpan()` from inside `row:` and the policy predicate, not by timing: the test clock is
  frozen.
- **`policyCapability` is a display label and `policyPermissions` is what a report matches on.**
  A composite renders as `and(post:publish, org:administer)`, which equals no permission string,
  so `x policy list` matching on `capability` reported every non-trivially-guarded action's
  permissions as *unenforced* — real grants shown as dead. `ActionDescriptor.permissions` is the
  flattened list from `@ultimat3/policy`'s `policyPermissions`, published beside `capability` and
  never instead of it. A `not()` clause contributes its inner permissions: the grant still
  participates in the decision, so omitting it would be the false statement.
- **Both clients inject `traceparent`.** `@ultimat3/core`'s `traceparent()` existed with no caller
  in the repo, so every Ultimate-to-Ultimate hop began a fresh root trace on the far side. It is
  set BEFORE the caller's own headers so an explicit one still wins, and an incomplete span context
  (`spanId: ''`, which `currentSpanContext()` answers when a request context exists but no span
  does) sends nothing rather than `00-<trace>--01`. In a browser there is no ambient context, so
  a cross-origin call acquires no CORS preflight it did not already have.
- **`ActionJobHandle` is not consumed by `@ultimat3/jobs`, and the file said it was until
  2026-08.** The header read "`@ultimat3/jobs` consumes this shape, so enqueueing an existing
  action costs zero rewriting" — a claim no code supports. `'action-job'` occurs in four places,
  all inside this package (`job-handle.ts:16,30`, `job-handle.test.ts`, `facade.test.ts`), and
  `isJobHandle` (`packages/jobs/src/job.ts:256`) requires `kind === 'job'` **and** membership of a
  module-private `WeakMap` written only inside `job()` — so this is impossible in principle, not
  merely unwired. `JobHandle` shares two members with it. What the shape actually gives: `.job()`
  on the façade, `action:<name>` as a durable queue key, a payload-derived idempotency key, and an
  `invoke` that runs the one execution path under `surface: 'job'` — so an app that owns a queue
  can drive it by hand and still get the action's parse + policy. **The missing halves are
  `tenant` and `retry`**, both required on `JobDefinition` with deliberately no default, so "zero
  rewriting" was never reachable regardless of wiring. The bridge is one `job({ … })` call, and it
  belongs in the app or at tier 4+: `action` and `jobs` are both tier 3. **It exists, `As of
  2026-08`** — `agentJob()` in `@ultimat3/ai` (`agent-job.ts`), tier 4, which takes an `Action` and
  nothing agent-specific and supplies the two missing halves as its own options. So "nothing in the
  framework consumes it", which `job-handle.ts`'s header said until this was checked, is false: it
  has one consumer, and an app writes the same three lines.
- An action has no `.def`. Inside the package read it with `defOf(target)`; outside,
  read the lifted `.input`/`.output`/`.policy`/`.mcp` or `describe()`.
- **`AnyAction` projects every surface, `client()` excepted.** The registry answers in the erased
  view — `listActions()`, `getAction(name)` — so a member missing from it is a projection the
  registry cannot reach: `.job()` was absent until 2026-08 and `getAction('publishPost')?.job()`
  was a type error against an object that has had the method since `facadeFor` bound it. `job()`
  erases because `ActionJobHandle`'s members are method-syntax (bivariant parameters) and its
  output erases to `unknown`; `ClientMethod` is a **function type**, so its input is
  contravariant and `(input: unknown) => …` is a supertype of no concrete action's method. Both
  halves are build errors in `type-pins.ts`, never a comment — and type claims go there, never in
  a `.test.ts`, because `tsconfig.json` excludes tests and `tsc` never reads one.
- **The client keeps the server's error code and marks it remote.** A `problem+json` failure
  becomes `RemoteActionError` (`errors.ts`), which re-uses the code off the wire the way
  `ActionDeniedError` re-uses the policy decision's — and then says so, because the browser
  bundle never registered it: `name` marks it in a stack, `meta.origin: 'remote'` marks it in
  `--json`, the overlay and the error reporter. **It never synthesizes a docs URL.**
  a `…/errors/X_SIGNUP_CLOSED` invented for an app-declared code is a 404 dressed as
  documentation; the link is the server's own `docs`/`type` when it sent an `http(s)` one, this
  build's registered link when `hasErrorCode` knows the code, otherwise `ERROR_DOCS_URL`. Those
  last two agree by construction now that core resolves every code to one URL — `hasErrorCode`
  still separates them only for a package that declared its own `docs:`, which is why the branch
  stays. The
  code must be `X_SCREAMING_SNAKE` to be taken at all — `typeof code === 'string'` accepted `""`
  from a gateway — and anything else is `RpcFailedError`, which is what that code means.
  `docs` and `type` travel to `remoteDocs` as an ordered pair, not `docs ?? type`: preference is
  not selection, and picking the preferred slot on presence alone let one `javascript:` string
  bury a perfectly good `type` the same response had already offered.
- **MCP exposure is read through `isMcpExposed` from `@ultimat3/core`, in all three places.**
  `toMcpTools` builds the tool, `describeAction` publishes the manifest fact and
  `toOpenApiOperation` publishes `x-ultimate.mcpTool` — the last two fail-opened (`?? true`,
  `!== false`) until 2026-08, so an action with no `mcp` block was advertised as a tool by both
  contract artifacts and refused by the only surface that could serve one. A contract that
  disagrees with the runtime is worse than no contract; never spell the check inline again.
- **An MCP tool's NAME is the export name verbatim, in all four places — `toToolName` is gone**
  (`As of 2026-08`). The same three readers that fail-opened on exposure also *derived* the name:
  `toToolName` snake_cased it for `toMcpTool`, for `x-ultimate.mcpTool` and for
  `describeAction().mcp.tool`, while `@ultimat3/mcp` has only ever served
  `primitive.mcp?.name ?? primitive.name`. So nine of the ten tool names
  `examples/dummy/openapi.json` published — `publish_post`, `create_post`, … — were names
  `tools/call` answers not-found for; the tenth, `summarize`, is single-word and so was already
  its own snake_case form, which is why a count of the wrong names is not a count of the rows. The
  DESCRIPTOR said the same: `x actions describe --json`, `x actions list --json`, the
  `actions.describe` dev MCP tool and the `/_x` Routes panel all read `.mcp.tool`. **Not the app
  manifest** — `ActionFact.mcp` is `{ expose, description? }` and `packages/manifest/src/sources.ts`
  copies only those two, so `x.manifest.json` has never carried a tool name and `grep '"tool"'` on
  either committed manifest finds none. Do not describe this defect as a manifest defect; the
  manifest's stake in the `mcp` block is `expose`, which is the invariant above. `ActionMcp`
  carries no `name:`, so
  the verbatim name is the whole rule and there is nothing left to derive; the helper is
  **deleted** rather than left exported, because a dead name-deriver is a second way to name a
  tool. `mcp-tool.test.ts`'s "one name per action, on every surface" asserts the three strings are
  one string AND that it is the verbatim name — the equality alone passes on the old behaviour,
  where all three agreed on the wrong name. **Neither package derives a tool name any more**:
  `@ultimat3/query` carried a same-named twin with the identical defect and deleted it in the same
  change, so `packages/query/src/naming.ts` derives PATHS only and its `src/index.ts` exports no
  such helper. Both are tier 3, so neither could import the other and each owned its own removal —
  which is why the rule is restated in both `CLAUDE.md`s rather than shared.
- **The post-commit bust never fails the write it followed.** `cache.invalidates` fans out once the
  handler has committed, so `bustAfterCommit` — `cache-gate.ts`, the only caller of
  `invalidateTags` here — absorbs a fan-out that refuses and answers `undefined`: an undeclared tag
  (`X_CACHE_TAG_UNKNOWN`) must not turn a durable write into a failed action, and those entries
  expire by TTL. One dead tier is not that case; `invalidateTags` already reports it in
  `report.errors`. It logs through core's `logger`, never `ctx.logger` — an HTTP `Ctx` is a cast
  request context that carries none — and never renders the tags, because reading a malformed
  `invalidates` entry back is the second throw the guard exists to stop. **A replay skips the bust
  entirely:** no handler ran, the first call already busted these tags, and re-purging the CDN and
  re-queueing ISR per retry is work for a write nobody made.
- **The policy contract test asserts `ActionDeniedError`, and it sends valid input to get there.**
  It sent `{}` and accepted any `UltimateError` until 2026-08, so every action with a required
  field failed `input:` before `guard()` ran and the assertion passed on `X_INPUT_INVALID` —
  including one whose policy was `allow()`. `sampleInput` builds the payload from `input:`'s own
  IR (required keys only) so the invocation reaches the policy; the class, not `X_FORBIDDEN`, is
  the assertion, because `ActionDeniedError` re-uses the policy decision's code and `can()`
  answers a null actor with `X_UNAUTHENTICATED`. **Only `X_INPUT_INVALID` becomes
  `X_CONTRACT_DRIFT`** — it is the one code `invoke` raises before `guard()` is reached, and
  `input:` is the one knob that answers it. Everything else keeps its own code and its own fix:
  saying `X_OUTPUT_INVALID … before its policy decided` named a stage nothing had checked and
  offered a fix that changes nothing, and it hid the `allow()` whose handler threw — the authz
  escape this assertion exists to catch. A non-`UltimateError` (a `row:` loader's own
  `TypeError`) is rethrown untouched too: its stack is the thing worth reading.
  `contract-test.contract.test.ts` drives all three assertions against actions built to fail them.
  **`X_AUDIT_SINK_MISSING` is the one code assertion 1 passes through as well**, for the same
  reason: `auditSinkFor` runs *before* `validateInput`, so "the schema accepted garbage" is a
  false statement about it and `tighten input:` is a fix that changes nothing. It is the only
  refusal that precedes the parse — a second one is a design mistake, not a second entry here.
- **The audit seam ships the mechanism and none of the row.** `audit: true` on a declaration
  wraps `execute` — it never forks it — so a **denied** attempt is recorded, which is the whole
  reason this lives in the framework: `guard` throws before `handle`, so nothing an app writes
  around its own handler could ever see one. What reaches the sink is what `invoke` already holds
  (`at` from `ctx.now()`, the name, the mutator brand, the surface, the whole `ctx`, the parsed
  input, the namespaced idempotency key, `replayed`, the outcome, the failure code). What does
  **not** ship, ever: an audit entity, a retention policy, a hash chain, a subject index, or an
  opinion on what "who" means under impersonation — four apps model those four ways, so by axiom
  8's own test they are business convention and shipping one makes three of them wrong.
  **"a storage backend" was on that list until 2026-08-24 and is off it**, because the list was
  answering a different question than it appeared to. What four apps model four ways is the ROW —
  which of their own facts it carries, how long they keep it, whether it chains. Where the record
  the FRAMEWORK already defines is put is not one of those: `x_audit`'s columns are the fields of
  `AuditRecord` and nothing else, which is the same relationship `idempotency-postgres.ts` has to
  `IdempotencyRecord` and `@ultimat3/http`'s `postgresRateLimitStore` to its `Bucket`. Leaving it
  off meant the only sink that shipped was a ring that drops, so the shortest edit clearing
  `X_AUDIT_SINK_MISSING` was `setAuditSink(memoryAuditSink())` — compliant in dev, silently
  amnesiac in production, which `docs/idea/20-large-app-readiness.md` scores as **Ship**. An app
  that wants columns of its own still writes its own sink; the seam is one method. `result` is absent for the same reason and one more: a handler's return is
  reachable from the handler itself, so shipping it would be this package deciding a row carries
  an after-image, which is `@ultimat3/admin`'s `diff` convention arriving one tier down.
- **The audit vocabulary is `@ultimat3/admin`'s, shared by name and not by import.** `AuditOutcome`
  is the same three words (`allowed | denied | failed`) and `AuditSink` the same noun; `admin` is
  tier 5 and this is tier 3, so there is no edge to share them over. **Known duplicate**: admin's
  `AuditSink` writes a fixed `AuditEntry` requiring an `AdminActor` and a `permission`, and it is
  called only from `admin/crud.ts`, so an action outside `/admin` still produces nothing there.
  Unifying them means lifting the vocabulary into `@ultimat3/core` — the only tier both reach —
  and rebuilding `admin/audit.ts` on this seam. Not done here: `admin` is a shipped public API
  and its `AuditEntry` is a different shape.
- **The memory sink DROPS, and both halves of that sentence are enforced.** It was a plain array
  with a `push` — the one memory implementation in the framework with no cap, beside five that
  have one (`memoryRateLimitStore`, `MemoryIdempotencyStore`, `createLimiter`,
  `createTotpReplayGuard`, `createMemoryEventBus`) — and a record pins a whole `Ctx`, so at 50
  audited writes a second it is 4.3M immortal records a day and the pod OOMs holding the trail it
  was retaining. It is now a ring at `DEFAULT_MAX_AUDIT_RECORDS`, evicting the OLDEST (the
  direction `createMemoryEventBus` evicts in: refusing new writes would answer "nothing has
  happened since" for a process that has been serving all day). `dropped` is what makes "it drops"
  checkable in a running process instead of a sentence in a header — a non-zero count on a real
  deployment is the sink saying it is the wrong one. A `maxRecords` of `0`, negative or `NaN`
  falls back to the default: there is no spelling of "no bound", because that spelling was the bug.
- **What a DURABLE sink may write down is decided in `audit-input.ts`, and it is two rules.**
  A record's `input` is the PARSED input, which is exactly where a password, a bearer token or a
  card number lives, so `postgresAuditSink` redacts it through `@ultimat3/core`'s `isRedactedKey`
  — the SAME table `defineEnv({ secret: true })` extends, never a copy of the list, because a copy
  is how a value that is `[redacted]` in a log line becomes plaintext in a table. `isSecret`
  redacts by VALUE beside it, for a credential travelling under a harmless name. The second rule
  is that the answer is always JSON-representable: a `bigint`, a `NaN`, a function and a cycle all
  become a NAMED marker rather than a throw, because `auditSettled` turns a sink throw into a
  failed invocation for a handler that has already committed — and because `JSON.stringify` over a
  cycle takes ~4.6s in Bun 1.4 before it raises, so leaving the detection to the serializer stalls
  the audited path either way. `toJSON` is never called: it is app code in the frame that owes the
  caller a record.
- **The `Ctx` is never walked, and never will be.** `createContext` spreads every installed
  service ONTO the context object and an HTTP surface's value is a `RequestContext` carrying the
  request's own `Authorization` and `Cookie`, so a projection that iterated it would write an
  app's database clients and its caller's credentials into an audit table. `postgresAuditSink`
  reads an allow-list of framework-owned fields (`requestId`, `traceId`, `locale`, `tz`,
  `buildId`, `role`, and the actor's `id`/`kind`/`orgId`/`onBehalfOf`) and nothing else.
  `failure.error` is not among them — the row keeps `failure.code`, because a throwable's stack is
  worth reading and is not worth storing, and rendering one into a column is the trap
  `renderThrowable` exists for.
- **`x_audit` ships no purge, and it is the only framework table that does not.**
  `x_idempotency` and `x_rate_limit` both ship one because a stale row there is meaningless; a
  stale audit row IS the record, and "how long" is a legal answer that is seven years for one app
  and thirty days for the next. Shipping a `delete` would be shipping one of those answers.
- **`SQL_AUDIT_INSERT` is positional, so its parameter order is pinned by a test and not by a
  type.** `audit-parity.test.ts` names every column once and compares both sinks' answer for every
  string field with a DIFFERENT value per field — two columns holding the same word cannot catch a
  slip, and a `locale` in the `tz` slot type-checks perfectly. Proven by mutation: the first draft
  of that test did NOT catch a swapped `locale`/`tz` and was widened until it did.
- **A sink may not silently swallow, and the two failure policies are deliberate opposites.**
  `X_AUDIT_SINK_MISSING` is raised *before* the input parse, so an audited action nothing can
  record refuses with no committed write behind it — there is deliberately no logger-backed
  default sink, because a line nobody stores satisfies the declaration while recording nothing.
  A sink that refuses an **allowed** record fails the invocation (`X_AUDIT_SINK_FAILED`), which
  is the inverse of `cache-gate.ts`'s absorb-and-log: a dropped cache entry expires by TTL and
  the stack heals itself, while nothing ever re-derives an audit row that was never written. It
  is post-commit all the same, so the cause says the handler already committed rather than
  implying a rollback. **Its `fix:` branches on `record.idempotencyKey !== null` — the
  INVOCATION's fact, never the declaration's `idempotent`.** A retry replays instead of re-running
  only when this call reserved a record, and `invoke` reads
  `def.idempotent === true ? (options.idempotencyKey ?? null) : null`, so a non-idempotent action
  and an idempotent one whose caller sent no header collapse to the same `null`. The unqualified
  "retry with the same Idempotency-Key" told a caller to apply a committed write twice — an
  axiom-4 violation dressed as a fix line. Requiring `idempotent: true` at declaration was the
  other candidate and was rejected: it would not have made the message true (the header is still
  the caller's), and it would force the idempotency store on every app that wants only an audit
  trail — "which writes must be retry-safe" is the app's call, not this package's.
  `meta.replayable` carries the same fact to `--json`, and `audit.test.ts` pins both branches so
  the text cannot drift back. A sink that refuses a **denied or failed** record is logged as
  `audit.sink.failed` and the original error still reaches the caller — `X_AUDIT_SINK_FAILED`
  there would hide the `X_FORBIDDEN` and would answer a probing client differently depending on
  whether the audit backend was up, which is an oracle.
- **`auditSettled` sits outside the `catch`, not inside it.** Inside, its own
  `X_AUDIT_SINK_FAILED` fell into the failure branch and wrote a *second* record saying the
  action `failed` — for a handler that had committed. An audit trail lying about a write is
  worse than no audit trail; `audit.test.ts` counts the records a refusing sink was offered.
- **`auditOutcomeFor` is TOTAL, because both callers ask inside a `catch`.**
  `error instanceof ActionDeniedError` runs a `Proxy`'s `getPrototypeOf` trap, and the two call
  sites are `execute`'s span attribute and the one place the `failed` record is produced — so a
  handler throwing such a value made the probe throw *from the frame holding the app's error*,
  and the caller got a `TypeError` in place of its own throwable. It fails closed to `failed`: a
  value that refuses to be examined is not evidence of a policy denial. Same rule as core's
  `isThrownError` / `isUltimateError`, and the same defect `@ultimat3/http`'s `finalize.ts` and
  `factsOf` carried; `audit.test.ts` asserts the caller's throwable by IDENTITY, which is the only
  assertion that catches a replacement.
- **`json-schema.ts`'s refusal names `introspect()`, never a `toJsonSchema` member.**
  `SchemaProvider` declares no such member and `toJsonSchema()` calls `introspect()`
  unconditionally, so the old `fix:` told a reader to implement an API that does not exist —
  axiom 4 inverted, and invisible to `x verify`'s `errors` step, which checks a fix line's shape
  and never whether the API it names is real. The guard is `normalizeJsonSchema`, exported from
  the module for its own test and absent from `src/index.ts` exactly as `sortSchema` is; the
  shipped `toJsonSchema` cannot reach it today (it returns an object literal on every path), so
  the test drives the guard directly rather than pretending a converter can be swapped.
- **A lookup table is read with `Object.hasOwn`, never with the index alone.** `IRREGULAR[word]`
  in `naming.ts` and `BY_FORMAT[node.format]` in `sample-input.ts` both read the prototype chain:
  `splitWords` lowercases, which keeps `toString` and `hasOwnProperty` out of reach, but
  `constructor` is already lowercase and survived — so `pluralize('constructor')` answered the
  `Object` FUNCTION where its return type says `string`, `derivePath('addConstructor')` mounted the
  action at `/api/function Object() { [native code] }/add` and published that as its OpenAPI path
  and `tags`, and a provider emitting `format: 'constructor'` put a function in the payload the
  policy contract test invokes with. Both keys are caller- or provider-supplied, which is the whole
  test for whether this applies. Same discriminator `packages/flags/src/subject.ts:75` uses.
- App code reaches a projection through the action (`publishPost.tool()`), never through
  `.def` and never by importing the projection function. `facade.ts` is where a new method
  is bound; the projection itself keeps living in its own file.
- A mutator projects the three names it was authored with — `.local`, `.server`, `.conflict` —
  plus every action façade member, through `named()` and registration alike. No aliases: the
  old `.applyLocal` is gone, not deprecated.
- `mutator.server()` calls the action's own callable, so it lands in `invoke` like every other
  surface. Reaching the declared `server` from there is the second execution path this package
  exists to prevent. `.local()` is the one member that skips the core — it never leaves the
  client, so there is nothing to authorize.
- Registration names the action the app exported, in place — `import { publishPost }` is
  projectable after boot. Naming an already-named action is the only case that twins.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so an action file imports
  one package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on every
  access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.
- `defineApi` is the app's registration call; `registerActions` is what it composes. It reaches
  `@ultimat3/query`'s and `@ultimat3/jobs`' registries through core's registrar table
  (`primitiveRegistrar('query' | 'job' | 'task')`), never a sideways import — and throws
  `X_REGISTRAR_MISSING` rather than skipping a kind whose registrar is absent, because a silent
  skip drops every primitive of that kind.
- **`jobs` and `tasks` belong in the same call, for the same reason `queries` do.** The export
  name becomes the job's durable queue key; a job module nothing hands over keeps `job()`'s
  positional `anonymous-job-<n>`, on every queue row and in the manifest. A definition with its
  own `name:` keeps it — that rule lives in `@ultimat3/jobs`, not here. Jobs register before
  tasks: a task descriptor lists the jobs it enqueues by name.
- `defineApi`'s returned maps are built from the **registrar's own results**, never from the
  modules' exports. A feature module exports helpers next to its primitives; copying every export
  would seat one in `Api['actions']` as a client method nothing serves, and let two modules'
  same-named helpers overwrite each other with no `X_ACTION_DUPLICATE` to raise. The type does the
  same filter, so `rpc<Api['actions']>()` offers only what registered.
- `rpc` is the only name for the map-wide typed client. There is no `createClient` alias.
- **Flight control is `@ultimat3/core`'s, and this package RE-EXPORTS it.** `client-flight.ts` and
  `client-wire.ts` shipped here and in the other tier-3 client package as byte-identical copies —
  288 and 85 lines — kept in step by a `client-twin.test.ts` in each. A test that makes drift LOUD
  is not the same as a file that cannot drift, and this package's own thesis is that duplication is
  the defect. Both files import nothing but tier 0, which was always the argument for where they
  belong; the one blocker was `isJsonObject`, now `@ultimat3/core`'s `json-object.ts`, re-exported
  from `./stable` here. `createClientFlight`, `DEFAULT_CLIENT_RETRY`, `isTransientFailure`,
  `isSuperseded`, `ClientFlight`, `ClientFlightOptions`, `ClientRetry`, `FlightKeyOptions`,
  `FlightPlan` and `WireAnswer` are all still importable from `@ultimat3/action` — the same names,
  and now literally the same objects the other package exports. Never re-declare one here; the
  fix for anything wrong with the pipeline is an edit in `packages/core/src/client-flight.ts`.
- **Every mechanism underneath the flight is `@ultimat3/core`'s, the pipeline included.**
  `createSingleFlight` for dedup, `createFence`/`isSuperseded` for supersession, `createFlightGate`
  for the ceiling, `retry` + `backoffDelay` for the schedule, `isRetryableStatus` for the status
  table, `X_TIMEOUT` for the deadline — and `createClientFlight`, which composes them. This package
  declares NO new error code for any of it; never add a second curve, a second fence or a private
  retry loop here, and `bun run flight-copies` is what says so.
- **`isTransientFailure` INVERTS `retryDecision`'s unclassified default, and the inversion must
  survive** (`As of 2026-08-23`). `retryDecision` sends a throw nobody classified again until the
  attempts run out; `@ultimat3/ai` and `@ultimat3/db` each refused the executor outright over it.
  The client keeps the executor and supplies a predicate instead: a declared
  `retryable`/`retry-after`, plus a dispatch that produced no response at all (`fetch` rejecting
  with a plain `TypeError`), and nothing else — a caller's own `AbortError` and a foreign value are
  terminal. The loop is stopped by RESOLVING to a private sentinel rather than by throwing, so the
  original value still reaches the caller unwrapped, which is the property `retry`'s own header
  promises. It lives in `packages/core/src/client-flight.ts` now; the tests that pin it from this
  side still drive it through this package's own client.
- **`ClientFlight` is a TYPE inside `client.ts` and never a value.** That erasure is the entire
  tree-shaking story: `rpc` alone is 14,759 B minified for the browser and `queryClient` alone is
  12,755 B, against 20,292 B / 17,912 B with `createClientFlight` imported beside them — ±376 B run
  to run, which is `Bun.build` 1.4.0 dropping core's `schema-error-codes.ts` (issue #273). A caller
  who wants a plain typed fetch must not pay for the fence, the dedup map or the retry loop —
  `packages/cli/src/templates/resource-form-island.ts` and `examples/dummy`'s contact-sales island
  both write a bare `fetch` today because that bill used to be unavoidable. Never import
  `createClientFlight` for a VALUE from `client.ts` — `ClientFlight` and `ClientRetry` are
  `import type` from `@ultimat3/core` and must stay that way.
- **The `sideEffects` array is what makes the barrel shakable, and it is load-bearing** (`As of
  2026-08-23`). Declaring nothing meant a bundler had to assume every module ran at import, so
  `import { rpc } from '@ultimat3/action'` was 43,104 B and `import { queryClient } from
  '@ultimat3/query'` was 40,859 B — three times the deep-import cost, through the ONLY specifier
  the `exports` map offers. The arrays are the ones `bun run scripts/side-effects.ts --explain
  --json` measures, and they must stay that: `errors.ts` runs `registerErrorCodes` at import in both
  packages, and query's `registry.ts` runs `registerPrimitiveRegistrar('query', …)` — drop either
  and a bundled app loses its error titles or throws `X_REGISTRAR_MISSING`. Never `false`.
- **A retried mutation is gated on an `Idempotency-Key`, and the gate is silent narrowing rather
  than a refusal** (`As of 2026-08-23`). `CallOptions.retry` is honoured only alongside
  `idempotencyKey`; without one the call is narrowed to a single attempt. A second POST with no key
  is a second WRITE, and nothing at this seam can tell a lost answer from a lost request. A refusal
  was the other candidate and was rejected: `retry:` may be set once on the flight for a whole
  client, and turning every keyless call in an app into a thrown error would make the flight
  un-installable. `client-flight.test.ts` pins both halves, and the header on every attempt.
- **A fence never aborts a write, and `client.ts` never calls `flight.keyFor`.** The first because
  closing a mutation's socket does not un-commit it — it only destroys the one chance the caller had
  of learning whether it landed, so `abortable: false` is unconditional and the caller still gets
  `X_SUPERSEDED` for the ANSWER. The second is how "a mutation may never join another mutation" is
  enforced: there is no dedup path to reach from here, even with a principal installed.
- **`registerAction` guards the derived PATH as well as the name.** `X_ACTION_DUPLICATE` only ever
  asked about the name, so `archiveOrder` and `archiveOrders` — one route, by `pluralize`'s
  deliberate "a trailing `s` is already plural" rule — both registered and both projected: the
  router table seated whichever came last and the other was unreachable over HTTP while its
  OpenAPI operation and MCP tool still advertised it. `paths` is a second index, cleared by
  `resetRegistry` with the first, and the refusal is `X_ACTION_PATH_DUPLICATE`.
- No policy at registration → `X_ACTION_POLICY_MISSING`. No exceptions, no flag.
- `serializeOpenApi` output must be byte-stable: sorted keys, sorted registry, no clock.
- `client.ts` stays free of server imports — it is bundled into the browser.
- Authz goes through `enforce(surface, policy, { input, actor, ctx })` from
  `@ultimat3/policy`; a returned denial becomes `ActionDeniedError`, which keeps the
  policy's own code (`X_FORBIDDEN`, `X_UNAUTHENTICATED`) and carries the surface
  denial. `policy-gate.ts` is the only file with a **runtime** edge to the policy package;
  `errors.ts` also imports it, `import type { SurfaceDenial }`, which `verbatimModuleSyntax`
  erases — so there is still exactly one place authz is evaluated.

## Commands

```
bun test packages/action
bun run typecheck
```
