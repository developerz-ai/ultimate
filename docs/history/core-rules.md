# core: rule text moved out of `packages/core/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file toward a 20 KB working target (the
enforced ceiling is 24,576 B, `bun run scripts/claude-md-size.ts`). Each section below is a table
cell or bullet as it stood, verbatim; the package file keeps a short form marked `†`. Where the two
disagree, `packages/core/CLAUDE.md` wins. Older long forms: [`core.md`](core.md),
[`core-moved-2026-11-09.md`](core-moved-2026-11-09.md).

## Exports

explicit in `src/index.ts`; no `export *`. SIX public subpaths (`./adapter`, `./page`, `./outbound`, `./redis`, `./render-node`, `./render-nodes`), one INTERNAL (`./internal/error-status`); nothing that loads a titles table joins `./page` (`page-bundle.test.ts`; the rule read "constructs an error" until `UltimateError` joined in plan 101 K6). `./page` is what a browser client imports — `@ultimat3/action`'s `client.ts` and error modules read it, never the barrel, and so does an app's errors module: `defineError` is on `./page` (`define-error-bytes.test.ts`, 6,507 B for one declaration thrown against 12,019 B through the barrel) and the scaffold's `error-declared` guard refuses the barrel import; the barrel itself must build for a browser with no warning (no static `node:` import a polyfill lacks — `image/png-pixels.ts` resolves `node:zlib` at the call). Full rule: `docs/history/core.md`

## Errors

never `throw new Error`. A FRAMEWORK code: `bun run new-error-code` (a class, `CORE_CODE_TITLES` or the package's `errors.ts`, a `--status`/`--off-socket` decision, a wiki row). An APP code: `defineError()` (`define-error.ts`), which registers title, status and retry in one call and needs no wiki row; its own module, so an `UltimateError`-only chunk never retains it (`define-error-bytes.test.ts`)

## how long to wait, and whether to wait at all

`backoff.ts` + `retry-loop.ts` + `retry.ts` | one curve, one loop (no context, for `client-flight.ts`), one executor over it that reads the ambient signal and deadline: the ONE place a loop meets its caller's lifetime, `runToCompletion` the one way out; `jitter` is REQUIRED on a retry policy and defaults to `none` on the arithmetic. `attempt` is 1-based

## the above, composed into one typed-client call

`client-flight.ts` + `client-wire.ts` | shared by `@ultimat3/action` and `@ultimat3/query` (both tier 3), re-exported by both. Declares no code of its own. A gate slot per ATTEMPT; the wait holds none, ends on `bump()` or the caller's abort

## the browser's one HTTP function, records envelope, per-tab handle and principal fence

`client-transport.ts`, `client-dispatch.ts`, `client-problem.ts`, `client-retry-after.ts`, `client-paths.ts`, `record-envelope.ts`, `record-sink.ts`, `client-scope.ts` | `pageClient()` is the ONE `globalThis` write (`Symbol.for('ultimate.client')`); `clientTransport` never value-imports `clientFlight` or `traceHeaders()` (the OUTBOUND SLOT, `outbound-headers.ts`). A write never dedupes. Full rule: `docs/history/core.md`

## a write's public name

`write-digest.ts` (`writeDigest`, `isWriteDigest`, also on `./page`) + `write-origin.ts` (`withWriteOrigin`, `currentWriteOrigin`, `WRITE_ORIGIN_WAL_PREFIX`, server-only) | SHA-256 of an idempotency key, 32 hex; carried action → entity → WAL → realtime `records` frame. A malformed value runs the work unnamed: a label, never a gate

## one outbound HTTP call

`outbound.ts` + `outbound-attempt.ts` / `-hops.ts` / `-read.ts` / `-dial.ts` / `-errors.ts` / `-types.ts`, entry `outbound-subpath.ts` | never on the barrel (`outbound-subpath.test.ts`). `retry()` owns the clamp to `ctx`, so no second clamp. Its ten codes register their retry class in `outbound-errors.ts`, NOT `error-retry.ts`'s table, which rides every page. `screenDial` holds the framework's one `Bun.dns.lookup`

## what an element carries, for a test

`render-nodes.ts` (`renderNodes`, `nodesOf`, selectors) + `render-node.ts` (`JSX_NODE`, `ISLAND_NODE`, `HOLE_NODE`) | the one walker: `ui`, `admin` and apps import the subpath, never a copy. Islands and holes are branded ARRAYS, tested before `Array.isArray`; a hole is walked as `fallback` and `error`, never its deferred `children`

## an `Intl` formatter cache, and the screen in front of it

`intl-cache.ts` (`cachedFormatter`, `canonicalLocale`, `assertLocale`, `MAX_CACHED_FORMATTERS`, `MAX_LOCALE_EXCERPT`) | a locale arrives from a header: refuse a non-tag (`X_LOCALE_INVALID`), key canonically AND bound the cache — never a copy of any of the three.

## the ONE keyed hash

`hmac.ts` (`hmac(alg, key, data, encoding?)`) | `node:crypto`'s `createHmac`: a keyed `Bun.CryptoHasher` throws a stale failed-EC-import error (Bun 1.4.4). `bun run keyed-hasher` (`X_KEYED_HASHER`)

## One `AsyncLocalStorage`

- **`async-context.ts` is the framework's ONE `AsyncLocalStorage`.** Construction is deferred to
  the first `get()`/`run()`, so a browser bundle can evaluate the module; reads degrade to
  `undefined`, writes throw `X_ASYNC_CONTEXT_UNAVAILABLE`. `scripts/async-context-guard.ts` refuses a
  `new AsyncLocalStorage` or an import of the class anywhere else; `scripts/browser-barrel.test.ts`
  covers `await import('node:async_hooks')`.

## `singleLine`

- **`singleLine` keeps the 3-line contract to three lines, applied in the CONSTRUCTOR** so every
  door (`format()`, `.message`, `.cause`, `toJSON()`) is covered once. It touches only C0 controls
  and DEL — a cause keeps its quotes and backslashes. `@ultimat3/schema` carries a deliberate
  duplicate, pinned by `single-line-pin.test.ts` HERE, with `ERROR_DOCS_URL`. The brand symbol is
  NOT a copy: `ULTIMATE_ERROR_BRAND` is schema's one declaration, imported by `errors.ts`.

## The flight layer

- **The flight layer** (`backoff.ts`, `retry-loop.ts`, `retry.ts`, `single-flight.ts`, `flight-gate.ts`,
  `generation-fence.ts`, `retryable-status.ts`, `client-flight.ts`, `client-wire.ts`) imports
  nothing but this package, runs nothing at import, and injects every source of non-determinism
  (roll, sleep, clock, timer). `classifyThrown` / `statedDelayMs` live beside `error-retry.ts`'s table.

## `canonicalJson`

- **`canonical-json.ts`: `canonicalJson` is INJECTIVE and `fingerprint` is SHA-256/16 of it** — the
  hash every in-memory sharing key is taken over (`query`'s `queryHash`, `realtime`'s `qid`).
  `NaN`, `±Infinity` and `-0` are bare tokens; `Date`, `Map` and `Set` are TAGGED. Never a
  fourth copy, never parseable (`@ultimat3/action`'s `stableStringify` is the document form).

## `isMcpExposed`

- **`mcp-exposure.ts`'s `isMcpExposed` is the ONE answer to "did this opt into MCP?"**, read by
  `action`, `query`, `mcp`, `ai`, `manifest`. `@ultimat3/cli`'s `mcp-exposure-pin.test.ts` checks
  it; `isAgentOffered` adds `agents: true`; `@ultimat3/admin`'s own catalog is the one opt-OUT exception (`mcp-tools.ts`).

## Whether that value TRAVELS

`isFixShellSafe(value)`, the predicate `renderFixShellArg` is built on. A placeholder is not a runnable command, so a `fix:` whose value sits mid-command asks this first and emits PROSE when the answer is no (`@ultimat3/auth`'s `jwks.ts`, `@ultimat3/scraping`'s `profileLocked`)

## ONE sealed value

`seal.ts` (`seal`, `open`, `openText`, `sealAll`) + `seal-keys.ts` (the ring) + `seal-errors.ts` | the framework's one AES call above the envelope: `entity`'s sealed column and `scraping`'s stored session call it, never WebCrypto. `purpose` is required and is AAD

## a session's loss, an island's poll

`session-lost.ts` (`noteRefusal`, called by `client-dispatch.ts`; a cell on the page handle, cleared by `rescope()`), `visible-interval.ts` (the ONE poll an island takes) | both on `./page`, pinned by `page-bundle.test.ts`

## how long this request has left

`request-budget.ts` (`Ctx.deadlineAt`, `REQUEST_TIMEOUT_HEADER`) | `@ultimat3/http`'s `startDeadline` is the one writer of the instant; `traceHeaders()` the one writer of the header. A spent budget sends nothing, never `0`

## where a visitor's light/dark choice is stored

`theme-storage.ts` (`THEME_STORAGE_KEY`, also on `./page`) | render's boot script reads it, ui's toggle writes it — both tier 4, so the one literal lives here. Persisted in browsers: never respelled
