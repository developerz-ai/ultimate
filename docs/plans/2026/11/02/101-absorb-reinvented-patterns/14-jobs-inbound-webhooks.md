# 14 — Inbound webhooks

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`jobs`), 2 (`http`).

## Why
Two adopters built this two ways (7 public actions + 293 LOC; one raw route, ~950 LOC over 10 vendors) and agree on the mechanism: verify exact bytes, enqueue durably, ack fast, redelivery does not double-process. They differ only on the door, and the framework documents both doors: `wiki/Actions.md:106-114` (pinned action) and `wiki/Mail.md:100-102` (plain route).
Reproduced, a pinned action through the real pipeline: `{"a":1}` answered 400 and `{not json` 422 with `handlerRan:false`, so the schema answers before the signature is checked and a vendor's shape change becomes a refusal; `application/xml`, `application/octet-stream` and no content type all 422 `X_BODY_INVALID`, handler never reached; `http.path: '/hooks/:id'` `X_ACTION_HTTP_PATH_INVALID`. The raw-route adopter needed exactly these: path tokens per credential and a GET handshake. Raw bytes are not the gap: `useRequestBodyBytes()` (`http/src/context.ts:315`) works.
Jobs half reproduced: a live redelivery answered `deduped:true`; a redelivery after the job settled enqueued again and `runs of one event -> 2`, as `wiki/Jobs-And-Workflows.md:122` states.

## Decisions
| Question | Answer |
|---|---|
| Which primitive | `job`. `webhookReceiver()` is a factory over `job()`, the twin of `webhook()` (`jobs/src/webhook.ts:190`), with its own `PRIMITIVE_FACTORIES` row |
| Which door | a plain `Route` for `runtime.routes` (`cli/src/runtime-overrides.ts:71`): the wire format is the vendor's. No new route shape, `api/` unchanged |
| Pinned action door | stays legal and unbroken; it is how a signed upload reads bytes. Docs stop presenting it for webhooks. Nothing can tell the two apart at build time, so there is no guard: the factory is simply the shorter path |
| Dedupe | key = `eventId`, live window from the queue. After that `handle` is at-least-once and receives `eventId`; the seen-set and its retention are the app's table, as `http/src/webhook-verify.ts:111` already says. No seam: a claim before enqueue loses the event if the enqueue fails |
| Vendor verifiers | none ship (axiom 8). One helper, `verifyBodyHmac`, plus any plain function. Vendor schemas stay the app's |
| `mail/events` receivers | unchanged; `verify` can call `receiver.receive(inbound.request())` |

## Files to change
- `packages/jobs/src/webhook-receiver.ts` (new) — the factory; declaration and job body.
- `packages/jobs/src/webhook-receiver-route.ts` (new) — the handler: bytes, verify, enqueue, ack.
- `packages/jobs/src/index.ts`, `packages/jobs/package.json:36` — export; a new runtime dependency on `@ultimat3/http`, because `DEFAULT_WEBHOOK_BODY_LIMIT` (`http/src/webhook-verify.ts:63`) is a value and `Route` a type. Tier 3 → 2 is legal, `http` imports no `jobs`, and no `FLOOR_ABOVE` row changes. The edge is real: state it in `packages/jobs/CLAUDE.md`.
- `packages/core/src/registrar.ts:86` — `{ factory: 'webhookReceiver', pkg: '@ultimat3/jobs', kind: 'job' }`, held by `scripts/primitive-factories.test.ts`.
- `packages/http/src/webhook-hmac.ts` (new), `packages/http/src/index.ts:243` — `verifyBodyHmac`.
- `examples/dummy/apps/web/app/webhooks/jobs/`, `examples/dummy/apps/web/runtime.ts` (new) — one receiver, once; regenerate `x.manifest.json` and both schema dumps if touched.
- `packages/action/src/action.ts:68`, `packages/action/src/http-path.ts:31` — these comments say `http.path` is for a webhook; they now say a vendor-held path, and point a webhook at the factory.
- `wiki/Jobs-And-Workflows.md:284` (an "Inbound webhooks" section after the outbound one), `wiki/Actions.md:35,106`, `wiki/Mail.md:102`, `wiki/Configuration.md:654`, `wiki/CLI-Reference.md:1005`, `wiki/The-Eight-Primitives.md`, `packages/jobs/README.md`, `packages/jobs/CLAUDE.md`, `packages/http/README.md:384`.

## Steps
1. `bun run new-error-code` for the code below.
2. `webhookReceiver({ name, path, tenant, verify, handle, retry?, queue?, maxBytes?, handshake?, rateLimit? })` returns the job handle plus `.routes()`, a `readonly Route[]`.
3. `path` may hold `:param`. `verify(inbound)` gets `{ bytes, headers, params, url, request() }` and answers `{ eventId, orgId?, topic? }` or `{ answer: Response }` (a subscription confirm, a challenge). It throws to refuse: `X_WEBHOOK_SIGNATURE_INVALID` and `X_WEBHOOK_SIGNATURE_STALE` exist. `request()` rebuilds a `Request` over the bytes, so `verifyWebhookSignature` (`http/src/webhook-verify.ts:132`) and the mail receivers plug in unchanged.
4. Route handler, in order: `request.bodyBytes()` under `maxBytes` (default `DEFAULT_WEBHOOK_BODY_LIMIT`); `verify`; `enqueue({ eventId, orgId, topic, body, encoding })`, UTF-8 when the bytes round-trip, else base64; answer 200 `{ ok: true, eventId, deduped }`. No body parse before `verify`. No content type is required.
5. An enqueue failure answers 503 with `Retry-After`, through the normal error map, so the vendor redelivers. An ack never precedes the durable row.
6. `handle({ eventId, topic, bytes, text, ctx, step })` runs as the job's body. A parse failure there dead-letters and shows in `x jobs`, rather than a 4xx that makes a vendor disable the endpoint.
7. `handshake?(inbound)` mounts GET on the same path, answers the returned `Response`; unset, no GET route exists.
8. `Route.meta`: `name: 'webhook.<name>'`, `auth: 'public'`, `rateLimit` passed through. `csrf` already exempts anonymous writes with no browser evidence (`wiki/Configuration.md:417`).
9. `verifyBodyHmac({ bytes, secret, given, encoding: 'hex' | 'base64', prefix? })`: `secret` a string or list (rotation), constant-time through `timingSafeEqual`, empty secret refused as `X_CONFIG_INVALID`, the code `webhookSecretMissing` already raises.
10. The stored body sits in `x_jobs` until `jobs.doneRetentionMs` / `deadRetentionMs`, app-chosen. State this in the wiki section; an app that keeps evidence elsewhere stores it in `handle`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_WEBHOOK_SIGNATURE_INVALID` (existing) | `verify` refused the bytes | correct the secret or `verifyBodyHmac` options named in the cause |
| `X_CONFIG_INVALID` (existing) | empty or unset secret | set the secret on the role that serves the route |
| `X_BODY_INVALID` (existing) | over `maxBytes` | raise `maxBytes` on `webhookReceiver("<name>")` |
| `X_WEBHOOK_RECEIVER_INVALID` (new, off-socket) | declaration: `path` not absolute, under `/_x` or `/api`; or `handshake` on a path with no reader | fix the named field in `webhookReceiver("<name>")` |

## Tests
- `packages/jobs/src/webhook-receiver.test.ts` (unit, real `httpPipeline`, memory driver): XML, octet-stream, no content type and malformed JSON all reach `verify`; a bad signature enqueues nothing; `:param` reaches `verify`; `answer` short-circuits; a failing enqueue answers 503, not 200; non-UTF-8 bytes arrive in `handle` byte-identical.
- `packages/jobs/src/webhook-receiver.job.test.ts` (Postgres): live redelivery runs once; a redelivery after settling runs `handle` again with the same `eventId`, pinned so nobody documents exactly-once.
- `packages/http/src/webhook-hmac.test.ts`: both encodings, prefix, second rotation secret, one flipped byte fails.
- `examples/dummy/apps/web/app/webhooks/jobs.job.test.ts`: the reference receiver end to end. `bun test packages/jobs/src/webhook-receiver.test.ts`.

## Semver
minor. Additive; the pinned action door keeps working. `wiki/Actions.md` wording changes only.

## Done when
- The four probe refusals above reach `verify` under the factory.
- The factory appears in `PRIMITIVE_FACTORIES`, and the receiver's job in `x.manifest.json`; `x routes --json` lists its route with `primitive: null`.
- `wiki/Actions.md`, `wiki/Mail.md` and `action/src/action.ts:68` name one door for a webhook.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
