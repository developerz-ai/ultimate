# Outbound HTTP

**One call to a vendor: `outbound()` from `@ultimat3/core/outbound`.** A server `fetch(` with no
`signal` is a build error in a scaffolded app (the `raw-fetch` guard, `boundaries` step) and in this
repository (`bun run fetch-deadline`, `X_FETCH_UNBOUNDED`). A subpath, never the barrel: core is in
every bundle graph and the dial screen reads `Bun.dns`.

```ts
import { outbound } from '@ultimat3/core/outbound';
import { t } from '@ultimat3/schema';

const Charge = t.object({ id: t.string, status: t.string });

export async function chargeStatus(id: string): Promise<{ id: string; status: string }> {
  const answer = await outbound({
    url: `https://api.vendor.example/v1/charges/${encodeURIComponent(id)}`,
    vendor: 'vendor',
    dial: 'named',
    deadlineMs: 10_000,
    headers: { authorization: 'Bearer <token>' },
  });
  return answer.json(Charge);
}
```

## What every call gets

| Property | Rule |
|---|---|
| deadline | `deadlineMs` bounds the WHOLE call, retries and waits included; each attempt also gets what is left of the ambient request's deadline |
| caller lifetime | the ambient `ctx.signal`, and the call's own `signal`, abort the call and every backoff wait, and the reason reaches you unchanged (`X_DRAINING` stays `X_DRAINING`). A spent ambient deadline is core's `X_TIMEOUT` (`meta.bound: 'caller'`), sent nothing, and counts nothing on a breaker. Inside `runToCompletion(fn, bound)` the request's signal is lifted and the `bound`'s applies: `withIdempotency`'s ceiling ends a hung vendor call |
| retry | through core's `retry()`. GET, HEAD, PUT, DELETE, OPTIONS: 3 attempts, 250 ms base, 5 s max, full jitter. POST and PATCH: one attempt, unless `idempotent: true` (send the vendor's key header). `retry` on an unkeyed write is `X_OUTBOUND_RETRY_UNSAFE`, before a byte |
| `Retry-After` | a retryable status that states a delay waits that delay (clamped by the policy's `max`) |
| body | read under an idle watchdog (`idleMs`, default 30 s) and a byte cap (`maxBytes`, default 16 MiB). `read: 'stream'` hands the body over under both |
| redirects | `redirect: 'error'` by default. `'follow'` takes at most 5 hops and screens EVERY hop after the first as a public dial, `'named'` included; at an origin change only `accept`, `content-type` and `user-agent` travel |
| redaction | a cause, `meta` and the `outbound.attempt` log line carry vendor, method, origin and the path's FIRST segment plus the length of the rest (`/services/…(21 chars)`: a webhook keeps its token in the path), never the query or a header. A refusal's body reaches `meta.detail` only as a JSON object, credential-named fields redacted, 200 characters; anything else (a form, an array, HTML, a cut body) is dropped |
| breaker | `breaker: breaker({ name, failures, cooldownMs })` from `@ultimat3/core`, recorded once per call after the retries. See below |

## `dial`: which network a URL may reach

Required, a decision per call.

| Value | Use for | What happens |
|---|---|---|
| `'named'` | a host the app names in code or config: a vendor API, a sidecar | dialled as written |
| `'public'` | a URL a tenant or a user supplied | https only outside a local environment, no URL credentials, every address the name answers must be public, the connection pinned to the approved address with `tls.serverName`. Refusal: `X_OUTBOUND_HOST_BLOCKED` |

`screenDial(url, { resolve, allowPrivate })` is the screen alone, for a transport that keeps its own
codes: `@ultimat3/jobs`' webhook target and `@ultimat3/scraping`'s wildcard leg call it.

## Failures

| Code | Retry | When |
|---|---|---|
| `X_OUTBOUND_TIMEOUT` | retryable | `deadlineMs` passed, or the body went quiet for `idleMs` (`meta.phase`) |
| `X_OUTBOUND_UNREACHABLE` | retryable | DNS, connect, TLS or reset: no response |
| `X_OUTBOUND_THROTTLED` | retry-after | a retryable status with `Retry-After` (`meta.retryAfterSeconds`) |
| `X_OUTBOUND_UNAVAILABLE` | retryable | 5xx, 408, 409, 425, 429 with no stated delay (`meta.status`) |
| `X_OUTBOUND_REFUSED` | terminal | any other non-2xx (`meta.status`, `meta.detail`) |
| `X_OUTBOUND_TOO_LARGE` | terminal | the body passed `maxBytes` |
| `X_OUTBOUND_HOST_BLOCKED` | terminal | `dial: 'public'` refused an address class, a scheme or a hop |
| `X_OUTBOUND_REDIRECTED` | terminal | a 3xx under `redirect: 'error'`, or more than 5 hops (`meta.location`, no query) |
| `X_OUTBOUND_RETRY_UNSAFE` | terminal | `retry` on POST or PATCH without `idempotent: true` |
| `X_OUTBOUND_BODY_INVALID` | terminal | `answer.json(schema)` refused the body (`meta.issues`) |

**A 401 is `X_OUTBOUND_REFUSED` with `meta.status: 401`.** There is no refresh hook: the app's own
wrapper refreshes its token and calls again. Token storage and single-flight stay the app's.

## `breaker()`: stop paying for a dependency that is down

```ts
import { breaker } from '@ultimat3/core';
import { outbound } from '@ultimat3/core/outbound';

const vendorGate = breaker({ name: 'vendor', failures: 5, cooldownMs: 30_000 });

export const ping = () =>
  outbound({
    url: 'https://api.vendor.example/v1/ping',
    vendor: 'vendor',
    dial: 'named',
    deadlineMs: 5_000,
    breaker: vendorGate,
  });
```

| Rule | |
|---|---|
| states | `closed` → `failures` consecutive failures → `open` → after `cooldownMs`, ONE probe (`half-open`) → success closes, failure reopens |
| a probe that never settles | lapses after `cooldownMs`, so a dead holder cannot wedge it |
| refusal | `X_BREAKER_OPEN` (retry-after, 503), `meta.name`, `meta.retryAfterSeconds` |
| trigger | `classify(error)` answers `'failure' \| 'success' \| 'ignore'`. Default: a `retryable` or `retry-after` code is a failure, `X_ABORTED`/`X_DRAINING` ignore, anything else is the dependency answering |
| tickets | `admit()` answers a ticket or `undefined`; settle with it. Only the probe's own ticket closes or frees a half-open breaker, and an open one ignores a late success |
| under `outbound()` | timeout, unreachable, unavailable and throttled are failures; refused and the rest are answers; a caller's abort gives the probe back and counts nothing |
| scope | per process, by design: each process learns in `failures` calls. A shared row would make the breaker depend on the thing most likely to be slow in an outage |
| metric | `breaker_transitions_total{name,to}` |
| `name` | a bounded label chosen in code, never a tenant or a URL |

Manual use: `const ticket = gate.admit()`, then `succeeded(ticket)`, `failed(ticket)` or `released(ticket)`; or `run(fn)` for all three.
`state()` never consumes a probe.

## Stays raw, on purpose

| Site | Why |
|---|---|
| `@ultimat3/jobs` webhook delivery | the job's signal outlives the drain on purpose, and a 3xx is an answer, never a hop |
| `@ultimat3/scraping`'s HTTP leg | session-bound: browser cookies and a hop chain it owns |
| `@ultimat3/ai` provider calls | own retry across providers, in-band stream errors |
| core's OTLP exporter, `x` CLI transports | an exporter must not log through itself; the CLI dials this machine |
