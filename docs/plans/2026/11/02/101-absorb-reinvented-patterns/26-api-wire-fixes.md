# 26-api-wire-fixes — Four wire defects and one missing fact

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`), 2 (`http`), 3 (`action`).

## Why
Each reproduced by a probe on 2026-11-02 through the real pipeline or client.
| # | Defect | Probe output | Evidence |
|---|---|---|---|
| 1 | a mount's allowance is silently capped by `default` | mount `limit: 100000`, an undeclared read: `ok 120 first refusal at 120 status 429 limit hdr 120` | one adopter, in production: 1,397 refusals in 7 minutes at 28 open runs, against 12,000 a minute declared. It then added `rateLimit:` to each hot read |
| 2 | `Link: rel="successor-version"` on a mount names the cookie door | `POST /v1/...` answers `link=</api/things/new>` | that URL refuses a bearer caller; the successor is on `/v1` |
| 3 | `DEFAULT_CORS` omits what the clients send and read | allow: `content-type, authorization, x-ultimate-build, x-request-id`. Expose: `x-request-id, x-ultimate-build, retry-after`. With `x-ultimate-records` hidden, as a browser hides it, `rpc` returned `{"data":{"id":1},"records":{}}`; visible, `{"id":1}` | a keyed write fails preflight on `idempotency-key`, and a typed call from a listed origin gets the wrong shape. No adopter has listed an origin yet |
| 4 | `requestId` dropped by both clients | a 409 carrying `requestId: req-123` gives `RemoteActionError` with `meta {"origin":"remote","action":"createCase","status":409}` | one adopter's Ruby client and another's SDK contract put it on every error |

The missing fact: the problem document has no retry class. Two adopters carry the same 41-LOC middleware to add `retry: errorRetry(error)`, and neither reaches a 401 or a scope 404, which leave earlier in the pipeline. A client maps that value to an exception.

## Files to change
- `packages/http/src/bearer-mount.ts:215` — `rateLimitedBy: 'handler'` when the mount has a `bucket` and the route names no `meta.rateLimit`.
- `packages/http/src/bearer-mount.ts:216-225` — successor rewrite (step 2).
- `packages/http/src/cors.ts:20-21` — defaults (step 3).
- `packages/action/src/http.ts:40` → `packages/core/src/client-dispatch.ts:22` — `REPLAYED_HEADER` moves beside `IDEMPOTENCY_HEADER`, so `http` can name it; the action barrel stops exporting it if it does today, per `X_HELPER_COPY`.
- `packages/http/src/error-facts.ts:245`, `:352-356` — `ProblemDocument.retry`.
- `packages/http/src/finalize.ts` — the `lastResort` literal gains the member.
- `packages/action/src/openapi.ts:85-116` — `retry` in `PROBLEM_SCHEMA`, as `{ type: 'string', enum: [...] }`.
- `packages/action/src/client.ts:215-233`, `packages/action/src/errors.ts:325-334`, `packages/core/src/client-problem.ts:49` — `meta.requestId` off the body.
- `wiki/Actions.md:93`, `:77` — the allowance replaces `default`; **`rpc` and `queryClient` do not reach a mount**: they derive `/v1/api/...` and answer a valid token 404. A machine caller uses the mount's OpenAPI document.
- `wiki/Error-Codes.md` intro, `packages/http/README.md`, `packages/http/CLAUDE.md` (the bearer and CORS rules), `packages/action/CLAUDE.md`, `packages/core/CLAUDE.md`.

## Steps
1. Allowance: `routeBucketOf` (`packages/http/src/rate-limit-stage.ts:84`) already spends nothing for `rateLimitedBy: 'handler'`. A mount with no `rateLimit` keeps `default`. The tenant allowance stays the stage's.
2. Successor: build `Map<served path, mounted path>` for the cut once. After the inner handler, in a `finally` so an error answer is covered too, read `ctx.headers.get('link')`: in the map, rewrite it; not in the map, delete it, since the caller cannot follow it.
3. CORS defaults, from core's constants and never restated literals. `allowHeaders` adds `IDEMPOTENCY_HEADER`, `REQUEST_TIMEOUT_HEADER`, `traceparent`. `exposeHeaders` adds `RECORDS_HEADER`, `DATES_HEADER`, `REPLAYED_HEADER`, `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `deprecation`, `sunset`, `link`. An app's explicit list still replaces the default (`packages/http/src/config.ts:254`).
4. `retry: errorRetry(error)` on every document, root member like `code`. A hidden 5xx answers the class only: no cause. No `message` alias: `cause` and `detail` already say it.
5. `requestId`: a non-empty string under 128 chars, else absent, set after the server's `meta` so a server key cannot spoof it. Both decoders.

## Error codes
None new. `X_RATE_LIMITED`, `X_CORS_CONFIG_INVALID` unchanged.

## Tests
- `packages/http/src/bearer-mount.test.ts` — 121 calls pass under `limit: 1000`, the 1001st is the mount's 429; with no `rateLimit`, the 121st is `default`'s. A deprecated route: `Link` names `/v1/...`; a successor outside the cut: no `Link`, also on a 403.
- `packages/http/src/cors.test.ts` — every header `clientTransport` sends is allowed, every one it reads is exposed, asserted against core's constants so a new header fails it.
- `packages/action/src/rpc-refusal.test.ts`, `packages/core/src/client-problem.test.ts` — `meta.requestId` carried; a body's `meta.requestId` loses to the root member; an oversized one dropped.
- `packages/action/src/openapi-problem.test.ts` — keeps `toProblem` and the schema member for member, and the new member fails it if only one side changes.
- `packages/http/src/error-facts*.test.ts` — `retry` on a 400, 401, 404, 429 and opaque 500.
- `bun test packages/http/src/bearer-mount.test.ts packages/http/src/cors.test.ts packages/action/src/rpc-refusal.test.ts packages/action/src/openapi-problem.test.ts`.

## Semver
Breaking, one row: the `Problem` schema changes `openapi.json`, so a committed file is stale (`X_MANIFEST_STALE`): run `x manifest`. Land with [`26-api-read-contract.md`](26-api-read-contract.md) so adopters regenerate once. Behaviour, no edit: a token's per-route cap of 120 a minute lifts where the mount declares an allowance. Check the mount's number is the ceiling you meant. A golden test of a whole problem body gains `retry`.

## Done when
- The probes' outputs change: 100,000 calls admitted by a 100,000 allowance, `Link` on `/v1`, `rpc` from a listed origin answers the output, `requestId` on the thrown error.
- Every problem document, 401 and scope 404 included, carries `retry`; both middlewares could be deleted.
- `bun run budget-raises` states any browser byte growth from `packages/core/src/client-problem.ts` in the same diff; the table in `packages/action/CLAUDE.md` updated.
