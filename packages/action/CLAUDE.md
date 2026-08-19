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
| `audit.ts` | the audit seam: `AuditRecord`, `AuditSink`, the memory sink, the installed-sink store |
| `audit-gate.ts` | **the only** file that calls a sink, and where the two failure policies live |
| `type-pins.ts` | compile-time assertions `tsc` checks — what the erased view projects, and why `client()` is not part of it |
| `naming.ts`, `validate.ts`, `json-schema.ts`, `stable.ts` | pure helpers |

## Invariants

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
- **`stable.ts` holds TWO serializers, and they are not one function.** `stableStringify` is the
  DOCUMENT form: `serializeOpenApi` publishes it as `openapi.json` and `json-schema.ts` re-reads it
  with `JSON.parse`, so a non-finite number has to be `null` — the bare token `NaN` would make a
  published spec unparseable. `canonicalJson` is the HASH form `fingerprint` is taken over, and it
  must be INJECTIVE: `NaN`, `±Infinity` and JSON `null` all encoded as `'null'` and `String(-0)` is
  `"0"`, so four distinct inputs shared one `requestHash` — one caller handed another's stored
  response on replay — and one job dedupe key. That is why the fix `@ultimat3/query` made in its own
  `stable.ts` could not simply be copied here; it needed the split first. Ordinary payloads are
  byte-identical between the two, so no idempotency record and no enqueued job moved.
  `stable.test.ts` pins both duties, including a `JSON.parse` of the document form.
  **Three more values were folded onto `{}` until 2026-08, and the first is one `t.date` produces
  on every parse.** A `Date`, a `Map` and a `Set` have no own enumerable key, so `Object.keys` was
  empty and the object branch rendered all three `{}` — `fingerprint({ x: new Map([['a', 1]]) })`
  equalled `fingerprint({ x: new Set([1, 2]) })` equalled `fingerprint({ x: {} })`, and an
  `idempotent: true` action taking `t.object({ at: t.date })`, called twice under one key with two
  DIFFERENT dates, handed the second caller the first one's stored response with no
  `X_IDEMPOTENCY_CONFLICT` and the handler run once. The walk now branches on all three AHEAD of
  the object branch, and the two forms disagree about them exactly as they disagree about numbers:
  the document form is `JSON.stringify`'s own rendering (a Date's ISO string, `{}` for a Map and a
  Set), because that string is published and re-parsed, and the hash form TAGS them —
  `Date(<epoch>)`, `Map(k:v,...)`, `Set(v,...)` — extending the per-type tagging `hashNumber`
  already uses for `NaN` and `-0`. The tag is not decoration: an untagged epoch is the same token
  a `t.number` field holding that epoch emits, which is the collision being closed. Map and Set
  entries are SORTED, as object keys are — insertion order is not part of what either holds.
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
- **Both stores FENCE a settlement on `in-flight`**, as `@ultimat3/jobs`' `SQL_ACK` fences on
  `state = 'running'`. A reservation whose window lapsed is reclaimed by the next caller
  (`on conflict … do update`), so a straggler from the first one used to overwrite a record it no
  longer owned and the next replay answered a retry with a value produced for a different request.
  Postgres fences in SQL and returns `key`, so the no-op is observable and logged; memory checks
  the status it holds. It is logged and never thrown — a settlement is post-commit, so raising
  there would turn a durable write into the caller's error. The fence is on the STATUS only: the
  reservation's own `id` would close the last case (a straggler landing while the replacement is
  still in flight) and cannot be checked, because `IdempotencyStore.settle(key, value)` is public
  API and does not carry it.
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
  belongs in the app or at tier 4+: `action` and `jobs` are both tier 3. Not built here — that is
  code, and this was a comment correction.
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
  `https://ultimate.dev/errors/X_SIGNUP_CLOSED` for an app-declared code is a 404 dressed as
  documentation; the link is the server's own `docs`/`type` when it sent an `http(s)` one, this
  build's registered link when `hasErrorCode` knows the code, otherwise `ERROR_DOCS_BASE`. The
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
  **not** ship, ever: an audit entity, a schema, a retention policy, a storage backend, a hash
  chain, a subject index, or an opinion on what "who" means under impersonation — four apps model
  those four ways, so by axiom 8's own test they are business convention and shipping one makes
  three of them wrong. `result` is absent for the same reason and one more: a handler's return is
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
