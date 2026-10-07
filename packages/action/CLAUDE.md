# @ultimat3/action

Owns the `action` + `mutator` primitives and five projections. Tier 3. The MCP tool is
`@ultimat3/mcp`'s one projection (O-tool, 25.0.0).

## Boundary

- May import: `core`, `schema` (t0), `cache`, `db`, `i18n`, `time` (t1), `entity`, `policy`, `http` (t2).
  `entity` is a real edge since 21.0.0 (`record-wire.ts` → `hasEntityRows`/`rowsOf`), downward 3→2.
  `db` is one since 2026-10-02, downward 3→1, through **`tx-scope.ts` only** (`currentTx`).
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
| `define-api.ts` | `defineApi({ actions, mutators, queries, llm, jobs, tasks })` — the app's one boot call, and the `Api` type the typed clients are shaped from |
| `client-scale-pins.ts` | compile-time pin: `rpc<Api['actions']>` over 300 actions in 100 modules, 100 reads in 50 |
| `http.ts` | route projection (`enforcedBy: 'handler'`) + OpenAPI operation |
| `openapi.ts` | deterministic OpenAPI 3.1 document |
| `openapi-complete.ts` | the COMPLETE document (`defineApi({ openapi })`: info, servers, security schemes, 401/429 by the ROUTE's `meta.auth`) and a bearer mount's own cut |
| `http-path.ts` | where an action is served: the app's `pathStyle` + a per-action `http.path` pin, read lazily by every projection |
| `path-style-miss.ts` | `explainActionPathMiss` — `@ultimat3/http`'s `hooks.explainMiss`: a POST under the style this app does not serve is `X_CONTRACT_DRIFT` naming the one it does |
| `api-declaration.ts` | `defineApi({ http, openapi })` held process-wide for the boot and `x manifest` |
| `errors-http.ts` | the three HTTP-declaration refusals |
| `error-titles.ts` | every code's title, the one `registerErrorCodes` |
| `client.ts` | typed RPC client (browser-safe: no server imports) — dispatches through core's `clientTransport` |
| `record-wire.ts` | the record envelope on the HTTP projection: `carriesRecords` (from the output schema), the enveloped 200, and its OpenAPI shape. Server-only — `client.ts` never imports it |
| `wire-issues.ts` | the ONE reader of a problem document's `issues` member — an untrusted array back into `@ultimat3/schema`'s `ValidationIssue` shape |
| `transition.ts` | `transition()`: a MUTATOR factory over one entity column's state machine. Declares no error code — entity's three propagate |
| — | opt-in flight control is **`@ultimat3/core`**'s `client-flight.ts` + `client-wire.ts`, imported from core — `src/index.ts` re-exports only the `ClientFlight`/`ClientRetry` types. There is no local copy and must not be one |
| `wire-headers.ts` | `BUILD_ID_HEADER` + `IDEMPOTENCY_HEADER`, and nothing else. Their own module so `client.ts` can name them without importing `http.ts` |
| `job-handle.ts` | the `.job()` projection: an action as a queueable payload. **Not** consumed by `@ultimat3/jobs` — see Invariants |
| `contract-test.ts` | assertions `x g action` emits |
| `sample-input.ts` | a value `input:` accepts, from its own IR — what makes the policy assertion reach a policy |
| `idempotency.ts` | the store SEAM: types, the installed-store slot, the scope declaration + `assertIdempotencyScope`, and `withIdempotency` — the replay-or-run gate |
| `idempotency-key.ts` | the namespaced key — action + actor + the caller's key, as one JSON tuple — and the refusal of one that names no request |
| `idempotency-memory.ts` | the process default: bounded, swept, `scope: 'process'` |
| `idempotency-redact.ts` | `restingAnswer` — the copy of an answer a store may keep: core's `isRedactedKey` + `isSecret`, the SAME reference when nothing is redacted |
| `idempotency-postgres.ts` | the SHARED store — one table, one `insert … on conflict` |
| `policy-gate.ts` | **the only** runtime edge to `@ultimat3/policy` (`errors.ts` takes `SurfaceDenial` as a type, which erases) |
| `cache-gate.ts` | the post-COMMIT bust — **the only** file that calls `invalidateTags` |
| `tx-scope.ts` | the open transaction — **the only** file that imports `@ultimat3/db` (`tx-scope.test.ts`): `openCommitScope` (the bust) and `liveTransaction` (the settle) |
| `rate-limit-gate.ts` | **the one place** a declared `rateLimit:` is spent, and the installed-store slot |
| `request-deadline.ts` | `requestDeadlineMs` — the app's `requestTimeoutMs`, resolved by http's own `defineHttpConfig` |
| `audit.ts` | the audit seam's TYPES, re-exported from `@ultimat3/core` (shared with `query`); the slot (`setAuditSink`) is core's alone |
| `audit-memory.ts` | the process default: a bounded ring that DROPS, and counts what it dropped |
| `audit-postgres.ts` | the DURABLE sink — one append-only `x_audit` table, one insert per record |
| `audit-input.ts` | what may be written DOWN: an `input` redacted through core's table and made JSON-representable on every path |
| `audit-gate.ts` | **the only** file that calls a sink, and where the two failure policies live |
| `type-pins.ts` | compile-time assertions `tsc` checks — what the erased view projects, and why `client()` is not part of it |
| `naming.ts`, `validate.ts`, `json-schema.ts`, `stable.ts` | pure helpers. `stable.ts` is the DOCUMENT serializer plus a re-export of core's `isJsonObject` — the hash form is `@ultimat3/core`'s `canonicalJson`/`fingerprint` |

## Invariants — execution and authz

- Every surface goes through `invoke`: the policy's actor half (`guardBeforeInput`, 403 before the
  parse), parse input, evaluate policy, handle, parse output. A second
  execution path is the one unforgivable change here.
- **An explicit `ctx` is INSTALLED, never merely passed** — the ambient context (which
  `@ultimat3/entity`'s tenant guard reads) must be the identity `guard()` decided about.
  `invoke-context.test.ts` asserts ambient, `options.actor` and `options.ctx` are one caller.
- The declaration never leaves `invoke.ts`: `defOf`/`stashDef` are never re-exported from
  `src/index.ts` (`index.test.ts`). An action has no `.def`; outside, read `.input`/`.output`/
  `.policy`/`.mcp` or `describe()`. App code reaches a projection through the action
  (`publishPost.openapi()`); new methods are bound in `facade.ts`. **No `.tool()`**: it was a second
  MCP projection beside mcp's `toolFrom` (`index.test.ts`, `type-pins.ts`).
- **`toRoute` sets `enforcedBy: 'handler'`** — `invoke` is the one evaluation and the only one holding
  the row `def.row` loaded; `meta.policy` stays set. `http.test.ts` counts exactly one evaluation.
- **`meta.auth` comes from `@ultimat3/policy`'s `admitsAnonymous`** (a walk of the tree, via
  `policy-gate.ts`), never the root combinator — never a copy here (`@ultimat3/query` needs the same
  answer).
- Authz goes through `enforce(surface, policy, { input, actor, ctx })`; a denial becomes
  `ActionDeniedError`, keeping the policy's code. `policy-gate.ts` is the only RUNTIME edge to
  `@ultimat3/policy` (`errors.ts`'s `import type { SurfaceDenial }` erases).
- No policy at registration → `X_ACTION_POLICY_MISSING`. No exceptions, no flag.
- **`registerAction` guards the derived PATH as well as the name** (`X_ACTION_PATH_DUPLICATE`; a
  second index cleared by `resetRegistry`).
- **A path is the app's `pathStyle` or the action's pin, never a third answer** (`http-path.ts`).
  `'resource'` stays the default (changing it moves every URL). `defineApi` sets the style FIRST and
  `configureActionPathStyle` re-derives every seated action (the module scan may have seated them
  under the default). `derivePath(name)` is pin-aware through `installPinLookup` — handed down by
  `registry.ts`, never imported up (cycle through `action.ts`). `rpc()` cannot see a pin;
  `action.client()` holds it.
- **The style is stated ONCE, on the server.** A browser never restates it: the document carries
  `<meta name="ultimate-path-style">` (render's `clientPathStyleTags`, written only for a
  non-default style) and core's `actionPath(name)` reads it for every caller naming none — `rpc`,
  realtime's `useMutation` and the outbox replay. `client.ts` passes `options.pathStyle` through
  and adds NO default of its own. `ClientOptions.pathStyle` is for a caller with no document; a
  wrong one is answered `X_CONTRACT_DRIFT` (404) by `explainActionPathMiss`, never
  `X_ROUTE_NOT_FOUND`. A pinned action and a path under the SERVED style are never explained.
- **`Merge` in `define-api.ts` never recurses over the module list.** `Head & Merge<Rest>` is not
  a tail call: it cost one instantiation level per MODULE and answered TS2589 at the 48th entry of
  one list, whatever each exported (#534). The list is read as a union and intersected in one
  step. `client-scale-pins.ts` is the build error; `client-scale.contract.test.ts` compiles real
  `action()`/`query()` modules through `defineApi`'s `const` inference; `@ultimat3/query` pins
  `QueryClient` itself.
- **`defineApi({ openapi })` opts into the complete document; absent, `openapi.json`'s bytes are
  unchanged** — an upgrade must not make a committed contract stale by itself.
- Registration names the action the app exported, in place. Naming an already-named action is the
  only case that twins.
- **A mutator declares `idempotent: true` or does not exist**: required by `MutatorDef`, and
  `X_MUTATOR_NOT_IDEMPOTENT` at `mutator()` for anything else. The client replays a mutator's write
  under one key; `transition()` and `x g mutator` declare it. Never a default.
- A mutator projects `.local`, `.server`, `.conflict` plus every action member — no aliases.
  `mutator.server()` calls the action's own callable (lands in `invoke`); `.local()` never leaves the
  client.
- **`AnyAction` projects every surface, `client()` excepted** (`ClientMethod` is contravariant); both
  halves are build errors in `type-pins.ts`.
- **`defineApi` is the app's registration call**, reaching query/jobs/tasks through core's
  registrar table (`X_REGISTRAR_MISSING`, never a silent skip). `jobs` and `tasks` belong in the same
  call (the export name is the durable queue key); jobs register before tasks. The returned maps are
  built from the registrars' results, never the modules' exports.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim** (`index.test.ts` asserts identity).
- **`transition()` is a mutator factory that decides nothing about the machine**: entity's three
  codes propagate; `from` is REQUIRED (it is the UPDATE's predicate); `conflict: 'server-wins'` fixed;
  `audit` off unless declared; `id` is the key `output.id` declares (`keySchemaOf`), never a fixed
  `t.uuid`.
- **A lookup table is read with `Object.hasOwn`** (`IRREGULAR` in `naming.ts`, `BY_FORMAT` in
  `sample-input.ts`) — caller- or provider-supplied keys.

## Invariants — the wire

- **Every browser call goes through core's `clientTransport`**: `client.ts` hands it the method, the
  URL (core's `actionPath`; `naming.ts` re-exports core's path helpers), body, headers, signal, key,
  flight and `retry`. Only action-specific hooks ride in: `onResponse` (build-id check,
  `X_CONTRACT_DRIFT`) and `decodeError` (`RemoteActionError`, else core's
  `X_CLIENT_TRANSPORT_FAILED`). `X_RPC_FAILED` stays registered, thrown by nothing since 21.0.0.
- **A retried mutation needs an `Idempotency-Key`**: without one `retry` narrows to one attempt,
  silently (never a refusal). A fence never aborts a write (`abortable: false`), and `client.ts`
  never calls `flight.keyFor`.
- **The record envelope is derived from the output schema, per ACTION** (`carriesRecords` =
  entity's `hasEntityRows`, once in `toRoute`): `{ data, records }` under `x-ultimate-records: 1` on
  every answer. HTTP-only. An output with no entity row is byte-identical (`record-wire.test.ts`).
- **`conflict` is core's `ConflictPolicy`, over ROWS**; `custom(merge)` builds
  `{ kind: 'custom', merge(localRow, serverRow) }`; core's `resolveConflict` is the one resolver.
- **`X_INPUT_INVALID` carries the rejections twice**: the line in `cause`
  (`formatIssues(issues).join('; ')`, pinned by `validate.test.ts`) and `meta.issues` structured.
  The rendering stays out of `InputInvalidError` (browser-reachable). **`toValidationIssues`** keeps
  four members, never a library's raw issue (it may carry the value). `issuesFromWire` rebuilds
  member by member, all-or-nothing, bounded by `MAX_WIRE_ISSUES`. **`X_OUTPUT_INVALID` keeps the line alone.**
- **The client keeps the server's code and marks it remote** (`RemoteActionError`, `meta.origin:
  'remote'`), only for an `X_SCREAMING_SNAKE` code. It never synthesizes a docs URL: the server's
  `http(s)` `docs`/`type` (as an ordered pair), else this build's registered link, else
  `ERROR_DOCS_URL`.
- **Both clients inject `traceparent`** before the caller's headers; an incomplete span sends nothing.
- `serializeOpenApi` output is byte-stable: sorted keys, sorted registry, no clock. `client.ts` stays
  free of server imports.
- **`stable.ts` holds the DOCUMENT form only** (`stableStringify` → `openapi.json`, re-read by
  `json-schema.ts`). The HASH form is core's `canonicalJson`/`fingerprint` (injective: tags
  `NaN`/`±Infinity`/`-0`, `Date`, `Map`, `Set`); `stable.test.ts` pins byte-equality for ordinary
  payloads.
- **`tagKeys` is `@ultimat3/cache`'s and `toBucket` is `@ultimat3/http`'s** (re-exported; raises
  `X_RATE_LIMIT_INVALID`). Never restore a local copy; never use `@ultimat3/render`'s `tagKeys`.
- **`rateLimit:` is spent ONCE, inside `invoke`** (`rate-limit-gate.ts`), so HTTP, MCP, the agent
  tool and `.job()` share one bucket; `surface: 'server'` spends nothing. `toRoute` sets
  `rateLimitedBy: 'handler'` and NO `meta.rateLimit`/`rateLimitBucket` — the stage spends neither
  the action's bucket (the old HTTP-only point) nor `default`. Key `action:<name>|<subject>`.
  HTTP gets `RateLimit-*` via `onRateLimit` → http's `publishRateLimit`. The store is
  `@ultimat3/http`'s installed one, adopted by the boot on every role. Spent after
  `guardBeforeInput`, BEFORE the parse and `def.row()` (an input/row-denied flood is refused). A key
  the idempotency store holds spends nothing (replay); a reservation `withIdempotency` CREATES that
  the peek did not pay for spends in `beforeRun`, released on refusal. A job run is charged to its
  org, else `job:unattributed`. A surface's `clientAddress` is inherited by nested `invoke`s
  (`withCallerAddress`); a `'job'` invoke opens a fresh frame (`withJobFrame`) so no visitor's
  address follows work into the worker, and calls nested in it are the job's.
  `rate-limit-surfaces.test.ts`. The computed rate must be finite and `limit` at least one token.
- **`deprecated:` is a compat WINDOW** — headers on every response including failures, a
  `rel="successor-version"` link via `derivePath`, `deprecated: true` in OpenAPI,
  `deprecated_calls_total`. Rendered ONCE at projection (`X_ACTION_DEPRECATION_INVALID` at mount).
  Twinned in `@ultimat3/query`.
- **The span wraps `execute` whole** (including `def.row()`), with bounded attributes plus the
  namespaced idempotency key (never a metric label). `telemetry.test.ts`.
- **`policyCapability` is a display label; `policyPermissions` (`ActionDescriptor.permissions`) is
  what a report matches on** (a `not()` clause contributes its permissions).
- **MCP exposure is core's `isMcpExposed`** (`describeAction`, `x-ultimate.mcpTool`); **a tool's
  NAME is the export name verbatim** (`mcp-surface.test.ts`). `ActionFact.mcp` in the app manifest
  carries only `{ expose, description? }`.
- **`ActionJobHandle` is not consumed by `@ultimat3/jobs`** (`isJobHandle` needs `job()`'s private
  map). `.job()` gives `action:<name>` as a queue key, a payload-derived idempotency key and an
  `invoke` under `surface: 'job'`. The bridge is `agentJob()` in `@ultimat3/ai`, or an app's own
  `job({ … })` supplying `tenant` and `retry`.

## Invariants — flight control

- **Flight control is `@ultimat3/core`'s, and NOT re-exported** — its values are imported from
  core (`X_HELPER_COPY` refuses a re-export); only the types `ClientFlight`/`ClientRetry`. Fix the
  pipeline in `packages/core/src/client-flight.ts`. No new code, curve, fence or retry loop here (`bun run flight-copies`).
- **`isTransientFailure` INVERTS `retryDecision`'s unclassified default** (a caller's `AbortError`
  is terminal). Must survive.
- **`ClientFlight` is a TYPE inside `client.ts`, never a value.** Measured,
  `bun build --target=browser --minify`, one entry importing from `@ultimat3/action` — **the ONE
  table for these figures** (`packages/core/CLAUDE.md` points here):

  | Entry | `As of 2026-10-01` |
  |---|---|
  | `rpc` | 19,671 B (+181 B for the document's path-style stamp) |
  | `rpc` + core's `createClientFlight` | 25,954 B |

  Earlier columns (pre-transport 18,097 B, +977 B net for the envelope decoder) are in git history.
- **`sideEffects` is `["./src/error-titles.ts"]`**, never `false` (drops its bare imports): the
  titles ride into every barrel chunk (`problemError` decodes by code), `errors.ts`'s classes do
  not. An http refusal needs no http module: core's decoders take its title off the body and its
  `retry-after` off the header (`rpc-refusal.test.ts`).

## Invariants — idempotency

- **Everything `withIdempotency`'s `run` throws is treated as possibly-committed**: the reservation
  is SETTLED as a failure and a retry replays it; `release()` is only for a pre-handler failure. A
  `settle` that refuses leaves the record in flight. `idempotency-failure.test.ts`.
- **A record belongs to ONE CALLER**: the key is
  `JSON.stringify([action, actor.kind, actor.id, actor.orgId ?? null, key])` — a JSON tuple, never a
  joined string. A blank header is `X_IDEMPOTENCY_KEY_INVALID` (4xx, before the handler), never "no
  key". Anonymous callers still share one key space.
- **The `idempotency-key` header also NAMES the write, on every action**: `http.ts` runs `invoke`
  inside `withWriteOrigin(writeDigest(key))` so the page recognises its own `records` echo. A label,
  never a gate.
- **Both stores FENCE a settlement on the reservation `id` AND `in-flight`**:
  `settle(key, value, reservationId, redacted)` / `fail(key, failure, reservationId)`. A fenced no-op is logged,
  never thrown.
- **An answer rests REDACTED** (#591): `withIdempotency` passes the store `restingAnswer(value)`
  (core's `isRedactedKey` + `isSecret` — never a second rule) and `redacted` as `settle`'s
  REQUIRED 4th argument; both stores keep it (`x_idempotency.redacted`, memory's record field).
  A flagged replay is `X_IDEMPOTENT_REPLAY_REDACTED`, decided by the FLAG, never by scanning for
  `[redacted]`. Plain data is the same reference, replayed as before; anything else that
  `JSON.stringify` would run app code on (`toJSON`, `Map`/`Set`, class instances, `Date`
  subclasses) is redacted FAIL-CLOSED, and a getter is read once. `keepsRedaction: true` is a
  required store declaration (`type-pins.ts`: a pre-25 store is a build error — a required
  parameter alone is not). A reclaim and a `fail` reset the flag.
- **A stored status is NARROWED** (`isIdempotencyStatus`; unknown is
  `X_IDEMPOTENCY_STATUS_UNKNOWN`), never cast.
- **Where records live is DECLARED and refused at registration**: `IdempotencyStore.scope` vs
  `configureIdempotency({ scope })`, compared by `assertIdempotencyScope` in `registerAction`
  (`X_IDEMPOTENCY_NOT_SHARED`). Default `'process'`.
- **The memory store is bounded; `in-flight` records are the last evicted.** Never an LRU.
- **`postgresIdempotencyStore` is the shared store** over `@ultimat3/core`'s structural `PgExecutor`; the
  reservation is ONE `insert … on conflict` statement. The CLI boot installs it.
- **Inside a transaction the SETTLE commits with the write, on BOTH stores** (`liveTransaction()`):
  Postgres on the handler's connection, memory at `onCommit`. The reservation and `fail` stay
  immediate. A tx-bound settle that matches no record THROWS `X_IDEMPOTENCY_RESERVATION_LOST` (the
  rollback of an attempt a retry replaced); the autocommit one only logs. Only a tx-bound
  `in-flight` record is reclaimed past the deadline — never an autocommit one.
  `idempotency-parity.test.ts` (memory + PGlite), `idempotency-postgres.live.test.ts`.
- **The deadline is `reclaimAfterMs: () => number`, REQUIRED on the Postgres store** and read per
  reservation — the app's `requestTimeoutMs` through `requestDeadlineMs` (`request-deadline.ts`,
  http's own default, never a number here). **`origin: () => object` is required too**: a
  transaction on another database settles on the pool. A FINISHED scope's handle binds nothing.

## Invariants — cache and audit

- **The post-commit bust never fails the write** — `cache-gate.ts` (the only `invalidateTags` caller)
  absorbs a refusing fan-out and logs through core's `logger`, never rendering the tags. A replay
  skips the bust.
- **The bust waits for the ROOT commit** when a transaction is open (`openCommitScope().onCommit`):
  dropped on rollback, never fired before the rows are durable. A straggler past its scope gets
  `DbTx.onCommit`'s own answer, as entity's row observer does. `cache-gate-tx.test.ts` (PGlite).
- **The OpenAPI contract assertion reads the registry-wide document** and compares `operationId`
  — one built from the action alone could not fail. **`Problem` is `toProblem`'s members**, no
  `code` pattern (`openapi-problem.test.ts`).
- **The policy contract test asserts `ActionDeniedError` and sends valid input** (`sampleInput` from
  the input IR). Only `X_INPUT_INVALID` (and `X_AUDIT_SINK_MISSING`, the one refusal before the parse)
  becomes `X_CONTRACT_DRIFT`; everything else keeps its own code; a non-`UltimateError` is rethrown.
  `contract-test.contract.test.ts`.
- **The audit seam ships the mechanism and none of the row**: `audit: true` wraps `execute`, so a
  DENIED attempt is recorded. No audit entity, retention, hash chain or "who" convention. The
  vocabulary matches `@ultimat3/admin`'s by name (tier 5, no edge); admin's `AuditSink` is a known
  duplicate that unifying would need core for.
- **Records carry `name` + `primitive`, required** (`type-pins.ts`); no `action` alias since 25.0.0.
  The `x_audit.action` column holds `name`.
- **The memory sink DROPS** — a ring at `DEFAULT_MAX_AUDIT_RECORDS`, oldest first, counting `dropped`;
  no spelling of "unbounded".
- **A durable sink writes what `audit-input.ts` allows**: input redacted through core's
  `isRedactedKey` (the table `defineEnv({ secret: true })` extends) plus `isSecret` by value, and
  always JSON-representable (named markers, cycle detection; `toJSON` never called).
- **The `Ctx` is never walked**: `postgresAuditSink` reads an allow-list (`requestId`, `traceId`,
  `locale`, `tz`, `buildId`, `role`, actor `id`/`kind`/`orgId`/`onBehalfOf`) and keeps
  `failure.code`, never the error.
- **`x_audit` ships no purge**, deliberately. **`SQL_AUDIT_INSERT` is positional**, pinned by
  `audit-parity.test.ts` with a distinct value per field. Only `*_TABLE` DDL is exported
  (`X_SQL_EXPORT_UNREAD`).
- **The two failure policies are opposites**: `X_AUDIT_SINK_MISSING` before the input parse (no
  logger-backed default sink); a sink refusing an ALLOWED record is `X_AUDIT_SINK_FAILED`, whose `fix:`
  branches on `record.idempotencyKey !== null` (`meta.replayable`); a sink refusing a denied or failed
  record is logged (`audit.sink.failed`) and the original error still reaches the caller.
- **`auditSettled` sits outside the `catch`**, and **`auditOutcomeFor` is TOTAL** (fails closed to
  `failed`); `audit.test.ts` asserts the caller's throwable by identity.
- **`json-schema.ts`'s refusal names `introspect()`** (`normalizeJsonSchema`, test-only export).

## Commands

```
bun test packages/action
bun run typecheck
```

Why each rule above is shaped the way it is: [`docs/history/action.md`](../../docs/history/action.md).
