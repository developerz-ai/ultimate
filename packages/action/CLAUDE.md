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
| `tool-gate.ts` | a named tool's gate: `mcp` registers, `ai` reads, first wins |
| `define-api.ts` | `defineApi({ actions, mutators, queries, llm, jobs, tasks })` — the app's one boot call, and the `Api` type the typed clients are shaped from |
| `client-scale-pins.ts` | compile-time pin: `rpc<Api['actions']>` over 300 actions in 100 modules, 100 reads in 50 |
| `http.ts` | route projection (`enforcedBy: 'handler'`) + OpenAPI operation |
| `openapi.ts` | deterministic OpenAPI 3.1 document |
| `openapi-complete.ts` | the COMPLETE document (`defineApi({ openapi })`: info, servers, security schemes, 401/429 by the ROUTE's `meta.auth`) and a bearer mount's own cut |
| `http-path.ts` | where an action is served: the app's `pathStyle` + a per-action `http.path` pin, read lazily by every projection; the pin's `:param` template + `method` (`ACTION_HTTP_METHODS`), `assertPinnedHttp`, `filledRoute`, `pathParametersOf`, `actionHttpPinOf` |
| `path-style-miss.ts` | `explainActionPathMiss` — `@ultimat3/http`'s `hooks.explainMiss`: a POST under the style this app does not serve is `X_CONTRACT_DRIFT` naming the one it does |
| `api-declaration.ts` | `defineApi({ http, openapi })` held process-wide for the boot and `x manifest` |
| `errors-http.ts` | the three HTTP-declaration refusals |
| `error-titles.ts` | every code's title, the one `registerErrorCodes` |
| `client.ts` | typed RPC client (browser-safe: no server imports) — dispatches through core's `clientTransport` |
| `record-wire.ts` | the record envelope on the HTTP projection: `carriesRecords` (from the output schema), the enveloped 200, and its OpenAPI shape. Server-only — `client.ts` never imports it |
| `wire-issues.ts` | the ONE reader of a problem document's `issues` member — an untrusted array back into `@ultimat3/schema`'s `ValidationIssue` shape |
| `transition.ts` | `transition()`: a MUTATOR factory over one entity column's state machine. Declares no error code — entity's three propagate |
| — | opt-in flight control is **`@ultimat3/core`**'s `client-flight.ts` + `client-wire.ts`, imported from core — `src/index.ts` re-exports only the `ClientFlight`/`ClientRetry` types. There is no local copy and must not be one |
| `job-handle.ts` | the `.job()` projection: an action as a queueable payload. **Not** consumed by `@ultimat3/jobs` — see Invariants |
| `contract-test.ts` | assertions `x g action` emits |
| `exercise.ts` | the fourth contract assertion: run loop, verdict, `exerciseContract` |
| `exercise-errors.ts` | the three `X_CONTRACT_*` classes, off-socket |
| `declared-errors.ts` | the wrap `invoke` puts around `handle` and `row`, the ONLY judged throws. `errors:` is checked, sorted and frozen at `action()` |
| `declared-errors-contract.ts` | `.contract()`'s source scan |
| `openapi-errors.ts` | core's builder bound to http's status and `problemTypeFor` |
| `idempotency.ts` | the store SEAM: types, the installed-store slot, the scope declaration + `assertIdempotencyScope`, and `withIdempotency` — the replay-or-run gate |
| `idempotency-key.ts` | the namespaced key — action + actor + the caller's key, as one JSON tuple — and the refusal of one that names no request |
| `idempotency-memory.ts` | the process default: bounded, swept, `scope: 'process'` |
| `idempotency-redact.ts` | `restingAnswer` — the copy of an answer a store may keep: core's `isRedactedKey` + `isSecret`, the SAME reference when nothing is redacted |
| `idempotency-postgres.ts` | the SHARED store — one table, one `insert … on conflict` |
| `policy-gate.ts` | **the only** runtime edge to `@ultimat3/policy` (`errors.ts` takes `SurfaceDenial` as a type, which erases) |
| `cache-gate.ts` | the post-COMMIT bust — **the only** file that calls `invalidateTags` |
| `tx-scope.ts` | the open transaction — **the only** file that imports `@ultimat3/db` (`tx-scope.test.ts`): `openCommitScope` (the bust), `liveTransaction` (the settle), `completeTransaction`, and `inRolledBackScope`, the exercise's always-rolled-back scope and the memory transaction it opens always |
| `rate-limit-gate.ts` | **the one place** a declared `rateLimit:` is spent, and the installed-store slot |
| `request-deadline.ts` | `requestDeadlineMs` — the app's `requestTimeoutMs`, resolved by http's own `defineHttpConfig` |
| `audit.ts` | the audit seam's TYPES, re-exported from `@ultimat3/core` (shared with `query`); the slot (`setAuditSink`) is core's alone |
| `audit-memory.ts` | the process default: a bounded ring that DROPS, and counts what it dropped |
| `audit-postgres.ts` | the DURABLE sink — one append-only `x_audit` table, one insert per record |
| `audit-input.ts` | what may be written DOWN: an `input` redacted through core's table and made JSON-representable on every path |
| `audit-gate.ts` | **the only** file that calls a sink, and where the two failure policies live |
| `type-pins.ts` | compile-time assertions `tsc` checks — what the erased view projects, and why `client()` is not part of it |
| `naming.ts`, `validate.ts`, `json-schema.ts`, `stable.ts` | pure helpers. `stable.ts` is the DOCUMENT serializer (core's `isJsonObject` is imported from core, never re-exported) — the hash form is `@ultimat3/core`'s `canonicalJson`/`fingerprint` |

## Invariants — execution and authz

- Every surface goes through `invoke`: the policy's actor half (`guardActionBeforeInput`, 403 before the
  parse), parse input, evaluate policy, handle, parse output. A second
  execution path is the one unforgivable change here.
- **An explicit `ctx` is INSTALLED, never merely passed** — the ambient context (which
  `@ultimat3/entity`'s tenant guard reads) must be the identity `guardAction()` decided about.
  `invoke-context.test.ts` asserts ambient, `options.actor` and `options.ctx` are one caller.
- The declaration never leaves `invoke.ts`: `defOf`/`stashDef` are never re-exported from
  `src/index.ts` (`index.test.ts`). An action has no `.def`; outside, read `.input`/`.output`/
  `.policy`/`.mcp` or `describe()`. App code reaches a projection through the action
  (`publishPost.openapi()`); new methods are bound in `facade.ts`. **No `.tool()`**: it was a second
  MCP projection beside mcp's `toolFrom` (`index.test.ts`, `type-pins.ts`).
- **`toRoute` sets `enforcedBy: 'handler'`** — `invoke` is the one evaluation and the only one holding
  the row `def.row` loaded; `meta.policy` stays set. `http.test.ts` counts exactly one evaluation.
- **`meta.auth` comes from `@ultimat3/policy`'s `admitsAnonymous`** (a walk of the tree, imported
  from `@ultimat3/policy` by `http.ts`; 25.0.0 dropped this package's re-export, `index.test.ts`
  pins the absence), never the root combinator — never a copy here (`@ultimat3/query` needs the same
  answer).
- Authz goes through `enforce(surface, policy, { input, actor, ctx })`; a denial becomes
  `ActionDeniedError`, keeping the policy's code. `policy-gate.ts` is the only RUNTIME edge to
  `@ultimat3/policy` (`errors.ts`'s `import type { SurfaceDenial }` erases).
- No policy at registration → `X_ACTION_POLICY_MISSING`. No exceptions, no flag.
- **`registerAction` guards the derived PATH as well as the name** (`X_ACTION_PATH_DUPLICATE`; a
  second index cleared by `resetActions`).
- **A path is the app's `pathStyle` or the action's pin, never a third answer** (`http-path.ts`). A pin may be a template: `derivePath(name)` refuses one, `actionHttpPath(name, params)` fills it.
  `'resource'` stays the default (changing it moves every URL). `defineApi` sets the style FIRST and
  `configureActionPathStyle` re-derives every seated action (the module scan may have seated them
  under the default). `derivePath(name)` is pin-aware through `installPinLookup` — handed down by
  `registry.ts`, never imported up (cycle through `action.ts`). browser `rpc()` reads the `ultimate-pins` stamp;
  a server takes `action.client()`.
- **The style is stated ONCE, on the server**; a browser reads `<meta name="ultimate-path-style">` through core's `actionPath(name)`. Full rule: `docs/history/action.md`.
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
  `t.uuid`; `row` goes to `mutator()` as declared, never loaded here (#687); **the rule's reads
  are pinned in the move** (#702, `transition-observe.ts`: `def.row`, `def.handle` share `input`).
- **A lookup table is read with `Object.hasOwn`** (`IRREGULAR` in `naming.ts`; `BY_FORMAT` is
  `@ultimat3/schema`'s `sample-draw.ts`) — caller- or provider-supplied keys.
- **`handlerReached(target)` in `invoke.ts` is a private per-declaration counter, never on the
  barrel.** `exercise.ts` reads it to tell a run that reached `handle` from one stopped before it.
- **The exercise has no bypass.** The actor is `exercise.actor`; with none, a guarded action is
  `X_CONTRACT_EXERCISE_UNDECLARED` and a public one runs as `null`. `X_TEST_NETWORK_SEALED` is
  checked before the verdict, because it maps to no status. A coded 5xx, `X_OUTPUT_INVALID` or an
  uncoded throw is `X_CONTRACT_DEFECT`.

## Invariants — the wire

- **A `:param` pin's values come from the router's decoded params, merged into the input before
  `invoke`** (`toRoute` → core's `mergePathParams`). A body naming the key differently is
  `X_HTTP_PATH_INPUT_CONFLICT`, never overridden. `registerAction`'s duplicate index keys on method
  + path. `http-path-params.test.ts`.
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
  `meta.requestId` is the document's root member, through core's `withRequestId` (`rpc-refusal.test.ts`). `REPLAYED_HEADER` is core's; `http.ts` imports it, the barrel no longer re-exports it.
- **Both clients inject `traceparent`** before the caller's headers; an incomplete span sends nothing.
- `serializeOpenApi` output is byte-stable: sorted keys, sorted registry, no clock. `client.ts` stays
  free of server imports.
- **`stable.ts` holds the DOCUMENT form only** (`stableStringify` → `openapi.json`, re-read by
  `json-schema.ts`). The HASH form is core's `canonicalJson`/`fingerprint` (injective: tags
  `NaN`/`±Infinity`/`-0`, `Date`, `Map`, `Set`); `stable.test.ts` pins byte-equality for ordinary
  payloads.
- **`tagKeys` is `@ultimat3/cache`'s and `toBucket` is `@ultimat3/http`'s** (imported, never
  re-exported; `toBucket` raises `X_RATE_LIMIT_INVALID`). Never restore a local copy.
- **`rateLimit:` is spent ONCE, inside `invoke`** (`rate-limit-gate.ts`), so HTTP, MCP, the agent tool and `.job()` share one bucket; `surface: 'server'` spends nothing. Full rule: `docs/history/action.md`.
- **`deprecated:` is a compat WINDOW** — headers on every response including failures, a
  `rel="successor-version"` link via `derivePath`, `deprecated: true` in OpenAPI,
  `deprecated_calls_total`. Rendered ONCE at projection (`X_ACTION_DEPRECATION_INVALID` at mount).
  Twinned in `@ultimat3/query`.
- **The span wraps `execute` whole** (including `def.row()`), with bounded attributes plus the
  namespaced idempotency key (never a metric label). `telemetry.test.ts`.
- **`policyCapability` is a display label; `policyPermissions` (`ActionDescriptor.permissions`) is
  what a report matches on** (a `not()` clause contributes its permissions). Both are
  `@ultimat3/policy`'s, imported from there.
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

  | Entry | `As of 2026-11`, Bun 1.4.4, one entry over the working tree |
  |---|---|
  | `rpc` | 27,472 B: pinned paths (wave 5b) add `fillWire` +758 B, `renderedActionPin` +619 B (each stubbed out) |
  | `rpc` + core's `clientFlight` | 35,921 B (the same +1,377 B) |

  Without both, `rpc` is 26,095 B: +3,672 B over 2026-11-02's 22,423 B is waves 3–5a (`issueRuleFacts`…).

- **`sideEffects` is `["./src/error-titles.ts"]`**, never `false` (drops its bare imports): the
  titles ride into every barrel chunk (`problemError` decodes by code), `errors.ts`'s classes do
  not. An http refusal needs no http module: core's decoders take its title off the body and its
  `retry-after` off the header (`rpc-refusal.test.ts`).

## Invariants — idempotency

- **Everything `withIdempotency`'s `run` throws is treated as possibly-committed**: the reservation
  is SETTLED as a failure and a retry replays it; `release()` is only for a pre-handler failure. A
  `settle` that refuses leaves the record in flight. `idempotency-failure.test.ts`.
- **A keyed run is owed its end**: `completeTransaction()`, then `runToCompletion(run)` under `idempotencyCeilingMs()` (`X_IDEMPOTENCY_RUN_CEILING`); `invoke` reads the handler's `ctx` inside it. `idempotency-orphan.test.ts`.
- **A record belongs to ONE CALLER**: the key is
  `JSON.stringify([action, actor.kind, actor.id, actor.orgId ?? null, key])` — a JSON tuple, never a
  joined string. A blank header is `X_IDEMPOTENCY_KEY_INVALID` (4xx, before the handler), never "no
  key". Anonymous callers still share one key space.
- **The `idempotency-key` header also NAMES the write, on every action**: `http.ts` runs `invoke`
  inside `withWriteOrigin(writeDigest(key))` so the page recognises its own `records` echo. A label,
  never a gate.
- **Both stores FENCE a settlement on the reservation `id` AND `in-flight`**:
  `settle(key, value, reservationId, redacted)` / `fail(key, failure, reservationId)` /
  `release(key, reservationId)`. A fenced no-op is never thrown.
- **An answer rests REDACTED** (#591): `withIdempotency` passes the store `restingAnswer(value)`
  (core's `isRedactedKey` + `isSecret`) and `redacted` as `settle`'s REQUIRED 4th argument. A
  flagged replay is `X_IDEMPOTENT_REPLAY_REDACTED`, by the FLAG, never by scanning. Full rule: `docs/history/action.md`.
- **A finished record skips the row half; a stale peek judges it in `beforeRun`** (`idempotency-row.test.ts`). **A `bigint` answer settles failed** (`X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE`).
- **A stored status is NARROWED** (`isIdempotencyStatus`; unknown is
  `X_IDEMPOTENCY_STATUS_UNKNOWN`), never cast.
- **Where records live is DECLARED and refused at registration**: `IdempotencyStore.scope` vs
  `configureIdempotency({ scope })`, compared by `assertIdempotencyScope` in `registerAction`
  (`X_IDEMPOTENCY_NOT_SHARED`). Default `'process'`.
- **The memory store is bounded; `in-flight` records are the last evicted.** Never an LRU.
- **`postgresIdempotencyStore` is the shared store** over `@ultimat3/core`'s structural `PgExecutor`; the
  reservation is ONE `insert … on conflict` statement. The CLI boot installs it.
- **Inside a transaction the SETTLE commits with the write, on BOTH stores** (`liveTransaction()`). `idempotency-parity.test.ts`. Full rule: `docs/history/action.md`.
- **The deadline is `reclaimAfterMs: () => number`, REQUIRED on the Postgres store** and read per
  reservation — the app's `requestTimeoutMs` through `requestDeadlineMs` (`request-deadline.ts`,
  http's own default, never a number here). **`origin: () => object` is required too**: a
  transaction on another database settles on the pool. A FINISHED scope's handle binds nothing.

## Invariants — cache and audit

- **The post-commit bust never fails the write** — `cache-gate.ts` (the only `invalidateTags` caller)
  absorbs a refusing fan-out and logs through core's `logger`, never rendering the tags. A replay
  skips the bust. **A started handler busts, thrown or not.**
- **The bust waits for the ROOT commit** when a transaction is open (`openCommitScope().onCommit`):
  dropped on rollback, never fired before the rows are durable. A straggler past its scope gets
  `DbTx.onCommit`'s own answer, as entity's row observer does. `cache-gate-tx.test.ts` (PGlite).
- **The OpenAPI contract assertion reads the registry-wide document** and compares `operationId`
  — one built from the action alone could not fail. **`Problem` is `toProblem`'s members**, no
  `code` pattern (`openapi-problem.test.ts`), checked both ways; `retry` is an enum of core's `ERROR_RETRY_KINDS`.
- **The policy contract test asserts `ActionDeniedError` and sends valid input** (`sampleInput` from
  the input IR). Only `X_INPUT_INVALID` (and `X_AUDIT_SINK_MISSING`, the one refusal before the parse)
  becomes `X_CONTRACT_DRIFT`; everything else keeps its own code; a non-`UltimateError` is rethrown.
  `contract-test.contract.test.ts`.
- **The audit seam ships the mechanism and none of the row**: `audit: true` wraps `execute`, so a
  DENIED attempt is recorded. No audit entity, retention, hash chain or "who" convention. The
  vocabulary matches `@ultimat3/admin`'s by name (tier 5, no edge); admin's `AuditSink` is a known
  duplicate that unifying would need core for.
- **`invoke` masks `trace.input` with `maskSensitive(def.input, …, REDACTED)` only when `audit: true`**;
  `registerAction` calls `assertNoSensitiveOutput` on `output`. `wire-issues.ts` and
  `PROBLEM_SCHEMA` carry `rule` and `params` (the four members stay `required`).
- **A durable sink writes what `audit-input.ts` allows**: input redacted through core's
  `isRedactedKey` (the table `defineEnv({ secret: true })` extends) plus `isSecret` by value, and
  always JSON-representable (named markers, cycle detection; `toJSON` never called).
- **The `Ctx` is never walked**: `postgresAuditSink` reads an allow-list (`requestId`, `traceId`,
  `locale`, `tz`, `buildId`, `role`, actor `id`/`kind`/`orgId`/`onBehalfOf`) and keeps
  `failure.code`, never the error.
- **`x_audit` ships no purge**, deliberately. **`SQL_AUDIT_INSERT` is positional**, pinned by
  `audit-parity.test.ts` with a distinct value per field. Only `*_TABLE` DDL is exported
  (`X_SQL_EXPORT_UNREAD`).
- **The two failure policies are opposites**: `X_AUDIT_SINK_MISSING` before the input parse; a sink refusing an ALLOWED record is `X_AUDIT_SINK_FAILED`; refusing a denied or failed one is logged. Full rule: `docs/history/action.md`.
- **`auditSettled` sits outside the `catch`**, and **`auditOutcomeFor` is TOTAL** (fails closed to
  `failed`); `audit.test.ts` asserts the caller's throwable by identity.

## Commands

```
bun test packages/action
bun run typecheck
```

Why each rule above is shaped the way it is: [`docs/history/action.md`](../../docs/history/action.md).
