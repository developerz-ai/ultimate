# 07 — Security

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0–5.

Whole-repo sweep on one axis. The two findings proven by execution share one root shape worth naming:
**a security control enforced on one surface and structurally absent on another.** `/media` versus
`/_storage` is that for storage authz; explicit-`ctx` versus ambient-context invocation is that for
tenancy. Both pass every test in the repo, because no test compares two surfaces against each other.

That is also the fix pattern: for each pair, add the cross-surface test, not just the patch.

## Critical

- `packages/cli/src/dev-assets.ts:184` — **`GET /media/*key` is `auth: 'public'` with no policy and
  no tenant check, and serves any object on the app's only disk.** `mediaResponse` (`:113`) passes
  the raw client-supplied key straight to `storage.disk().get(key)`. The route is mounted **in
  production** by `packages/cli/src/serve.ts:243`, and `packages/cli/src/dev-runtime.ts:127,164`
  shows every deployment has exactly one disk, always the default — so the route covers every object
  the app stores. Unauthenticated, no session, no token. Proven by executing the real route against
  the real local driver:

  ```
  isTenantScoped(key) = true
  route meta = {"name":"assets.media","auth":"public","tags":["assets"]}
  status = 200  body = SECRET-BYTES-OF-TENANT-A
  ```

  Two aggravators. The response is `cache-control: public, max-age=31536000, immutable`
  (`dev-assets.ts:36` → `packages/http/src/response.ts:110`), so any CDN or shared proxy stores
  another tenant's private file under a public key for a year — while the framework's *other* route
  to the same bytes declares `{ mode: 'private', maxAgeSeconds: 0, vary: ['authorization','cookie'] }`
  (`dev-storage.ts:205`); the two routes disagree on both authz **and** cacheability. And
  `dev-assets.ts:99` is an **unauthenticated write**: `disk.put(cached, variant.bytes, …)` after a
  `?w=` transform, with no ceiling on `w` in `parseImageQuery`
  (`packages/seo/src/images.ts:140`), so anonymous callers mint unbounded new objects in the bucket.
  Revoking a user's permission has no effect on this path.

  Fix: give `/media/*key` what `packages/cli/src/dev-storage.ts:200-215` already has —
  `auth: 'required'` + `policy: STORAGE_READ_PERMISSION` + `enforcedBy: 'handler'`, then
  `authorizeStorageRead(input, ctx)` and the `isTenantScoped`/`isWithinOrg` pair (`dev-storage.ts:92`)
  before `disk().get`. Keep `immutable` only for keys that are not tenant-scoped.
  `packages/storage/src/path.ts:98-105` states the violated rule verbatim: *"A surface serving objects
  has to tell the two apart … dropping the check would make one tenant's prefix readable by another."*

- `packages/realtime/src/subscription-book.ts:62` — `ofSocket()` copies the node's entire subscription
  map on every call (`this.all().filter(…)`), making socket teardown and the re-auth sweep **O(N²)**.
  Both callers run once *per socket*: `live-query.ts:246` (every WebSocket close, every revoked grant)
  and `live-query.ts:259` (the 30-second grant sweep, `sync-node.ts:191`). One mass event costs
  `sockets × total_subscriptions`. No attacker capability required — the trigger is a deploy, a
  network blip, or grants with `expiresAt` (the documented shape, `sync-auth.ts:18-24`) expiring
  together. Measured: 2,000 sockets × 50 subscriptions = 100,000 entries → **15.8 s of blocking
  main-thread work** per sweep. The repo's own benchmark claims 50,000 sockets with a 128 per-socket
  cap, far past this. The node stops answering heartbeats, patches and accepts for the duration,
  converting a routine reconnect storm into a self-sustaining outage. Fix: maintain
  `#bySocket = Map<string, Set<string>>` alongside `#bySid`, updated in `add`/`delete` — the
  secondary-index shape `packages/cache/src/lru.ts:58` and `packages/realtime/src/presence.ts:63`
  already use.

- `packages/realtime/src/sync-node.ts:348` — **no rate limit and no concurrency limit on inbound
  WebSocket frames**; `AcceptBudget` gates only the HTTP upgrade. The budget is correctly wired and
  not bypassable (checked at `:285`, before `authenticate`), but it spends one token per *upgrade*;
  after the socket is open, `message()` spawns an unawaited async task per frame with no ceiling.
  One authenticated socket — the cheapest possible foothold — reaches three amplifiers via
  `createFrameRouter`:

  | Amplifier | Cost |
  |---|---|
  | `assertCapacity`'s per-tenant branch (`subscription-book.ts:79-82`) walks every subscription on the node per subscribe frame | measured **6.45 ms/frame at 100k subscriptions** → ~155 frames/s consumes the node. Conditional on `maxPerTenant`, which is exactly what a multi-tenant deployment sets |
  | `subscribe` on a topic the socket already holds | still runs `presence.join` → a shared-store put, a fleet-wide bus publish, a full-room `roster()` read |
  | `subscribe` on a fresh `(name, input)` pair | a database read (`live-query.ts:225,470`), up to 128 per socket, unbounded concurrency |

  Fix: instantiate the existing `AcceptBudget` (`thundering-herd.ts:117`) per socket and check it at
  the top of `routeFrame`; make the per-tenant count O(1) off a `Map<tenant, number>` maintained in
  `add`/`delete`. Pairs with the per-socket FIFO lane in
  [`06-concurrency-lifecycle.md`](06-concurrency-lifecycle.md).

## High

- `packages/action/src/invoke.ts:79`, `packages/query/src/read.ts:100`,
  `packages/jobs/src/execute.ts:66,83` — **an explicit `ctx` is honoured as a parameter but never
  installed as the ambient context**, so policy is evaluated against one identity and row tenancy
  against another, or none. `invoke()` enters `runWithContext` only when `options.actor` is supplied;
  given `options.ctx` alone it calls `core(target, raw, options.ctx, options)` directly. `asActor`
  does the same at `read.ts:100`. The jobs worker builds a `Ctx` (`worker.ts:201`, `execute.ts:66`)
  and passes it into `handle.run({ ctx })` — `runWithContext` appears **nowhere** in
  `packages/jobs/src`. Meanwhile `@ultimat3/entity`'s tenancy guard derives from `tryUseContext()`
  (`packages/entity/src/tenancy.ts:152`), not from the passed ctx: with no ambient context
  `actorTenant` returns `undefined`, `scopedPlan` derives no predicate, `verifyScope` returns early —
  a caller-named tenant is accepted unchecked and `assertRowTenant` cannot fire. Proven, same entity,
  same actor, same call, two surfaces:

  ```
  HTTP surface, write naming another org -> X_TENANCY_ACTOR_MISMATCH
  JOB  surface, write naming another org -> ACCEPTED
  rows now visible to org-B: 1
  ```

  and through the documented action→job projection (`packages/action/src/job-handle.ts:36`):

  ```
  ambient ctx (HTTP-like)                                  -> X_TENANCY_ACTOR_MISMATCH
  explicit ctx (writeAnywhere.job().invoke, actor = org-A) -> ACCEPTED
  ```

  Reachable by any app that routes user input into a job — which is the framework's own instruction
  (`packages/jobs/src/job.ts:76-86`: *"A job that must act FOR a user takes that user's id in its
  input and re-authorises it in the body"*) and the advertised define-once-project-everywhere path.
  `backfill()` sweeps run in the same hole. The guard `packages/entity/src/tenancy.ts:1-3` calls "a
  guard, not a convention" is structurally inert on the job surface;
  `packages/entity/CLAUDE.md` names the exemption as "a script, a seed, a test harness" — jobs, a
  first-class primitive running app code on attacker-influenced input, are not in that list.

  Fix, two halves that must land together:
  1. `invoke()` and `asActor()` wrap their body in
     `runWithContext(options.ctx ?? useContext(), () => core(...))`. When `ctx` is absent this is
     already the ambient context, so it is a no-op on every path that works today.
  2. `executeJob` runs `handle.run` inside `runWithContext(ctx, …)`. This fails **closed**, not
     silently: `packages/cli/src/dev-roles.ts:286` builds the worker context as
     `createContext({ role: 'worker' })` with no actor, so every tenant-scoped read becomes
     `X_TENANCY_ACTOR_ORG_REQUIRED`. It therefore ships with either a boot-supplied `serviceActor`
     carrying an org, or jobs declaring their tenant — **that is the design decision the current code
     sidesteps by leaving the guard off**, and it must be made explicitly, not deferred again.

- `packages/http/src/config.ts:111` — `config.dev` is decided by `NODE_ENV` alone, so a deployment
  that declares production **the framework's own documented way** serves the dev error overlay and a
  report-only CSP. `const dev = input.dev ?? env('NODE_ENV') !== 'production'`, and `:143` sets
  `csp: { …, reportOnly: dev }`; `packages/core/src/environment.ts:27` makes `ULTIMATE_ENV` the one
  environment key with `NODE_ENV` only as a fallback, and this file reads only the fallback. Proven:
  with `NODE_ENV` unset and `ULTIMATE_ENV=production`, `dev = true` and `csp.reportOnly = true`. Any
  unauthenticated request with `Accept: text/html` that provokes a 5xx then gets
  `packages/http/src/overlay.ts:96`'s stack — absolute filesystem paths, module layout, internal
  cause strings — and the app's CSP is not enforced at all, un-mitigating every XSS elsewhere
  (including [`03-tier45-bugs.md`](03-tier45-bugs.md)'s JSON-LD breakout). `docker/Dockerfile:49`
  sets `NODE_ENV=production`, which is why the shipped container path has not hit it; it is reachable
  from a `x build --target binary` artifact, a PaaS rung of the documented ops ladder, or a helm
  `env:` override following the documented key. Fix: `tryResolveEnvironment() !== 'production'` —
  core exports the non-throwing variant for exactly this, and `packages/policy/src/evaluate.ts:55`
  already uses it for the same reason.

- `packages/auth/src/jwks.ts:178` — an unknown `kid` bypasses the cache TTL, so a forged token issues
  **one outbound JWKS fetch per attempt**. `if (!known || clock.now().getTime() >= staleAtMs)` —
  `!known` short-circuits before the TTL is consulted, and `fetchKeys` resets `fetchedAtMs` on each
  call; the `inflight` guard (`:160`) coalesces only concurrent callers. **Unauthenticated**:
  `verifyJwtSignature` (`:236`) reads `header.kid` out of the attacker-supplied JWT header *before*
  any signature check, and `verifyWorkloadToken` (`workload.ts:83`) is what `hooks.authenticate`
  funnels a bearer token through. Measured with a frozen clock and a stub fetch: **500 attempts → 500
  outbound fetches**. The IdP rate-limits or blocks the app's egress and every *real* login then
  fails.

  **Severity: High, not Medium** (a sibling sweep rated it Medium). Three facts move it up. The `kid`
  is read pre-signature, so no credential is needed. `auth` is pipeline stage 6 and `rate-limit` is
  stage 7 (`packages/http/src/pipeline.ts:57,62`), so the framework's own limiter never sees these
  requests — the usual mitigation is structurally absent. And the damage lands on a **third party**
  the app does not control, with recovery gated on the IdP's unblock timeline rather than an app
  restart; the outcome is total loss of authentication, not degradation. Fix: track
  `lastMissRefreshMs` and gate the unknown-`kid` refresh on the TTL the docstring already promises.

- `packages/auth/src/auth.ts:267` and `packages/auth/src/oauth-login.ts:224` — **the MFA path throws
  before any credential exists, ships no completion primitive, and its `fix:` names a route that does
  not exist.** `if (user.mfaSecret !== null) throw mfaRequired(user.id);` and
  `packages/auth/src/errors.ts:144` says `fix: 'POST /auth/mfa/verify { code } … then retry'`.
  Grepping `auth/mfa` across `packages/ examples/ dummy/ wiki/ docs/` returns three hits: that string,
  its own comment, and `wiki/Error-Codes.md:168`. There is no handler, no `verifyMfa`/`completeMfa`
  export, and no server-side pending-MFA state — `login()` returns nothing and writes nothing before
  it throws. The framework therefore leaves app authors no correct way to build the second leg: the
  only correlation value handed over is the user id in the error's cause, so the natural
  implementation is `POST /auth/mfa/verify { userId, code }` — **unauthenticated by construction**,
  because nothing exists to bind it to a completed first factor. `verifyTotp` carries no limiter and
  `auth.limiter` is wired only into `login`. Result: a full session issued without the password ever
  being proven — MFA converted from a second factor into the only factor. Secondary leak:
  `oauth-route.ts:110` serialises `cause` to an anonymous caller at 401, publishing internal user ids
  to feed exactly this. Fix: ship the second leg as a route descriptor the way `oauthLogin()` was
  shipped for this same class of defect (`packages/auth/src/oauth-route.ts:1-9`), backed by a sealed
  pending-MFA credential built like `sealHandshake` (`oauth-cookie.ts:81`). Until it exists, the
  `fix:` line and the `wiki/Error-Codes.md` row must stop naming a route that does not.

- `packages/realtime/src/socket.ts:214` + `channel.ts:59` — every channel message scans every socket
  on the node, and topics are capped per socket but **never per node**. `deliver()` iterates
  `this.#sockets.values()` testing `socket.topics.has(topic)`; the header calls this a fallback for
  per-socket filtering, but `ChannelHub.#bridge` (`channel.ts:157-159`) routes *all* delivery through
  it. `#maxTopicsPerSocket` is 64 while `#bridges` is refcounted per topic with no node-wide ceiling,
  and each distinct topic is one live NATS subscription; `topic()` accepts any `[A-Za-z0-9_-]+`
  segment, so even a guard like `org.<myorg>.>` admits unbounded distinct names inside one tenant. At
  the repo's own benchmark scale that is 3.2M NATS subscriptions on one node, and one message with
  one legitimate subscriber costs 50,000 iterations. Fix: a `Map<Topic, Set<SyncSocket>>` beside
  `#bridges`, plus a `maxTopicsPerNode` refused through the existing `SubscriptionLimitError`
  (`channel.ts:78`). Same index as the Critical above — land them together.

- `packages/realtime/src/sync-protocol.ts:331` + `sync-listen.ts:23` — the frame decoder enforces **no
  size cap** on any array or payload, and `Bun.serve` is called with no `maxPayloadLength`. `list()`
  returns arrays of any length; `cursor.ids` (`:349`), `hello.resume` (`:205`) and `patches` (`:231`)
  are unbounded, and `input` (`:388`) is arbitrary JSON of arbitrary depth. `CURSOR_ID_LIMIT` (512,
  `cursor.ts:11`) is applied only where the *server* builds a cursor — a client-supplied one is
  consumed raw at `live-query.ts:210` (`new Set(args.cursor.ids)`). `qidOf` → `canonicalJson`
  (`json.ts:53-58`) is recursive, so a deeply nested `input` is a stack overflow on the frame path.
  One authenticated socket: a `subscribe` frame with a 10M-element `cursor.ids`, or a 10,000-deep
  `input`; combined with the frame-rate Critical, 16 MiB frames pushed continuously. Fix: give
  `list()` a `max` argument refused through the existing `fail()`, and pass `maxPayloadLength` to
  `Bun.serve`. In-repo pattern: `packages/mcp/src/query-limits.ts:48-56` — a hard ceiling a caller
  may narrow but never widen.

- `packages/realtime/src/sync-node.ts:108` — `AcceptBudget` bounds the accept *rate*; nothing bounds
  the concurrent socket *count*. `SocketRegistry` (`socket.ts:155`) exposes `count` and enforces no
  ceiling; sockets leave only by close, drain, or the 120-second idle sweep — and one frame per 60
  seconds defeats the sweep, because `sync-frames.ts:36` calls `socket.touch()`. Open sockets at
  500/s (a rate the accept budget explicitly permits) and hold each with a keepalive: 1.8M sockets
  per hour, each carrying a `GrantBook` entry. Fix: refuse in `fetch` when
  `sockets.count >= maxConnections`, using the same `retry-after-ms` 503 the budget already returns at
  `sync-node.ts:286-290`.

## Medium

| Site | Defect | Fix |
|---|---|---|
| `packages/core/src/logger.ts:57-59` | three of eight default redaction keys are **inert** — the literal `Set` stores `apiKey`/`accessToken`/`refreshToken` in camelCase while `isRedactedKey` lowercases the lookup, and those are the exact field names on `OAuthTokens` (`oauth-exchange.ts:33-40`) | lowercase the literals or build through `redactKeys` (`:64`); add `set-cookie`, `client_secret`, `id_token`, `private_key`. Matching is exact-key, so `api_key`/`session_token` do not redact either |
| `packages/cli/src/cmd-dev.ts:322-324` | `x dev` emits raw `DATABASE_URL` and `NATS_URL`, passwords included, into `--json`; the rule against it is stated three lines below and applied only to `mail`/`cdn` | route all three through `safeLabel()` (`packages/cli/src/mcp-db-target.ts:24`) |
| `packages/cli/src/cmd-doctor.ts:177` | the production gate reads `X_ENV`/`NODE_ENV`, never `ULTIMATE_ENV`, so `X_CURSOR_SECRET_DEV` (`:90`) and `X_STORAGE_SECRET_DEV` (`:109`) silently skip — leaving the published `DEV_SIGNING_SECRET` usable to mint signed uploads. `X_ENV` is a spelling nothing else reads, and the `??` short-circuits so `X_ENV=prod` makes doctor answer "not production" outright | `tryResolveEnvironment()` |
| `packages/query/src/read.ts:181` | `sourceFor(target, input, { enforce: false })` skips `guard()` entirely and is exported (`index.ts:70,74`) as a bare boolean — no capability, no reason, no audit — while the framework's other authz escape hatch requires all three (`packages/entity/src/cross-tenant.ts:2-4`: a boolean argument is wrong because "it reads exactly like forgetting the tenant") | hold it to `crossTenant`'s bar, or make it internal — `explain()` and `liveQueryDefinition` are its only legitimate callers |
| `packages/storage/src/upload.ts:16` | `image/svg+xml` is in the **default** allowlist (`uploadPolicy()` at `:45`) and the sniffer at `:123` promotes `<svg` to it; chained with the `/media` Critical this is unauthenticated stored XSS on the app origin with a one-year immutable cache | drop it from the default set; let an app that wants SVG pass `allowedContentTypes` explicitly |
| `packages/ui/src/components/Link.tsx:28` | **no URL-scheme guard anywhere** in render/ui/admin (`href={props.href}`, `Avatar.tsx:51`, `Breadcrumb.tsx:39`, `admin/src/widgets.tsx:108` straight off a row), and `isExternal()` tests `/^https?:\/\//` so a `javascript:` href is additionally treated as internal and gets no `rel="noopener"` | add the equivalent of `safeUrl` (`packages/mail/src/html.ts:24`) to `packages/render/src/html.ts` and apply it in `attributePair` for `href`/`src`/`action`/`formaction` |
| `packages/ai/src/rag.ts:185` | `assembleContext` joins retrieved documents with `'\n\n---\n\n'`, a separator a document can contain, and the result lands in the `user` message indistinguishable from the author's instructions; tool *results* carry provenance, retrieved context carries none. Influence only — actor comes from `ctx.actor` and tool dispatch is matched against `def.tools` | delimited, id-labelled blocks with the delimiter stripped — the shape `cdata()` uses at `packages/seo/src/xml.ts:26` |
| `packages/jobs/src/limits.ts:80-88` | four per-tenant maps with no sweep and no cap: `bump(…, -1)` writes `0` instead of deleting, `refusals` clears only on a matching acquire, `starts.set(tenant, window)` keeps an array per tenant — self-service org creation adds four permanent entries per org to a never-restarting worker | the sweep+cap at `packages/http/src/rate-limit.ts:210-222` |
| `packages/realtime/src/live-query.ts:88` | `#entries` has no node-wide ceiling and `qid` derives from client-chosen `input`, so distinct inputs mint distinct entries each holding a matcher, row window and `WindowLock`, and `deliver` fans every change over all of them | node-wide entry cap refused through `SubscriptionLimitError` |
| `packages/realtime/src/change-buffer.ts:38` | an **entry-count** budget (4096 × 1024 = 4.19M retained `RowPatch` objects, each holding a whole row) where `packages/cache/src/lru.ts:1-2` states the rule: "bounded by BYTES, not entry count — an entry count budget is a memory leak with extra steps". Separately `forget(qid)` (`:73`) has **no caller** — `unsubscribe` (`live-query.ts:242`) deletes the entry and never notifies the `ResumeSource` | byte budget; call `forget` from `unsubscribe` |
| `packages/ai/src/remote-embedder.ts:68` | outbound fetch with no `AbortSignal` and no response size cap; `response.json()` buffers the whole body, `texts.length` is unbounded, and the per-request deadline produces a `ctx.signal` this call never receives | `AbortSignal.timeout(...)`, as at `packages/cache/src/purge-http.ts:152` and `packages/auth/src/jwks.ts:117` |
| `packages/mcp/src/transport-http.ts:79` | `await request.json()` on a bare `Request` bypasses `UltimateRequest.#read`'s counting reader and `config.bodyLimitBytes`; neither `packages/http/src/server.ts:156` nor `cmd-mcp.ts:80` passes `maxRequestBodySize`, so Bun's 128 MiB default governs. Mitigated for `x mcp serve` by localhost + a per-process token; an app mounting `defineAppMcp`'s route inherits the gap with a real token | read through the capped reader |
| `packages/auth/src/password.ts:17` | 19 MiB argon2id per login attempt with **no concurrency cap**; both gates are per-source (`ipKey(ip)` 5 attempts; http's `auth` bucket 10 per `route\|ip:`) so an attacker rotating an IPv6 /64 mints fresh keys for both, and the caps bound *memory*, not *work*. The only backstop is `maxInflight: 1000` — roughly 19 GB of argon2 arenas queued | a semaphore around `verifyPassword`/`hashPassword`, refused with the `X_OVERLOADED` + `retry-after` shape at `packages/http/src/stages.ts:140-143` |

## Low

- `packages/admin/src/dev/server.ts:60-62` — the `/_x` production guard reads `ROLE`/`X_ENV`/`NODE_ENV`
  but not `ULTIMATE_ENV`, and `ROLE` can never equal `production` (`ROLES` is
  `web|sync|worker|scheduler|replicator|migrate`), so `NODE_ENV` is the only real check.
- `packages/storage/src/signed-url.ts:70` — `constraints.contentType ?? ''` makes absent and empty the
  same canonical string, so appending `&x-ct=` to a URL signed with no content type verifies,
  defeating `accept.ts:86`'s `unconstrained` refusal. Defence-in-depth only.
- `packages/cli/src/cmd-mcp.ts:77` — `candidate === token` on a bearer token; localhost with a
  `nanoid(32)` per process, so not practically exploitable, but it is the one secret comparison not
  going through core's `timingSafeEqual`.
- `packages/auth/src/auth.ts:298-302` — `logout()` deletes the session row by the id half and never
  checks the secret, unlike `verifySession` (`session.ts:149`).
- `packages/realtime/src/pg-socket.ts:56` — `detail: \`"${url}" is not a connection URL\`` echoes the
  raw replication URL, password included, into a coded error. Name the env var instead, as
  `packages/mail/src/driver-smtp.ts:68` does.
- `packages/core/src/cursor.ts:39,52` — `DEV_SECRET = 'ultimate-dev-cursor-secret'` is the silent
  production default, and the only backstop is the `x doctor` check the Medium above shows does not
  fire. Refuse at construction, as `packages/storage/src/driver-local.ts` does.
- `packages/http/src/redirect.ts:16` — `setRedirect(location)` performs no same-origin check and the
  framework offers no guarded helper, while `nextAfterSignIn` implements exactly that rule at
  `auth-redirect.ts:71-79`. Export the guarded form.
- `packages/query/src/pagination.ts:51` — `args.first + 1` with no ceiling; not reachable through
  `toQueryRoute`, but `PaginateArgs` makes wiring `first` from wire input the natural thing to do.
  Clamp as `packages/admin/src/pagination.ts:82` does.
- `packages/entity/src/repo.ts:187` — `likePattern` expands `%` → `.*`, so twenty `%` is catastrophic
  backtracking; in-memory driver only.
- `packages/schema/src/validators.ts:71` — `new RegExp(node.pattern, …)` recompiled per validation,
  and the `pattern` check is preceded by `maxLength` only when the author declared one.
- Attribute/inline-script interpolation without escaping, author-controlled and with no attacker path
  today: `packages/render/src/hydrate.ts:39-43`, `render-html.ts:95`, `render-stream.ts:60`,
  `head.ts:145,147`. `packages/render/src/html.ts:84` escapes the attribute *value* and never the
  *name* — latent, in the module that declares itself the single place injection is prevented.
- **Fail-closed observation**: `acceptSignedUpload` (`packages/storage/src/accept.ts:78`) has no
  caller anywhere — no `PUT` route is mounted by the CLI, so `localDriver`'s signed upload URLs 404,
  while `docs/architecture/17-uploads.md:104-112` and
  `examples/dummy/apps/web/app/orgs/avatar.ts:63` document the host mounting it. Same
  built-but-never-called class as the query-route gap fixed in #98, in the safe direction.

## Verified sound — do not "fix"

**The entire authz projection model held** under end-to-end tracing of action, query and admin
primitives across HTTP, OpenAPI, typed client, job handle and MCP tool — the one break is H1's
ambient-context gap, which is a context-installation bug, not a policy-projection bug. Also clean:
mass assignment via MCP CRUD tools; cursor forgery and cross-resource replay; fail-open authz in
`policy-bridge.ts`; MCP tool enumeration oracle; XSS in the `/_x` shell; raw colour literals; session
and API-key comparisons (hash-then-`timingSafeEqual` on both); `csrf.ts` exempting bearer callers
(correct — a cross-site page cannot make a browser attach an `Authorization` header without a
preflight); `pg-sql.ts` injection (every identifier resolves through `physicalName`; `raw()` appears
three times over closed one-word sets); `readonly-sql.ts` batched-statement and quoted-identifier
evasion; `withScopes` refusing unknown scopes at boot; `assertNoSecrets` covering every `PromptVars`
key the type permits; `x secrets` never printing a value.

## Tests

Each fix gets its failing-first test, but the **cross-surface** tests are the ones that matter — they
are what no test in the repo currently does:

- one object, requested through `/media/*key` and through `/_storage`, must answer the same authz
  verdict and the same cache-control class.
- one entity write, performed through HTTP and through the job surface with the same actor naming
  another org, must reach the same `X_TENANCY_ACTOR_MISMATCH`.
- one action, invoked with `options.actor` and with `options.ctx`, must evaluate policy against the
  same identity.
- `tryResolveEnvironment()`-based production detection asserted once per reader
  (`http/config.ts`, `cmd-doctor.ts`, `admin/dev/server.ts`).
- 500 sequential unknown-`kid` tokens issue at most one outbound fetch.
- 2,000 sockets × 50 subscriptions tear down in bounded time (a perf assertion with a generous
  ceiling still catches an O(N²) regression).

## Done when

- Every Critical and High fixed, each with the cross-surface test above rather than a single-surface
  one.
- The job-tenancy decision (service actor vs. jobs declaring their tenant) is made explicitly and
  written into `packages/jobs/CLAUDE.md` — it is a design choice, not a patch.
- `ULTIMATE_ENV` is the single production signal, with no reader left on `NODE_ENV`/`X_ENV`.
- MFA either ships its second leg or its error stops naming a route that does not exist.
- `bun run verify` green.
