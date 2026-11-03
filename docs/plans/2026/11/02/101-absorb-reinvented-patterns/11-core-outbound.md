# 11 — One outbound HTTP call

> Part of [`overview.md`](overview.md). Depends on: [`03-core-lifetime-helpers.md`](03-core-lifetime-helpers.md). Tier: 0 (`core`), adopters at 1–4, guard in 5 (`cli`).

## Why
Three adopters built the same client (one measured 349 LOC core plus per-vendor copies, one ~850 LOC; another repository counted 13 sleep, 17 retry and 11 deadline copies), and agree on every property: failure classes, safe-only retry, deadlines, capped bodies, `Retry-After`, redacted causes. Two more wrote SSRF pinning (371, 356 LOC) that the framework already holds twice, privately.
Reproduced over raw `fetch` and core's parts: stalled body with a header-only deadline `still-reading-after-300ms`; `retry()` over a 503 ran `calls 1 status 503` (no throw, no retry); `retry()` on an unclassified throw from a POST ran `attempts 3` (unsafe write replayed); a default redirect from a screened name reached loopback (`secret-inner`). A signal on the call does abort a body read (99 ms), so the mechanism is sound and only unassembled.

## Decisions
| Question | Answer |
|---|---|
| Name, tier | `outbound()` in `core`, the only tier `cache` (1), `auth` (2), `jobs` (3), `mail`, `ai`, `pwa` (4) can all reach |
| Import path | `@ultimat3/core/outbound` only, never the barrel: `core` is in every bundle graph and this reads `Bun.dns` (axiom 6). Precedent `core/package.json:22` `./page` |
| SSRF-vetted fetch | not a second function: `dial: 'public'`. `dial` is required, as `jitter` is on `RetryPolicy` (`core/src/retry.ts:30`): which network a URL may reach is a decision per call |
| OAuth refresh | no hook. A 401 arrives as `X_OUTBOUND_REFUSED` with `meta.status`; the app's wrapper refreshes and calls again (axiom 8). Token storage and single-flight stay the app's |
| Circuit breaker | `breaker` option, see [`39-core-breaker.md`](39-core-breaker.md) |
| Caller lifetime | one place: 03's `retry()` clamps to `ctx`. `outbound()` adds no second clamp |
| Raw `fetch` | `outbound()` is the documented way. A server `fetch(` without a signal is a build error (guard below). With a signal it stays legal: a guard cannot prove the other properties, and a blanket ban would refuse the framework-internal cases in the table below |
| `scraping/src/pinned-host.ts` | stops holding the screen. `dialTarget` (`:42`) and `jobs/src/webhook-target.ts:51` both call core's `screenDial`, and keep their own transport and codes (`X_SCRAPE_HOST_BLOCKED`, `X_WEBHOOK_ENDPOINT_INVALID`: stable) |

Stays raw, on purpose:
| Site | Why |
|---|---|
| `jobs/src/webhook-attempt.ts:163`, its default transport `jobs/src/webhook.ts:197` | request signal outlives the drain, and a 3xx is an answer, never a hop |
| `scraping/src/http.ts` | session-bound: browser cookies, hop-by-hop chain it owns |
| `ai` provider handshakes | owns its own retry across providers (`ai/src/gateway.ts`), reads in-band stream errors |
| `core/src/otlp.ts`, `cli` transports | exporter must not log through itself; `cli` dials this machine |

## Files to change
- `packages/core/src/outbound.ts` (new) — the call: signal, retry loop, classification, logging.
- `packages/core/src/outbound-read.ts` (new) — capped read with an idle watchdog, over `read-capped.ts:18`.
- `packages/core/src/outbound-dial.ts` (new) — `screenDial`: resolve, classify every address, pin; hop re-screen.
- `packages/core/src/outbound-errors.ts` (new), `error-retry.ts:33` — the codes and their retry classes.
- `packages/core/src/deadline-signal.ts` (moved from `scraping/src/deadline-signal.ts`) — undoable composition; scraping imports it.
- `packages/core/package.json:20` — `./outbound` export.
- `packages/jobs/src/webhook-target.ts:51`, `packages/scraping/src/pinned-host.ts:42` — call `screenDial`.
- Adopt, each keeping its existing code by mapping the failure: `cache/src/purge-http.ts`, `mail/src/driver-resend.ts`, `mail/src/driver-ses.ts:136` (signed POST with no idempotency header, so one attempt), `mail/src/ses-event-receiver.ts:58`, `pwa/src/push-send.ts`, `ai/src/remote-embedder.ts:123`, `auth/src/oauth-exchange.ts`, `oauth-profile.ts`, `oauth-discovery.ts`, `jwks.ts`.
- `packages/http/src/errors.ts:412` — `requestTimedOut`'s fix: only the fetch clause changes, to name `outbound()`. 02 rewords the rest of that string; whichever lands second merges.
- `packages/core/src/context.ts:342` — `throwIfAborted`'s fix names `outbound()` instead of `fetch(url, { signal })`.
- `packages/cli/src/templates/guard-raw-fetch.ts` (new), `scaffold-guards.ts:48` — the shipped guard.
- `scripts/fetch-deadline.ts` (new), `scripts/lib/fetch-deadline-pins.ts` (new) — the repository's own ratchet, modelled on `scripts/spawn-timeout.ts`.
- `wiki/Outbound-HTTP.md` (new), `wiki/_Sidebar.md`, `wiki/Home.md`, `wiki/Jobs-And-Workflows.md:382` (name it beside `ctx.signal`), `packages/core/README.md`, `CLAUDE.md`, `llms.txt`. No `examples/dummy` use: a helper, not a primitive.

## Steps
1. `bun run new-error-code` for each code below.
2. `outbound(request, deps?)`. Request: `url`, `vendor` (log and cause label), `dial: 'named' | 'public'`, `deadlineMs`, optional `method`, `headers`, `body`, `idleMs` (default 30 s), `maxBytes` (default 16 MiB), `redirect: 'error' | 'follow'` (default `'error'`), `retry`, `idempotent: true`, `read: 'bytes' | 'stream'`. `deps`: `fetch`, `resolve`, `sleep`, `now`, `random`, the same "just the call" seam as `MailFetch`.
3. Answer: `{ status, headers, bytes, text(), json(schema) }`, 2xx only; `read: 'stream'` gives `stream` under the same watchdog.
4. Signal: `deadlineMs` is the whole call, retries and waits included, passed as `timeBudgetMs` to 03's `retry()`, which owns the clamp to `ctx` and the stop on a dead caller; `outbound()` has no second implementation. Each attempt's fetch gets `deadlineSignal` over what is left of `deadlineMs` and 03's `remainingBudgetMs(ctx)`, composed with `ctx.signal`. A context abort surfaces its reason unchanged, so `X_DRAINING` keeps its meaning. Inside `runToCompletion`, the fresh signal and absent deadline make this just work.
5. Retry through 03's `retry()` (`core/src/retry.ts:133`). Default for GET, HEAD, PUT, DELETE: 3 attempts, 250 ms base, 5 s max, `jitter: 'full'`. POST and PATCH: one attempt unless `idempotent: true`; a `retry` on one without it refuses at the call. Delay from `retryAfterSecondsOf` (`client-retry-after.ts:22`) through `statedDelayMs`, already honoured by `retryDecision`.
6. `dial: 'public'`: https outside local, no URL credentials, every address public, connection pinned with `tls.serverName`, `redirect: 'follow'` re-screens each hop (max 5) and drops `authorization` and `cookie` cross-origin (`scraping/src/http.ts:199`).
7. Redaction: causes and the `outbound.attempt` log carry `vendor`, method, origin and path, never query or headers. A failure's body is capped at 200 characters, through `redactKeys`, in `meta.detail`.
8. Guard `raw-fetch`: `{apps,packages}/**/*.{ts,tsx}`, not tests, not `*.island.tsx`. A bare or `globalThis.` `fetch(` whose own options lack `signal`, using the top-level check at `scripts/spawn-timeout.ts:40`. An injected `deps.fetch(` is out of its scope. Row in `SHIPPED`; `x doctor` then lists it for existing apps.
9. Adopt the listed sites one commit each, existing tests unchanged except what the wider retry table now retries.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_OUTBOUND_TIMEOUT` (retryable, 504) | deadline or idle gap passed | raise `deadlineMs` or `idleMs` on the named vendor's call |
| `X_OUTBOUND_UNREACHABLE` (retryable, 503) | DNS, connect, TLS or reset, no response | check the vendor status and the egress rule, then re-run |
| `X_OUTBOUND_THROTTLED` (retry-after, 503) | retryable status naming `Retry-After` | wait `meta.retryAfterSeconds`, or lower the call rate |
| `X_OUTBOUND_UNAVAILABLE` (retryable, 502) | `isRetryableStatus` with no stated delay | the vendor's fault: re-run; `meta.status` names it |
| `X_OUTBOUND_REFUSED` (terminal, 502) | any other non-2xx | fix the request or credential; `meta.status`, `meta.detail` |
| `X_OUTBOUND_TOO_LARGE` (terminal, 502) | body passed `maxBytes` | raise `maxBytes`, or `read: 'stream'` |
| `X_OUTBOUND_HOST_BLOCKED` (terminal, 400) | `dial: 'public'` refused an address class, or a hop | use a public https URL, or `dial: 'named'` for a host the app itself names |
| `X_OUTBOUND_REDIRECTED` (terminal, 502) | 3xx under `redirect: 'error'` | call the final URL, or `redirect: 'follow'` |
| `X_OUTBOUND_RETRY_UNSAFE` (terminal, off-socket) | `retry` on POST or PATCH without `idempotent` | add `idempotent: true` with the vendor's key header, or drop `retry` |
| `X_OUTBOUND_BODY_INVALID` (terminal, 502) | `json(schema)` refused the answer | fix the schema, or ask the vendor |
| `X_FETCH_UNBOUNDED` (off-socket) | repository ratchet: new shipped `fetch(` without a signal | `outbound()`, or a pin with its sentence |

## Tests
- `packages/core/src/outbound.test.ts` (unit, `Response` streams, no socket): each probe above as a failing-first case; stalled and trickling bodies, cap mid-chunk, POST never replayed, 503 retried then `X_OUTBOUND_UNAVAILABLE`, stated delay used, query absent from every cause, context abort reason unchanged.
- `packages/core/src/outbound-dial.test.ts` (unit, injected `resolve`): one private address among public refuses; hop re-screened; literal address classified. Both old refusal suites in `jobs` and `scraping` stay green unchanged.
- `packages/core/src/outbound-pin.live.test.ts`: certificate verified against the name, modelled on `jobs/src/webhook-pin-tls.live.test.ts`.
- `packages/cli/src/templates/guard-raw-fetch.test.ts`: bare, `globalThis.`, nested `{ env: { signal } }` refused; `{ signal }` and island accepted.
- `packages/core/src/outbound-subpath.test.ts`: the barrel exports no `outbound` and no `screenDial`. `bun test packages/core/src/outbound.test.ts`.

## Semver
minor. New subpath, new codes, new guard for new scaffolds; existing apps see it only as a `x doctor` line. Migrated drivers keep their codes. Retried statuses widen on adopted sites, stated in `CHANGELOG.md`.

## Done when
- The four probe outcomes are pinned as tests that fail on raw `fetch` and pass on `outbound()`.
- `grep -rn "Bun.dns.lookup" packages/*/src` outside `core/src/outbound-dial.ts` and tests answers nothing.
- A scaffolded app with `await fetch(url)` in `apps/web/app` fails `x verify` at `boundaries`.
- `bun run verify` green; `scaffold-smoke` green twice per shape.
