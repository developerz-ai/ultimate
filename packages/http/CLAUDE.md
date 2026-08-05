# @ultimat3/http

Owned request lifecycle over `Bun.serve`. Tier 2.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else, ever.
- May NOT import `@ultimat3/policy` or `@ultimat3/entity` — same tier. Authz and auth
  come in via `ServerHooks` (`hooks.ts`), declared structurally.
- `@ultimat3/action` (tier 3) is what wires policy into `hooks.authorize`.

## Rules

- Route `meta.auth` is required. Never default a route to public.
- Never add a stage to `PIPELINE_STAGES` without a `why` and a test.
- Statuses live in `error-map.ts` only. No other file writes a status number.
- Never throw a bare `Error` — use a factory from `errors.ts`.
- No `any`. Validation goes through Standard Schema (`validate.ts`), not a vendor API.
- Health endpoints answer outside the pipeline, on purpose.
- **Lifecycle belongs to core.** `server.ts` uses `beginWork()`, `markReady()`,
  `drain()` and `healthzPayload()`/`readyzPayload()`. Never keep a private `state` or
  in-flight counter — core waits on work it does not know about, so a private counter
  hangs every deploy at the `inflight` phase.
- **Borrowed error codes are never re-registered.** `X_FORBIDDEN` is policy's,
  `X_UNAUTHENTICATED` is auth's; both are listed in `HTTP_BORROWED_CODES` and filtered
  out of `registerErrorCodes`. Re-declaring throws `X_ERROR_CODE_DUPLICATE` at import.
- Tests must not touch the network — the preload seals `fetch`. Socket tests live in
  `e2e/` and run with `bun test packages/http/e2e`, sealed: `start()` calls core's
  `markListening()`, so the seal treats our own port as self, not egress. Never unseal.

## Files

| File | Job |
|---|---|
| `pipeline.ts` | the ordered lifecycle; the framework's guarantee |
| `router.ts` | trie matcher, precedence static > param > wildcard |
| `error-map.ts` | code → status table + `factsOf()` |
| `hooks.ts` | the two seams: `authenticate`, `authorize` |
| `context.ts` | `RequestContext` + the single `Ctx` adapter (`asCtx`) |

## Commands

```
bun test packages/http
bun run --filter @ultimat3/http typecheck
```
