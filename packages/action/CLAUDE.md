# @ultimat3/action

Owns the `action` + `mutator` primitives and their six projections. Tier 3.

## Boundary

- May import: `core`, `schema` (t0), `cache`, `i18n`, `time` (t1), `entity`, `policy`, `http` (t2).
  `entity` is a real edge since 21.0.0 (`record-wire.ts` → `hasEntityRows`/`rowsOf`), downward 3→2.
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
| `client.ts` | typed RPC client (browser-safe: no server imports) — dispatches through core's `clientTransport` |
| `record-wire.ts` | the record envelope on the HTTP projection: `carriesRecords` (from the output schema), the enveloped 200, and its OpenAPI shape. Server-only — `client.ts` never imports it |
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

## Invariants — execution and authz

- Every surface goes through `invoke`: parse input, evaluate policy, handle, parse output. A second
  execution path is the one unforgivable change here.
- **An explicit `ctx` is INSTALLED, never merely passed** — the ambient context (which
  `@ultimat3/entity`'s tenant guard reads) must be the identity `guard()` decided about.
  `invoke-context.test.ts` asserts ambient, `options.actor` and `options.ctx` are one caller.
- The declaration never leaves `invoke.ts`: `defOf`/`stashDef` are never re-exported from
  `src/index.ts` (`index.test.ts`). An action has no `.def`; outside, read `.input`/`.output`/
  `.policy`/`.mcp` or `describe()`. App code reaches a projection through the action
  (`publishPost.tool()`); new methods are bound in `facade.ts`.
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
- Registration names the action the app exported, in place. Naming an already-named action is the
  only case that twins.
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
  `audit` off unless declared.
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
- **`rateLimit:` reaches the limiter**: `toRoute` sets `meta.rateLimit` AND `meta.rateLimitBucket`
  (`toBucket`), which `@ultimat3/http`'s `withRouteBuckets` registers. The computed rate must be
  finite and `limit` at least one token.
- **`deprecated:` is a compat WINDOW** — headers on every response including failures, a
  `rel="successor-version"` link via `derivePath`, `deprecated: true` in OpenAPI,
  `deprecated_calls_total`. Rendered ONCE at projection (`X_ACTION_DEPRECATION_INVALID` at mount).
  Twinned in `@ultimat3/query`.
- **The span wraps `execute` whole** (including `def.row()`), with bounded attributes plus the
  namespaced idempotency key (never a metric label). `telemetry.test.ts`.
- **`policyCapability` is a display label; `policyPermissions` (`ActionDescriptor.permissions`) is
  what a report matches on** (a `not()` clause contributes its permissions).
- **MCP exposure reads core's `isMcpExposed`, in all three places** (`toMcpTools`, `describeAction`,
  `x-ultimate.mcpTool`). **A tool's NAME is the export name verbatim everywhere** — `toToolName` is
  deleted; `mcp-tool.test.ts` asserts one verbatim name across surfaces. `ActionFact.mcp` in the app
  manifest carries only `{ expose, description? }`.
- **`ActionJobHandle` is not consumed by `@ultimat3/jobs`** (`isJobHandle` needs `job()`'s private
  map). `.job()` gives `action:<name>` as a queue key, a payload-derived idempotency key and an
  `invoke` under `surface: 'job'`. The bridge is `agentJob()` in `@ultimat3/ai`, or an app's own
  `job({ … })` supplying `tenant` and `retry`.

## Invariants — flight control

- **Flight control is `@ultimat3/core`'s, re-exported** — the same objects `@ultimat3/query`
  exports. Fix the pipeline in `packages/core/src/client-flight.ts`. No new code, curve, fence or
  retry loop here (`bun run flight-copies`).
- **`isTransientFailure` INVERTS `retryDecision`'s unclassified default** (a caller's `AbortError`
  is terminal). Must survive.
- **`ClientFlight` is a TYPE inside `client.ts`, never a value.** Measured,
  `bun build --target=browser --minify`, one entry importing from `@ultimat3/action` — **the ONE
  table for these figures** (`packages/core/CLAUDE.md` points here):

  | Entry | before (HEAD `98d16d84`) | onto `clientTransport` | trace headers moved to core's outbound slot | As of 2026-09-23 |
  |---|---|---|---|---|
  | `rpc` | 18,097 B | 23,007 B | 18,119 B | 19,074 B |
  | `rpc` + `createClientFlight` | 23,903 B | 28,823 B | not measured | 25,197 B |

  Net against the pre-transport figure: +977 B, about the envelope decoder's size.
- **The `sideEffects` array is load-bearing**: `errors.ts` runs `registerErrorCodes` at import. Never `false`.

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
  `settle(key, value, reservationId)` / `fail(key, failure, reservationId)`. A fenced no-op is logged,
  never thrown.
- **A stored status is NARROWED** (`isIdempotencyStatus`; unknown is
  `X_IDEMPOTENCY_STATUS_UNKNOWN`), never cast.
- **Where records live is DECLARED and refused at registration**: `IdempotencyStore.scope` vs
  `configureIdempotency({ scope })`, compared by `assertIdempotencyScope` in `registerAction`
  (`X_IDEMPOTENCY_NOT_SHARED`). Default `'process'`.
- **The memory store is bounded; `in-flight` records are the last evicted.** Never an LRU.
- **`postgresIdempotencyStore` is the shared store** over a structural `PgExecutor` (no `action -> db`
  edge); the reservation is ONE `insert … on conflict` statement. The CLI boot installs it.

## Invariants — cache and audit

- **The post-commit bust never fails the write** — `cache-gate.ts` (the only `invalidateTags` caller)
  absorbs a refusing fan-out and logs through core's `logger`, never rendering the tags. A replay
  skips the bust.
- **The policy contract test asserts `ActionDeniedError` and sends valid input** (`sampleInput` from
  the input IR). Only `X_INPUT_INVALID` (and `X_AUDIT_SINK_MISSING`, the one refusal before the parse)
  becomes `X_CONTRACT_DRIFT`; everything else keeps its own code; a non-`UltimateError` is rethrown.
  `contract-test.contract.test.ts`.
- **The audit seam ships the mechanism and none of the row**: `audit: true` wraps `execute`, so a
  DENIED attempt is recorded. No audit entity, retention, hash chain or "who" convention. The
  vocabulary matches `@ultimat3/admin`'s by name (tier 5, no edge); admin's `AuditSink` is a known
  duplicate that unifying would need core for.
- **The memory sink DROPS** — a ring at `DEFAULT_MAX_AUDIT_RECORDS`, oldest first, counting `dropped`;
  no spelling of "unbounded".
- **A durable sink writes what `audit-input.ts` allows**: input redacted through core's
  `isRedactedKey` (the table `defineEnv({ secret: true })` extends) plus `isSecret` by value, and
  always JSON-representable (named markers, cycle detection; `toJSON` never called).
- **The `Ctx` is never walked**: `postgresAuditSink` reads an allow-list (`requestId`, `traceId`,
  `locale`, `tz`, `buildId`, `role`, actor `id`/`kind`/`orgId`/`onBehalfOf`) and keeps
  `failure.code`, never the error.
- **`x_audit` ships no purge**, deliberately. **`SQL_AUDIT_INSERT` is positional**, pinned by
  `audit-parity.test.ts` with a distinct value per field.
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
