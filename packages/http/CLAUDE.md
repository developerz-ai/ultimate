# @ultimat3/http

Owned request lifecycle over `Bun.serve`. Tier 2.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else, ever.
- May NOT import `@ultimat3/policy` or `@ultimat3/entity` — same tier. Authz and auth
  come in via `ServerHooks` (`hooks.ts`), declared structurally.
- `@ultimat3/action` (tier 3) is what wires policy into `hooks.authorize`.

## Rules

- Route `meta.auth` is required. Never default a route to public.
- **A browser that fails `auth: 'required'` is redirected; an agent gets the problem document.**
  One condition, two audiences, decided once in `auth-redirect.ts` and applied in the `error-map`
  stage before the overlay. `config.signInPath` is `null` until an app names its page, because a
  framework that guessed `/signin` would send an app spelling it `/login` to a 404 — strictly
  worse than the JSON. The round trip is `?next=`, and `nextAfterSignIn` is the ONE reader of it:
  anything that is not a same-origin path falls back, or the page that hands out a session
  becomes an open redirect.
- **`meta.enforcedBy` says who evaluates `meta.policy`, and the `authz` stage obeys it.**
  `'pipeline'` (the default, and what a page wants) means the stage decides through
  `hooks.authorize`; `'handler'` means the handler is the one evaluation and the stage returns
  without deciding — no hook required, and none consulted. An action route says `'handler'`
  because `@ultimat3/action`'s `invoke` loads the row a row-level rule reads and this stage
  cannot. Deciding in both places is two authz systems, and the one that answers first is the
  one holding less.
- **`ctx.actor` is never null.** `asCtx` publishes the request context itself as core's `Ctx`,
  and `Ctx.actor` is an `Actor` — so "nobody" is core's anonymous actor, not `null`. The
  `authenticate` hook still says it with `null`; the `auth` stage is where that becomes
  `anonymousActor()`. A null here reaches every `ctx.actor` reader in the framework as a contract
  violation that only shows up on the first unauthenticated request.
- Never add a stage to `PIPELINE_STAGES` without a `why` and a test.
- Statuses live in `error-map.ts` only. No other file writes a status number. The framework's
  table (`ERROR_STATUS`) is closed; an app declares its own codes' statuses with
  `registerErrorStatus()`, which refuses a code the framework already holds. Without that half,
  every app code was 500 and `pipeline.ts` paged the on-call for a wrong password.
- **The context carries the inbound headers, never the `Request`.** `ctx.requestHeaders` is set
  once at construction; `useRequestHeader` / `useRequestCookie` are what app code reads, and
  `UltimateRequest.cookie()` is what `hooks.authenticate` reads. A `Request` on the context is a
  second body reader past the size cap, the content-type parse and the cache.
- **`hooks.authenticate` has one declaration site: `configureAuthenticator()`.** A single value,
  not a list — two answers to "who is this?" is two identities per request. `@ultimat3/auth` is
  the same tier and can never import this package, so the app is what wires them together.
- Never throw a bare `Error` — use a factory from `errors.ts`.
- No `any`. Validation goes through Standard Schema (`validate.ts`), not a vendor API.
- Health endpoints answer outside the pipeline, on purpose.
- **Lifecycle belongs to core.** `server.ts` uses `beginWork()`, `markReady()`,
  `drain()` and `healthzPayload()`/`readyzPayload()`. Never keep a private `state` or
  in-flight counter — core waits on work it does not know about, so a private counter
  hangs every deploy at the `inflight` phase.
- **Borrowed error codes are never titled or registered here.** `X_FORBIDDEN` is policy's,
  `X_UNAUTHENTICATED` is auth's; both sit in `HTTP_BORROWED_ERROR_CODES`, which carries codes
  only. `HTTP_ERROR_TITLES` holds owned codes, and `registerErrorCodes` takes it whole and
  unguarded — declaring a borrowed one throws `X_ERROR_CODE_DUPLICATE` at import, which is the
  point. `factsOf` therefore reads a borrowed code's title off the error itself, never the map.
- Tests must not touch the network — the preload seals `fetch`. Socket tests live in
  `e2e/` and run with `bun test packages/http/e2e`, sealed: `start()` calls core's
  `markListening()`, so the seal treats our own port as self, not egress. Never unseal.

## Files

| File | Job |
|---|---|
| `pipeline.ts` | the ordered lifecycle; the framework's guarantee |
| `router.ts` | trie matcher, precedence static > param > wildcard |
| `error-map.ts` | code → status table + `factsOf()` |
| `hooks.ts` | the two seams: `authenticate`, `authorize` + the app's `configureAuthenticator()` |
| `context.ts` | `RequestContext` + the single `Ctx` adapter (`asCtx`) + the inbound-header readers |
| `redirect.ts` | the intent slot a handler that cannot return a `Response` fills |
| `auth-redirect.ts` | where an unauthenticated browser goes, and where it comes back to |

## Commands

```
bun test packages/http
bun run --filter @ultimat3/http typecheck
```
