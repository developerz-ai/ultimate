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
| redaction | a cause, `meta` and the `outbound.attempt` log line carry vendor, method, origin and the path's FIRST segment plus the length of the rest (`/services/…(21 chars)`: a webhook keeps its token in the path), never the query or a header. A refusal's body reaches `meta.detail` only as a JSON object, credential-named fields redacted, 200 characters; anything else (a form, an array, HTML, a cut body) is dropped. [`refusal`](#refusal-what-a-non-2xx-body-becomes) declares the fields to keep from the whole body, or drops `meta.detail` |
| breaker | `breaker: breaker({ name, failures, cooldownMs })` from `@ultimat3/core`, recorded once per call after the retries. See below |

## `dial`: which network a URL may reach

Required, a decision per call.

| Value | Use for | What happens |
|---|---|---|
| `'named'` | a host the app names in code or config: a vendor API, a sidecar | dialled as written |
| `'public'` | a URL a tenant or a user supplied | https only outside a local environment, no URL credentials, every address the name answers must be public, the connection pinned to the approved address with `tls.serverName`. Refusal: `X_OUTBOUND_HOST_BLOCKED` |

**Writing your own public-dial guard is the bug this option exists to prevent.** A URL a tenant
supplied (a webhook, an avatar, a feed) is `dial: 'public'`: resolve, classify every address, pin,
re-screen each redirect. All of it is in this one option.

## `proxy`: send the call through an HTTP proxy

| Form | What happens |
|---|---|
| `proxy: 'http://user:pass@proxy:3128'` (or a `URL`) | every hop goes through it: `CONNECT` for `https:`, an absolute-form request for `http:` |
| `proxy: { url, headers }` | the same, `headers` sent on the `CONNECT` (`proxy-authorization: Bearer …`) |
| `proxy: (target) => … \| undefined` | asked once per hop with that hop's NAMED url (never the pinned address); `undefined` dials the hop direct. May be async, and is bounded by `deadlineMs` |

- **Beside `dial: 'public'`, the screen still runs FIRST.** A refused host never reaches the proxy or
  your resolver; an approved one is tunnelled to the screened ADDRESS (`CONNECT 93.184.216.34:443`),
  so the proxy resolves nothing itself. `tls.serverName` survives the tunnel: the certificate is
  still proven against the name (measured on Bun 1.4.4, `outbound-proxy-tunnel.test.ts`).
- **The proxy is the app's own choice**, like a `'named'` host: it is not screened.
- `http:` and `https:` proxies only. Anything else, or a resolver that throws, is
  `X_OUTBOUND_PROXY_INVALID` before a byte, never retried.
- **The proxy's credential is in no cause, log line, span or event**: URL userinfo is cut from a
  transport's message (`//…@`), and the proxy is never recorded.
- With no `proxy`, Bun's own `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` still apply, as for any `fetch`.
- **Which proxy, and rotating them, is app code** (axiom 8): a resolver over your own inventory.
- `proxy: null` dials direct, past the app-wide proxy below.

```ts
import { outbound } from '@ultimat3/core/outbound';

declare const url: string;
const proxies = ['http://u:p@egress-a:3128', 'http://u:p@egress-b:3128'];
let next = 0;
await outbound({
  url,
  vendor: 'feed',
  dial: 'public',
  deadlineMs: 10_000,
  proxy: () => proxies[next++ % proxies.length],
});
```

### The app-wide proxy: `outbound` in `app.config.ts`

A deploy behind an egress gateway declares it once; every `outbound()` call with no `proxy` of its
own goes through it — the framework's senders included (APNs, FCM, Web Push, OAuth, MCP, webhooks,
CDN purge), with no call-site change. `As of 2026-11`.

```ts
import type { EnvSchema } from '@ultimat3/core';
import { defineConfig, defineEnv } from '@ultimat3/core';

export const envSchema = {
  // http(s)://user:pass@egress:3128 — a credential: the environment's, never a literal here.
  EGRESS_PROXY: { type: 'url', required: false, secret: true, description: 'The egress proxy.' },
} satisfies EnvSchema;
export const env = defineEnv(envSchema);

export const config = defineConfig({
  name: 'shop',
  outbound: {
    proxy: env.EGRESS_PROXY,
    direct: ['otel-collector.observability', 'svc.cluster.local'],
  },
});
```

| A call's `proxy` | Goes through |
|---|---|
| unset | `outbound.proxy` — unless the hop's host is loopback or a `direct` host |
| a URL, `{ url, headers }` or a resolver | that, as above: the call's own choice always wins |
| `null` | nothing: direct |

- **Never proxied:** `localhost`, `*.localhost`, a loopback literal, and each `outbound.direct` entry
  with every name under it, per label (`cluster.local` covers `a.svc.cluster.local`, never
  `notcluster.local`). Asked per hop with the NAMED host, so a redirect is judged again.
- `direct` entries are bare host names or IP literals: a scheme, path, port or `*` is
  `X_CONFIG_INVALID`. So is a `proxy` that is not an `http:`/`https:` URL — refused at
  `defineConfig`, the credential never echoed; one installed by hand is still refused per hop
  (`X_OUTBOUND_PROXY_INVALID`).
- **A plain-`http:` target through the proxy is cleartext** — the proxy reads every header, a
  bearer token or a SigV4 signature included. Routing stays as declared; the first use per host logs
  one `ultimate outbound proxy cleartext` warn line (host and port, never the path or the proxy URL)
  whose fix is `defineConfig({ outbound: { direct: ['<host>'] } })`. An in-cluster gateway or MinIO belongs in `direct`.
- Installed by the container boot (`configureOutboundProxy`, `@ultimat3/core/outbound`), released at
  stop; an app never calls it. The boot logs `ultimate outbound proxy` with the URL's userinfo as
  `***`.

Transports that are not `outbound()` ask the same answer through `ambientProxyFor(url)`
(`@ultimat3/core/outbound`) and hand it to Bun's `fetch` as `init.proxy`:

| Transport | Takes `outbound.proxy` |
|---|---|
| `@ultimat3/ai`'s Anthropic and OpenAI-format providers (`baseUrl` included) | yes, same direct-host rule |
| `@ultimat3/storage`'s signed S3 requests: a PUT with metadata, `Cache-Control`, SSE or object lock; ranged and streamed reads; multipart; copies; retention reads | yes, same direct-host rule |
| `@ultimat3/storage`'s plain S3 calls on `Bun.S3Client` (`put`, `get`, `exists`, `delete`, `list`, `stat`) | **no.** `Bun.S3Client` takes no `proxy` option (measured, Bun 1.4.4): it ignores one, and honours only the process-wide `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`. An egress-locked deploy using S3 sets those as well, with `NO_PROXY` naming the `direct` hosts |
| `@ultimat3/mail`'s SMTP driver (`Bun.connect`) | **no**: SMTP, not HTTP |
| `@ultimat3/scraping`'s browser (CDP) | **no**: the session's own `proxy` (`egress`) |
| core's OTLP exporter, the `x` CLI | **no**, on purpose: in-cluster collector, this machine |

## `deps.fetch`: the transport

`outbound(request, { fetch })` swaps the transport, for a test or in production (a client with its
own sockets, an instrumented one). It sits UNDER `outbound()`, so every rule above stays the call's.

| The transport is handed | The transport must |
|---|---|
| the SCREENED url: under `dial: 'public'` the approved address, with `host` and `tls.serverName` naming the name | dial that url, nowhere else |
| `init` with `signal` and `redirect: 'manual'` | pass `init` through; a hop is `outbound()`'s to take (`redirect: 'follow'`) |

- **A transport that followed a redirect itself is refused**: an answer with `redirected: true` is
  `X_OUTBOUND_TRANSPORT_REDIRECTED`, under `redirect: 'error'` and `'follow'` alike — no screen saw
  that hop (`outbound-transport.test.ts`).
- `maxBytes`, `idleMs` and `deadlineMs` cut the body the transport streams, whatever it does.
- **A transport that reaches another address (a tunnel, a relay) takes the screen over**: the app
  proves it, as for a proxy it names.

`screenDial(url, { resolve, allowPrivate })` is the screen alone, for a transport that keeps its own
codes: `@ultimat3/jobs`' webhook target and `@ultimat3/scraping`'s wildcard leg call it.

## Failures

| Code | Retry | When |
|---|---|---|
| `X_OUTBOUND_TIMEOUT` | retryable | `deadlineMs` passed, or the body went quiet for `idleMs` (`meta.phase`) |
| `X_OUTBOUND_UNREACHABLE` | retryable | DNS, connect, TLS or reset: no response |
| `X_OUTBOUND_THROTTLED` | retry-after | a retryable status with `Retry-After` (`meta.retryAfterSeconds`) |
| `X_OUTBOUND_UNAVAILABLE` | retryable | 5xx, 408, 409, 425, 429 with no stated delay (`meta.status`) |
| `X_OUTBOUND_REFUSED` | terminal | any other non-2xx (`meta.status`, `meta.detail`, `meta.fields` under `refusal.schema`) |
| `X_OUTBOUND_TOO_LARGE` | terminal | the body passed `maxBytes` |
| `X_OUTBOUND_HOST_BLOCKED` | terminal | `dial: 'public'` refused an address class, a scheme or a hop |
| `X_OUTBOUND_REDIRECTED` | terminal | a 3xx under `redirect: 'error'`, or more than 5 hops (`meta.location`, no query) |
| `X_OUTBOUND_TRANSPORT_REDIRECTED` | terminal | the transport in `deps.fetch` answered `redirected: true`: it followed a hop itself (`meta.location`, no query) |
| `X_OUTBOUND_RETRY_UNSAFE` | terminal | `retry` on POST or PATCH without `idempotent: true` |
| `X_OUTBOUND_BODY_INVALID` | terminal | `answer.json(schema)` refused the body (`meta.issues`) |
| `X_OUTBOUND_PROXY_INVALID` | terminal | `proxy` is not an `http:`/`https:` URL, or its resolver threw (`meta.reason`, never the URL) |

### `refusal`: what a non-2xx body becomes

`X_OUTBOUND_REFUSED`, `X_OUTBOUND_UNAVAILABLE` and `X_OUTBOUND_THROTTLED` read the body once, per
the call's `refusal`:

| `refusal` | Read | On the error |
|---|---|---|
| unset (default) | chunks until 1,024 characters are decoded, the rest cancelled (a whole chunk is kept, so one large chunk is read whole) | `meta.detail`: a JSON object, credential-named fields redacted, 200 characters; else `''`. A large error object that arrives in pieces is cut, does not parse, and is `''` |
| `{ schema }` | the whole body, up to the call's `maxBytes` | `meta.fields`: the schema's answer, credential-named fields redacted at any depth; absent when the body is not JSON, does not fit or passes `maxBytes`. `meta.detail` is the 200-character excerpt of that whole body |
| `{ detail: false }` | nothing for the excerpt | `meta.detail: ''`: the excerpt, and the free text it carries (an address, a name), never kept. Combines with `schema`; it does not filter `meta.fields`, so a schema keeps only fields that are safe to log |
| `{ headers: ['x-request-id'] }` | the answer's headers; body handling is unchanged | `meta.headers`: a record of lowercased name to value for each asked-for header the answer carries (`{}` when none), each value redacted and cut at 200 characters. Names are case-insensitive, at most 16, each at most 64 characters. A credential-named header (`set-cookie`, `authorization`, `www-authenticate`, `x-api-key` …), an overlong name or a name that is not a header is `X_INVARIANT` at the call, before a byte is sent. Combines with `schema` and `detail`; unset, no header is kept (`As of 2026-11`) |

```ts
import { isUltimateError } from '@ultimat3/core';
import { outbound } from '@ultimat3/core/outbound';
import { t } from '@ultimat3/schema';

declare const url: string;
declare const body: string;

const decline = t.object({ error: t.object({ decline_code: t.string }) });
try {
  await outbound({ url, vendor: 'payments', dial: 'named', deadlineMs: 10_000, method: 'POST',
    body, refusal: { schema: decline, detail: false } });
} catch (error) {
  // meta.fields is unknown on the error: the schema that declared it reads it back typed.
  if (isUltimateError(error) && error.code === 'X_OUTBOUND_REFUSED') {
    console.log(decline.safeParse(error.meta?.['fields']));
  }
}
```

The schema is the whole of what `meta.fields` keeps: undeclared keys never reach it. `meta.detail` is a separate excerpt of the raw body and may still carry an undeclared field (an `error.message` holding an email): set `detail: false` to keep only what the schema declares. With `detail: false` and no schema, the body is not read, including when headers are requested.

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
| `@ultimat3/ai` provider calls | own retry across providers, in-band stream errors; the app-wide proxy still applies (`ambientProxyFor`) |
| core's OTLP exporter, `x` CLI transports | an exporter must not log through itself; the CLI dials this machine |
