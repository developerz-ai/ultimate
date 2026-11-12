# @ultimat3/action

Owns the `action` + `mutator` primitives and five projections. Tier 3. The MCP tool is
`@ultimat3/mcp`'s one projection (O-tool, 25.0.0).

## Boundary

- May import: `core`, `schema` (t0), `cache`, `db`, `i18n`, `storage`, `time` (t1), `entity`, `policy`, `http` (t2).
  `entity` through `record-wire.ts`; `db` through **`tx-scope.ts` only**. Full rule: `docs/history/action.md`.
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
| `openapi-complete.ts` | the COMPLETE document (`defineApi({ openapi })`: info, servers, security schemes, 401/429 by the ROUTE's `meta.auth`, a declared `rateLimit` or `meter`) and a bearer mount's own cut |
| `http-path.ts` | where an action is served: the app's `pathStyle` + a per-action `http.path` pin, read lazily by every projection; the pin's `:param` template + `method` (`ACTION_HTTP_METHODS`), `assertPinnedHttp`, `filledRoute`, `pathParametersOf`, `actionHttpPinOf` |
| `path-style-miss.ts` | `explainActionPathMiss` — `@ultimat3/http`'s `hooks.explainMiss`: a POST under the style this app does not serve is `X_CONTRACT_DRIFT` naming the one it does |
| `api-declaration.ts` | `defineApi({ http, openapi })` held process-wide for the boot and `x manifest` |
| `errors-http.ts` | the three HTTP-declaration refusals |
| `error-titles.ts` | every code's title, the one `registerErrorCodes` |
| `client.ts` | typed RPC client (browser-safe: no server imports) — dispatches through core's `clientTransport` |
| `record-wire.ts` | the record envelope on the HTTP projection: `carriesRecords` (from the output schema), the enveloped 200, and its OpenAPI shape. Server-only — `client.ts` never imports it |
| `wire-issues.ts` | the ONE reader of a problem document's `issues` member — an untrusted array back into `@ultimat3/schema`'s `ValidationIssue` shape |
| `action-stream.ts` | `streamingDef`: a `stream`-declaring `handle` (an async generator) DRAINED, each chunk parsed by `stream` (`X_ACTION_STREAM_INVALID`, `errors-stream.ts`); `chunksRead()` |
| `http-stream.ts` | `accept: text/event-stream` → `event: chunk`… then ONE `done` or `error`; a refusal before the handler is the ordinary problem response |
| `audit-subject-target.ts` | `auditSubjectTarget()`: `x_audit` as a subject-erase target — overwrites who acted and the input, never deletes the row |
| `transition.ts` | `transition()`: a MUTATOR factory over one entity column's state machine. Declares no error code — entity's three propagate |
| `upload-flow.ts` | `uploadFlow()`: an ACTION factory, `{ request, confirm }` over storage's `grantUpload` (pending only) and `promoteAttachment`. No code of its own |
| `native-answer.ts`, `action-answer.ts` | `native:` — a form POST's 303 + one-read flash (`useActionAnswer`); HTTP projection only |
| — | opt-in flight control is **`@ultimat3/core`**'s `client-flight.ts` + `client-wire.ts`, imported from core — `src/index.ts` re-exports only the `ClientFlight`/`ClientRetry` types. There is no local copy and must not be one |
| `job-handle.ts` | the `.job()` projection: an action as a queueable payload. **Not** consumed by `@ultimat3/jobs` — see Invariants |
| `contract-test.ts` | assertions `x g action` emits |
| `exercise.ts` | the fourth contract assertion: run loop, verdict, `exerciseContract` |
| `exercise-errors.ts` | the three `X_CONTRACT_*` classes, off-socket |
| `exercise-declarations.ts` | `.contract({ exercise })` takes the app's `defineExercise()` value (structural `ExerciseDeclarations`) and reads the entry by the action's name: one declaration in `apps/web/exercise.ts`, read by the contract step and `x exercise` |
| `declared-errors.ts` | the wrap `invoke` puts around `handle` and `row`, the ONLY judged throws. `errors:` is checked, sorted and frozen at `action()` |
| `declared-errors-contract.ts` | `.contract()`'s source scan |
| `openapi-errors.ts` | core's builder bound to http's status and `problemTypeFor` |
| `idempotency.ts` | the store SEAM: types, the installed-store slot, the scope declaration + `assertIdempotencyScope`, and `withIdempotency` — the replay-or-run gate |
| `loader.ts` | `@ultimat3/action/loader`: `registerAction`/`registerActions` for `x`'s loader and framework fixtures. Never the barrel — `defineApi` is an app's one path (`loader.test.ts`) |
| `adapter.ts` | `@ultimat3/action/adapter`: both stores' installers (each returns a release removing that install alone) + resets, port types, store errors, and `overrideHandler`. Never the barrel |
| `handler-override.ts` | the slot `overrideHandler` writes: a test double where `handle` is, keyed by the stored declaration and read per call by `invoke` (`run`) and, for a stream, by the drain (`action-stream.ts`) — so policy, parse, meter, idempotency and output parse still run on every surface. `@ultimat3/testing`'s `stub()` is its one caller (`handler-override.test.ts`) |
| `idempotency-key.ts` | the namespaced key — action + actor + the caller's key, as one JSON tuple — and the refusal of one that names no request |
| `idempotency-memory.ts` | the process default: bounded, swept, `scope: 'process'` |
| `idempotency-redact.ts` | `restingAnswer` — the copy of an answer a store may keep: core's `isRedactedKey` + `isSecret`, the SAME reference when nothing is redacted |
| `idempotency-postgres.ts` | the SHARED store — one table, one `insert … on conflict` |
| `policy-gate.ts` | **the only** runtime edge to `@ultimat3/policy` (`errors.ts` takes `PrimitiveDenial` and `SurfaceDenial` as types, which erases) |
| `cache-gate.ts` | the post-COMMIT bust — **the only** file that calls `invalidateTags` |
| `tx-scope.ts` | the open transaction — **the only** file that imports `@ultimat3/db` (`tx-scope.test.ts`): `openCommitScope` (the bust), `liveTransaction` (the settle), `completeTransaction`, and `inRolledBackScope`, the exercise's always-rolled-back scope and the memory transaction it opens always |
| `rate-limit-gate.ts` | **the one place** a declared `rateLimit:` is spent (a `limit` resolved per call from `ctx`, through `toBucket`) |
| `meter*.ts`, `errors-meter.ts` | `meter:` — declaration (`meter.ts`), UTC window, store seam + memory + Postgres (`x_meter`), and `meter-gate.ts`, **the one place** it is drawn |
| `request-deadline.ts` | `requestDeadlineMs` — the app's `requestTimeoutMs`, resolved by http's own `defineHttpConfig` |
| `audit.ts` | the audit seam's TYPES, re-exported from `@ultimat3/core` (shared with `query`); the slot (`installAuditSink`, `@ultimat3/core/adapter`) is core's alone |
| `audit-memory.ts` | the process default: a bounded ring that DROPS, and counts what it dropped |
| `audit-postgres.ts` | the DURABLE sink — append-only `x_audit`; one insert per record, or per batch (`groupCommit`) |
| `audit-postgres-row.ts` | a record as its row — the ONE projection both inserts bind |
| `audit-batch.ts` | `batchedAuditSink`: group commit, per-write verdict, flush on drain |
| `audit-input.ts` | what may be written DOWN: an `input` redacted through core's table and made JSON-representable on every path |
| `audit-gate.ts` | **the only** file that calls a sink, and where the two failure policies live |
| `type-pins.ts` | compile-time assertions `tsc` checks — what the erased view projects, and why `client()` is not part of it |
| `naming.ts`, `validate.ts`, `json-schema.ts`, `stable.ts` | pure helpers. `stable.ts` is the DOCUMENT serializer (core's `isJsonObject` is imported from core, never re-exported) — the hash form is `@ultimat3/core`'s `canonicalJson`/`fingerprint` |

## Invariants — execution and authz

- Every surface goes through `invoke`: the policy's actor half (`guardActionBeforeInput`, 403 before the
  parse), parse input, evaluate policy, handle, parse output. A second
  execution path is the one unforgivable change here. A 5xx keeps a bundle only under core's
  `withFailureCapture` (`execute`); off, it runs bare.
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
  `'resource'` stays the default. Full rule: `docs/history/action.md`.
- **The style is stated ONCE, on the server**; a browser reads `<meta name="ultimate-path-style">` through core's `actionPath(name)`. Full rule: `docs/history/action.md`.
- **`Merge` in `define-api.ts` never recurses over the module list.** `client-scale-pins.ts` is the
  build error. Full rule: `docs/history/action.md`.
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
  codes propagate; `from` is REQUIRED (it is the UPDATE's predicate); **the rule's reads are pinned in
  the move** (`transition-observe.ts`). Full rule: `docs/history/action.md`.
- **A lookup table is read with `Object.hasOwn`** (`IRREGULAR` in `naming.ts`).
- **`handlerReached(target)` in `invoke.ts` is a private per-declaration counter, never on the
  barrel.** `exercise.ts` reads it to tell a run that reached `handle` from one stopped before it.
- **The exercise has no bypass.** A coded 5xx, `X_OUTPUT_INVALID` or an uncoded
  throw is `X_CONTRACT_DEFECT`. Full rule: `docs/history/action.md`.

## Invariants — the wire

- **A streaming action is still ONE action through `invoke`** (`StreamAction`, `action({ stream })`):
  `invoke` stores the declaration draining, so MCP, `.job()`, `.as()` and JSON get the RETURN value.
  Only the first draining handler of THE declaration a stream was opened for gets the sink;
  `chunksRead()` is `true` there alone, so a costly chunk is produced only when read.
- **`.stream(input)` is on every typed-client method; the TYPE offers it only where the action
  streams** (`StreamClientMethod`; the `rpc` proxy cannot see a declaration). `POST` through core's
  `clientStream`, never `EventSource`; never retried (`retry` is not an option); a JSON answer is
  the output.

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
  (`formatIssues(issues).join('; ')`, pinned by `validate.test.ts`) and `meta.issues` structured. Full rule: `docs/history/action.md`. **`X_OUTPUT_INVALID` keeps the line alone.**
- **The client keeps the server's code and marks it remote** (`RemoteActionError`, `meta.origin:
  'remote'`), only for an `X_SCREAMING_SNAKE` code. It never synthesizes a docs URL. Full rule: `docs/history/action.md`.
- **Both clients inject `traceparent`** before the caller's headers; an incomplete span sends nothing.
- `serializeOpenApi` output is byte-stable: sorted keys, sorted registry, no clock. `client.ts` stays
  free of server imports.
- **`stable.ts` holds the DOCUMENT form only** (`stableStringify`, exported: `openapi.json`,
  `json-schema.ts`, mcp's `tools.lock.json`, testing's cassettes — no other serializer). The HASH form is core's `canonicalJson`/`fingerprint` (injective: tags
  `NaN`/`±Infinity`/`-0`, `Date`, `Map`, `Set`); `stable.test.ts` pins byte-equality for ordinary
  payloads.
- **`tagKeys` is `@ultimat3/cache`'s and `toBucket` is `@ultimat3/http`'s** (imported, never
  re-exported; `toBucket` raises `X_RATE_LIMIT_INVALID`). Never restore a local copy.
- **`rateLimit:` is spent ONCE, inside `invoke`** (`rate-limit-gate.ts`), so HTTP, MCP, the agent tool and `.job()` share one bucket; `surface: 'server'` spends nothing. Full rule: `docs/history/action.md`.
- **`meter:` is drawn ONCE, inside `invoke`, on every surface (`server` too)**, after the policy, before `handle`; under a key only in `beforeRun`, so a replay draws nothing. One conditional increment, never read-then-write. Periods are UTC. `meter-surfaces.test.ts`. Subject: org, else actor, else `job:unattributed` inside a job frame (`inJobFrame()`, `rate-limit-gate.ts` — the limiter's split, one answer), else `anonymous`. `meter-memory.ts` evicts a counter whose period ENDED before a live one, then oldest start.
- **`deprecated:` is a compat WINDOW**, rendered ONCE at projection
  (`X_ACTION_DEPRECATION_INVALID`); twinned in `@ultimat3/query`. Full rule: `docs/history/action.md`.
- **The span wraps `execute` whole** (including `def.row()`), with bounded attributes plus the
  namespaced idempotency key (never a metric label). `telemetry.test.ts`.
- **`policyCapability` is a display label; `policyPermissions` (`ActionDescriptor.permissions`) is
  what a report matches on**; both `@ultimat3/policy`'s.
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
- **`ClientFlight` is a TYPE inside `client.ts`, never a value.** Measured,
  `bun build --target=browser --minify`, one entry importing from `@ultimat3/action` — **the ONE
  table for these figures** (`packages/core/CLAUDE.md` points here):

  | Entry | `As of 2026-11-09`, Bun 1.4.4, one entry over the working tree |
  |---|---|
  | `rpc` | 24,473 B, pinned ≤ 25,000 (`client-bundle.test.ts`); 29,972 B while it read core's barrel |
  | `rpc` + `clientFlight` from `@ultimat3/core/page` | 32,929 B (38,416 B from the barrel) |

- `isTransientFailure`'s inversion, the client graph's import rule, `sideEffects`: still rules, in
  `docs/history/action-client-graph.md` (moved 2026-11-09).

## Invariants — idempotency

- **Everything `withIdempotency`'s `run` throws is treated as possibly-committed**: the reservation
  is SETTLED as a failure and a retry replays it; `release()` is only for a pre-handler failure. A
  `settle` that refuses leaves the record in flight. `idempotency-failure.test.ts`.
- **A keyed run is owed its end**: `completeTransaction()`, then `runToCompletion(run)` under `idempotencyCeilingMs()` (`X_IDEMPOTENCY_RUN_CEILING`); `invoke` reads the handler's `ctx` inside it. `idempotency-orphan.test.ts`.
- **Both stores FENCE a settlement on the reservation `id` AND `in-flight`**:
  `settle(key, value, reservationId, redacted)` / `fail(key, failure, reservationId)` /
  `release(key, reservationId)`. A fenced no-op is never thrown; an autocommit `settle`/`fail` logs `action.idempotency.settlement-fenced` on BOTH stores (`idempotency-memory-fenced.test.ts`).
- **An answer rests REDACTED** (#591): `withIdempotency` passes the store `restingAnswer(value)`
  (core's `isRedactedKey` + `isSecret`) and `redacted` as `settle`'s REQUIRED 4th argument. A
  flagged replay is `X_IDEMPOTENT_REPLAY_REDACTED`, by the FLAG, never by scanning. Full rule: `docs/history/action.md`.
- **A finished record skips the row half; a stale peek judges it in `beforeRun`** (`idempotency-row.test.ts`). **A `bigint` answer settles failed** (`X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE`).
- **Caller keying, the write-origin label, status narrowing, declared scope, eviction order, the shared store**: `docs/history/action.md#idempotency-invariants-moved-from-claudemd`.
- **Inside a transaction the SETTLE commits with the write, on BOTH stores** (`liveTransaction()`). `idempotencyStoreConformance` (`@ultimat3/testing/conformance`). Full rule: `docs/history/action.md`.
- **The deadline is `reclaimAfterMs: () => number`, REQUIRED on the Postgres store** and read per
  reservation (`requestDeadlineMs`, never a number here); `origin: () => object` is required too. Full rule: `docs/history/action.md`.

## Invariants — cache and audit

- **The post-commit bust never fails the write** — `cache-gate.ts` (the only `invalidateTags` caller)
  absorbs a refusing fan-out and logs through core's `logger`, never rendering the tags. A replay
  skips the bust. **A started handler busts, thrown or not.**
- **The bust waits for the ROOT commit** when a transaction is open (`openCommitScope().onCommit`):
  dropped on rollback, never fired before the rows are durable. Full rule: `docs/history/action.md`.
- **The OpenAPI contract assertion reads the registry-wide document** and compares `operationId`
  — one built from the action alone could not fail. **`Problem` is `toProblem`'s members**, no
  `code` pattern (`openapi-problem.test.ts`), checked both ways; `retry` is an enum of core's `ERROR_RETRY_KINDS`.
- **The policy contract test asserts `ActionDeniedError` and sends valid input** (`sampleInput` from
  the input IR). Full rule: `docs/history/action.md`.
- **The audit seam ships the mechanism and none of the row**: `audit: true` wraps `execute`, so a
  DENIED attempt is recorded. No audit entity, retention, hash chain or "who" convention. Full rule: `docs/history/action.md`.
- **`invoke` masks `trace.input` with `maskSensitive(def.input, …, REDACTED)` only when `audit: true`**;
  `registerAction` calls `assertNoSensitiveOutput` on `output`. `wire-issues.ts` and
  `PROBLEM_SCHEMA` carry `rule` and `params` (the four members stay `required`).
- **A durable sink writes what `audit-input.ts` allows**. Full rule: `docs/history/action.md`.
- **The `Ctx` is never walked**: `postgresAuditSink` reads an allow-list (`requestId`, `traceId`,
  `locale`, `tz`, `buildId`, `role`, actor `id`/`kind`/`orgId`/`onBehalfOf`) and keeps
  `failure.code`, never the error.
- **`x_audit` ships no purge**, deliberately. **`SQL_AUDIT_INSERT` is positional**, pinned by
  `audit-postgres-columns.test.ts` (a distinct value per field) and `auditSinkConformance` live. Only `*_TABLE` DDL is exported
  (`X_SQL_EXPORT_UNREAD`).
- **The two failure policies are opposites**: `X_AUDIT_SINK_MISSING` before the input parse; a sink refusing an ALLOWED record is `X_AUDIT_SINK_FAILED`; refusing a denied or failed one is logged. Full rule: `docs/history/action.md`.
- **`auditSettled` sits outside the `catch`**, and **`auditOutcomeFor` is TOTAL** (fails closed to
  `failed`); `audit.test.ts` asserts the caller's throwable by identity.

## Commands

```
bun test ./packages/action/
bun run typecheck
```

Why each rule above is shaped the way it is: [`docs/history/action.md`](../../docs/history/action.md).
