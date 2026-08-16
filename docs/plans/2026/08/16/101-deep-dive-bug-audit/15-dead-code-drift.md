# 15 — Dead code, duplication, and driver divergence

> Part of [`overview.md`](overview.md). Depends on: 08 (several deletions overlap — check it first).
> Tiers: 0–5 + apps.

Three classes: code that exists and does nothing, code that exists twice, and pairs of things that
are supposed to say the same thing and no longer do. Every deadness claim below was verified by a
repo-wide search covering both tracked apps, `scripts/`, `docs/` and `wiki/`.

**Driver divergence is the largest and most dangerous section** — two implementations of one
interface answering one call differently. It is where this repo's structural bugs concentrate,
because a test suite that runs on the memory driver proves nothing about the Postgres one.

## Built but never called

- **The `.env.example` drift gate has never run against either tracked app.**
  `packages/cli/src/app-env.ts:28` — `ENV_SCHEMA_EXPORT = 'envSchema'` is the only export the CLI
  looks for, and `defineEnv()` returns resolved **values**, so an inline call leaves the declaration
  unreachable. `examples/dummy` has **zero** `defineEnv`/`envSchema` hits;
  `dummy/social-media-clone/app.config.ts:17` exports `env`, not `envSchema`. The scaffold
  (`scaffold-repo.ts:104-110`) gets it right and explains at `:100` why the named export is
  load-bearing.

  So `X_ENV_EXAMPLE_DRIFT`, `checkEnvExample`, `assertEnvExample`, `renderEnvExample`,
  `x env example`, `x env check` and the `manifest` step's `.env.example` half are built, tested,
  documented and exercised by **no app in this repo** — which is why four committed keys have no
  schema entry and no reader: `MAIL_API_KEY` (`examples/dummy/.env.example:27`),
  `ERROR_MONITOR_DSN`, `APP_MCP_TOKEN`, `DB_GATEWAY_URL` (all `dummy/social-media-clone/.env.example`).
  Worse, `examples/dummy/.env.example:2-3` claims every var is declared, validated at boot, and fails
  with `X_ENV_INVALID` — all three clauses false, and `X_ENV_INVALID` appears exactly once in the
  repo, at `wiki/Error-Codes.md:598`, as a **reserved** code mapped to `X_ENV_MISSING`.
  `dummy/social-media-clone/app.config.ts:11` repeats the false claim. Fix: adopt the scaffold's
  two-export spelling in both apps, regenerate both `.env.example` files, delete or declare the four
  orphan keys.

- **Three of five `RouteBudget` knobs are unreadable, and declaring only those silently passes the
  gate.** `packages/render/src/route.ts:53,56,57` declares `css`, `cls`, `tbt` with **no readers
  anywhere** — `registry.ts:328-329` projects only `budgetJs`/`budgetLcp`,
  `packages/manifest/src/schema.ts:38` types the fact as `{ js?, lcp? }`, and
  `packages/cli/src/budgets.ts:52-53` reads two. The false green:
  `budgets.ts:55` guards `X_BUDGET_UNMEASURED` on `if (js !== null || lcp !== undefined)`, so a route
  declaring `budget: { cls: 0.1, tbt: 200 }` is **skipped entirely** — no check, no unmeasured
  finding, green. That contradicts the file's own `:43-45` ("a route that clears the gate without ever
  being weighed is exactly the false green axiom 5 exists to prevent").

- **The LCP budget branch is unreachable in production.** `packages/cli/src/budgets.ts:20,75` —
  `lcpMs` has five hits repo-wide: the declaration, two reads, and two tests that synthesize it. The
  sole writer of `.x/build-stats.json` is `prerender.ts:113-117`, which writes
  `{ path, jsBytes, heaviestChain? }` and never `lcpMs`, so line 75 can never be true. Meanwhile
  `scaffold-app.ts:43,120,312` gives every scaffolded route an `lcp` budget — every new app ships
  three LCP budgets that are never enforced while `x verify` reports green. **Only `js` is really
  checked.** Fix these three together with [`14-agent-dx.md`](14-agent-dx.md) #6 and
  [`08-architecture.md`](08-architecture.md) H4 — one budget story, four slices reached it.

| Site | Dead thing | Evidence |
|---|---|---|
| `packages/cli/src/budgets.ts:155` | `measureJsBytes` has no production caller | 5 test uses + one stale doc ref (`docs/architecture/16-build-pipeline.md:34`); not in `src/index.ts`; the real caller uses `measureDocumentJs`. Its own doc comment names a caller that does not exist |
| `packages/pwa/src/background-sync.ts:21,54` | `PERIODIC_SYNC_TAG` and `periodicMinIntervalMs` | no `addEventListener('periodicsync'` anywhere; the option's total repo mentions is 1 — its own declaration. `wiki/PWA-And-Offline.md:136,147` documents a `periodicSync` config key that is not in `CAPABILITIES` |
| `packages/jobs/src/driver-nats.ts:48`, `driver-redis.ts:51` | `streamPrefix`, `consumerGroup` | both drivers take `_options` and discard it; the only other hit is a test passing the knob to prove the type compiles |
| `packages/pwa/src/capabilities.ts:65,66` | `badging` and `shareTarget` SW markers never asserted | `service-worker.test.ts:86,95` iterates only `push` and `backgroundSync`, though the table's doc comment says it exists "to assert nothing leaks when disabled" |
| `packages/core/src/env-example.ts:100` | `EnvExampleReport.extra` reaches no surface | computed at `:108`, consumed only inside an unreachable throw; `app-env.ts:95-102` builds its finding from `missing` only. CONFIDENCE: medium — documented as "reported, never fatal", so only the reporting half is missing |
| — | `WORKER_QUEUES`, `DRAIN_TIMEOUT`/`DRAIN_TIMEOUT_MS` | 11 and 12 hits respectively, **every one documentation** — zero `.ts` files. Both are in `wiki/Configuration.md`'s env table as if a reader existed. The real knob is `configureLifecycle({ deadlineMs })` |

## Duplication

- **`isRecord` — 12 copies in 6 packages, in two behaviourally different variants.** Variant **A**
  rejects arrays (`packages/auth/src/{id-token,jwks,workload,oauth-exchange,oauth-discovery,oauth-profile}.ts`,
  `packages/cache/src/purge-http.ts:129`, `packages/mail/src/driver-resend.ts:70`); variant **B** does
  not (`packages/cli/src/{app-env,app-auth,guards}.ts`, `packages/testing/src/matchers.ts:14`).
  B is the same validation with a weaker rule at a different layer: `app-auth.ts:27` accepts a JSON
  **array** as an auth config, and `guards.ts:34` lets an array reach `isGuard`. This is the archetype
  the framework already resolved for `timingSafeEqual`, whose file documents that reasoning verbatim.
  **Canonical: A → `@ultimat3/core`; delete all 12**, including the exported one.

- **Three word-splitters and two pluralizers that disagree.** `packages/action/src/naming.ts:28` and
  `packages/query/src/naming.ts:12` are **byte-identical** (proven by comparing
  `Function.prototype.toString`), and query's header *justifies* the copy — "tiers never go sideways"
  — when the repo's own remedy for that situation is a tier-0 extraction, stated verbatim in
  `core/timing-safe-equal.ts:1-4`. `packages/cli/src/templates/naming.ts:38` is a **third**, with
  different behaviour. Executed side by side:

  | Input | `action`/`query` | `cli/templates` |
  |---|---|---|
  | `listHTTPServers` | `list-http-servers` | `list-httpservers` |
  | `person` (plural) | `people` | `persons` |
  | `child` (plural) | `children` | `childs` |
  | `posts` (plural) | `posts` | **`postses`** |

  So `x g resource person` scaffolds `persons` while the derived route is `/api/people/create`.
  **Canonical: action's → core; delete query's; replace the CLI template's.**

- **Two live MCP tool-name projections that disagree.** `packages/action/src/mcp-tool.ts:39` snake-cases
  via `toToolName` (`publish_post`); `packages/mcp/src/from-action.ts:74` takes the name verbatim
  (`publishPost`); hand-written app tools take the record key verbatim. `from-action.ts:12-13` claims a
  clean split ("`toMcpTool` owns the schema half; this file owns the execution half") — but both set
  `name`, differently. **Canonical: verbatim** — two of three surfaces use it, and it is what
  `tools/call` addresses by. Delete `toToolName`. Pairs with
  [`04-projection-contract.md`](04-projection-contract.md)'s two-schemas-for-one-tool finding: same
  seam, both halves.

| Duplicate | Sites | Divergence | Canonical |
|---|---|---|---|
| `formatBytes` | `packages/pwa/src/precache.ts:125`, `packages/render/src/islands.ts:58` | render lacks the `mb` branch: 5 MiB → `5mb` vs `5120kb`. `cli/budgets.ts:12` imports render's, so one warning says `5mb` and the budget error says `5120kb` for the same size | pwa's → core |
| byte-budget parsing | `packages/render/src/islands.ts:48`, `packages/seo/src/budgets.ts:58` | `'40000'` → render returns `null` (silently unbudgeted), seo returns `40000` and **throws** on unparseable | seo's leniency + render's non-throwing contract, in one tier-0 parser |
| JWT payload decode | `packages/auth/src/id-token.ts:39-50`, `workload.ts:87-96`, near-copy at `jwks.ts:72-80` | same six lines, different error | extract `decodeJwtSegment` into `tokens.ts`, which already owns `base64UrlBytes` |
| constant-time compare | `packages/core/src/cursor.ts:110` (`sameSignature`) vs `timing-safe-equal.ts:11` | identical algorithm, **same package**, in the file that exists to be the one copy | delete `sameSignature` |
| `notImplemented` job drivers | `packages/jobs/src/driver-nats.ts` (74 lines), `driver-redis.ts` (77) | structurally identical: same FIX modulo one word, same closure, same 5-method `StepStore` stub, same 6-method driver stub — and near-identical tests | extract `unimplementedDriver(name, fix)` |
| `stringOrNull` | `packages/auth/src/oauth-profile.ts:44`, `oauth-discovery.ts:32` | same rule, different arity | fold into one |
| the tier-4 "may import" sentence | `packages/{ai,manifest,mcp,render,pwa}/CLAUDE.md` | copy-pasted five times and **stale in all five** — omits `db`, `storage`, `flags`; render and pwa also omit `jobs`, `realtime`. `packages/ai/CLAUDE.md:3` contradicts `:6` and its own `package.json:37` three lines apart | derive from `scripts/lib/tiers.ts`, as `tier-table-drift.test.ts` already does for the root table |

**Three `checkBudgets` and two `RouteBudget`, one subsystem entirely dead.** `packages/cli/src/budgets.ts:47`
is live; `packages/render/src/islands.ts:171` and `packages/seo/src/budgets.ts` are exported and called
by nothing. Every one of the 14 `@ultimat3/seo` imports across the repo takes `renderMeta`, `RouteMeta`,
`ld` or an image helper — **nothing** imports seo's budget surface. `X_SEO_BUDGET_EXCEEDED` is
registered, documented, in the manifest, and throwable only by a function nobody calls. Delete seo's
budget/route-record subsystem or wire it; see [`08-architecture.md`](08-architecture.md) H4.

## Driver divergence — two implementations, two answers

The top of a long list. **Every one of these passes the suite**, because the suite runs the memory
side.

| # | Divergence | Correct side |
|---|---|---|
| A1 | **Redis busts the whole entity on a row-tag invalidation; the LRU busts one row.** `redis.ts:178` joins row-tagged keys to both buckets and `invalidateTags` returns every member of the collection bucket; `lru.ts:172-180` keeps two indexes precisely so `post:2` survives. `redis.test.ts:218-231` never stores two rows of one entity. **Every single-row write currently wipes the shared tier for that entity** | LRU |
| A2 | **`BuiltinAdapter` does not normalise email; `MemoryAdapter` does — and OAuth depends on it.** `register`/`login` normalise at the call site; `signInWithOAuth` does not (`oauth-login.ts:169,130`). With `alice@example.com` registered and Google returning `Alice@Example.com`, memory links and Postgres creates a **second user row** (`x_users.email` unique is case-sensitive). Every OAuth-linking test runs on memory | normalise in `oauth-login.ts`; storage is not policy |
| A3 | **Neither test seam can fail on a duplicate key.** `insert` twice → memory stores 1 row with no error, pg raises `X_DB_UNIQUE_VIOLATION`; `insertAll([a,a])` → memory resolves with 2 rows, pg fails with 0 stored; any `unique()` column is never checked in memory (`expr.ts:200`'s `holds` is `() => true`). `createRecordingClient` has no SQLSTATE path either | memory should refuse |
| A4 | `signedUrl({ maxBytes })` is signed on local and a **silent no-op** on s3 (`driver-s3.ts:332-341`), though the contract says the signature covers it so a client cannot widen it | s3 should refuse |
| A5 | `SQL_LEASE_RENEW` has **no expiry predicate** (`driver-pg-sql.ts:206-211`) while `SQL_LEASE_ACQUIRE` treats an expired lease as free — pg contradicts itself and a stalled worker re-takes a freed slot. In memory the opposite, and `worker-fleet-slots.ts:71` discards the boolean | pg needs `and expires_at > now()`; the renewal must read its result |
| A6 | Anthropic's non-streaming parse **answers empty-but-successful on an in-band error** (`provider.ts:335-361` never inspects `raw['error']`) where both OpenAI transports and Anthropic's *streaming* path call `throwInBandError`. Result: `text: ''`, `cost.minor: 0`, then a wasted repair turn and `X_LLM_OUTPUT_INVALID` — the wrong code with an inapplicable fix | the OpenAI wire |
| A7 | `NatsTransport` **reuses a dead client forever**, then throws bare library errors — `#ensure` returns the cached client whatever its state, and `publish` is the one method with no error translation, so a bare `NatsError` escapes. `FakeNatsClient` throws `TransportUnavailableError`, and the fake's test **pins** the coded behaviour | translate + redial |
| A8 | **CR/LF header injection is refused on one mail driver of four.** `headerInvalid` has exactly one call site; Resend JSON-encodes `subject`/`headers` unchecked, memory and log check nothing. An app developed on memory, staged on Resend and shipped on SMTP starts failing at the transport for messages every earlier environment accepted | move the check into `renderMessage`/`send` |
| A9 | An SMTP retry **delivers a second email**; a Resend retry does not — SMTP mints a fresh Message-ID per attempt, and a send that times out after `DATA` is classified retryable. Both report the same `SendResult.idempotencyKey`, so a caller cannot tell which transport honours it | derive the Message-ID from the content digest |
| A10 | `put({ cacheControl })`/`put({ metadata })` succeeds on local and **throws on s3** — the exact failure `driver-local.ts:108-111` argues against for encryption ("a `put()` that succeeds locally and throws in production is a gap an app meets on the worst day") | local should refuse too |
| A11 | `list()` failure: local's bare `catch` reports **an empty, complete page** (swallowing EACCES as "this disk is empty"); s3 lets a bare `S3Error` escape uncoded. `sweepOrphans` reads `list()`, so the swallow is a false-erasure report one layer up — the bug already fixed for `delete()` | both wrong; fix both |
| A12 | `JobIntrospection.list()` is **oldest-first in memory, newest-first on pg** — same 100 cap, same call site (`x jobs ls`, `/_x`, the MCP tool). `deadLetters()` already agrees on `desc` | memory |
| A13 | `stats()` **double-counts** suspended and dead jobs as `delayed` on pg (`state = 'delayed' or run_at > now()`, state-blind on the second half). `nack` sets `run_at` for every settlement, so a 3-day `step.sleep` counts in both `suspended` and `delayed`. Autoscaling reads this | memory |
| A14 | `AiTransportError.detail` is **credential-scrubbed on OpenAI and raw on the other two** — and `detail` is interpolated into `cause`, reaching the log index, the span and the problem document. The OpenAI provider's comment names the threat; the Anthropic provider sends `x-api-key` with no guard and takes a bare `string` where OpenAI takes a `Secret` | lift `withoutKey` beside `detailOf` |
| A15 | The `request-memo` tier **never validates its TTL**, while `packages/cache/CLAUDE.md` says "every tier calls it before it writes … so a new tier cannot invent a third reading". `ttlMs: 0` is stored by memo and rejected by the other two, so the miswiring the code refuses is resolved anyway, one tier deep | memo should call `assertTtl` |

Twenty-seven further divergences (B1–B27) are in the source report; the ones worth naming here:
`updateWhere`'s 50,000-row ceiling exists only on pg; `linkAccount` replaces `userId` in memory and
silently ignores it on pg **while returning the new owner**; **no mail credential falls back to the
memory driver in every environment, reporting `accepted` for mail that never left** (storage refuses
to construct — storage is right); `EchoProvider` hard-codes `stopReason: 'end_turn'` and
`toolCalls: []`, making `X_LLM_TRUNCATED`, `X_LLM_REFUSED` and the entire tool-replay path unreachable
against the shipped fake; pg turns `undefined` into `null` on every jobs JSON round-trip, sharpest on
`waitForEvent`, whose contract is "a timeout resolves `undefined`", past an `as T` that will not catch
it; `ClaimOptions.queues: []` means "every queue" in memory and "the default queue" on pg, and the
interface documents neither; `localDriver`'s default signed-URL base is `/_storage/local` while
`verifySignedUrl`'s is `/_storage`, so **with both defaults every genuine URL fails
`signature-mismatch`**; the scheduler watermark is monotone on pg (with a comment naming the re-fire
it prevents) and freely rewindable in memory — and memory is the default.

## Things that must agree and don't

- **Phantom error codes live where no check looks.** `X_DRAIN_TIMEOUT`
  (`docs/architecture/13-topology-runtime.md:184`; the real code is `X_SHUTDOWN_TIMEOUT`) and
  `X_JOB_QUEUE_UNKNOWN` (`docs/architecture/08-jobs-internals.md:241`) appear nowhere else in the
  repo. The `errors` step and `X_MANIFEST_DRIFT` scan `packages/*/src` and `wiki/Error-Codes.md`;
  `docs/architecture/` is unguarded. Extend the scan.
- **`llms.txt:3` and root `CLAUDE.md` contradict each other on npm lockstep** — `llms.txt` says flags
  never reached npm and cites issue #84; `CLAUDE.md` says all 29 are in lockstep. `llms.txt` is the
  accurate one; see [`11-deploy-ci.md`](11-deploy-ci.md) for why it stays true after the next release.
- **Neither tracked app commits an `x.verify.json`** — so `X_VERIFY_SUITE_VANISHED` cannot fire for
  either app the gate blocks on. Reached independently here, in [`05`](05-gate-and-scripts.md) and in
  [`10`](10-tests.md). One fix.
- **Three answers to "where is `@ultimat3/cli` declared?"** — the scaffold puts it in the root
  `package.json` at `^version`; `examples/dummy/apps/web` declares it nowhere though `server.ts:7`
  imports it; `dummy/social-media-clone/apps/web` has no `dependencies` block at all. Both apps
  resolve only through workspace hoisting. Canonical: the scaffold's.

**Eight headers that lie** (a floor from incidental discovery, not a survey — the systematic
150-file audit did not complete):

| Header | Reality |
|---|---|
| `packages/seo/src/routes.ts:1-3` — "Emitted by the framework into `x.manifest.json`" | nothing emits `RouteRecord`; the manifest's route shape is a different type |
| `packages/cli/src/budgets.ts:1-3,43-45` — "a blown budget is a build failure" / "the false green axiom 5 exists to prevent" | three of five metrics neither checked nor reported unmeasured; LCP never measured |
| `packages/core/src/env-example.ts:1-2` — "a PROJECTION … never a second hand-maintained list" | true of the mechanism, false of every app in the repo |
| `packages/mcp/src/from-action.ts:12-13` — a clean schema/execution split | both halves also set `name`, differently |
| `packages/query/src/naming.ts:4-5` — "ported rather than imported … tiers never go sideways" | presents a byte-identical duplicate as forced; the repo's own remedy is a tier-0 extraction |
| `packages/storage/src/driver.ts:11-15` — claims the local/s3 listing asymmetry was fixed | it was not; only the fabricated s3 value was removed |
| `packages/storage/src/driver-local.ts:164` — "`list()` must not read every file it lists" | `:297-300` calls `head()` per key, which buffers the whole object when the sidecar is missing |
| `packages/ai/src/pg-vector-sql.ts:147-148` — ordering identical to the memory store | true of the score, false of the order: pg breaks RRF ties by `id asc`, memory by insertion order |

Remaining package doc drift (the rest was relayed into [`13-docs-drift.md`](13-docs-drift.md)):
`packages/testing/CLAUDE.md:5` omits its `@ultimat3/cache` dep **and** claims deps are imported
dynamically when `registry-leak-guard.ts:7` is a static value import re-exported from the barrel;
`packages/create-ultimate/CLAUDE.md:3` says it "may import anything below it" where
`EDGE_ONLY_PACKAGES` permits exactly one — the doc invites the violation the rule blocks;
`packages/ui/CLAUDE.md:3` claims a `@ultimat3/schema` dependency that does not exist;
`packages/admin/CLAUDE.md:47` gives `bun test --filter @ultimat3/admin`, which has no `--filter` and
**runs zero tests silently**; `packages/manifest/README.md:7`'s import block omits a symbol line 9
calls (copy-pasting it is a `ReferenceError`); `packages/i18n/CLAUDE.md:22` calls two functions
internals while `src/index.ts:17,28` exports them — **fix the code** there, or the rule does not exist.

## The two tracked apps, against the scaffold

`packages/cli/src/templates/` is the executable convention. The demo is near-verbatim scaffold
output; `examples/dummy` predates it and diverges structurally — which matters because
`examples/dummy` is the app whose stated job is "every primitive, once, idiomatically".

- **`dummy/social-media-clone/apps/web/app/friends/service.ts:114-116` throws unconditionally**,
  exposed as an action with a UI, for a framework gap that **closed**: its `fix:` says "add
  `deleteWhere(filter)` to `packages/entity/…`", which exists at `query.ts:116,345`, `repo.ts:104`,
  `pg-driver.ts:306`. The app's own test already acknowledges the flip
  (`friends/repo.test.ts:22-24`) — the test was rewritten and the service was not. The demo ships a
  production image on every push to main with a permanently broken feature.
- **The demo's `job`, `live`, `e2e` and `eval` steps run against zero tests and report green** — it
  has only `.contract.test.ts` ×3; its job tests are `app/tasks/jobs.test.ts` and its live test is
  `app/messages/live.test.ts`, all of which run in `unit`. Committing `x.verify.json` closes this and
  the floor finding together.
- **`defineApi()` is the one registration call in one app and a task-only handover in the other.**
  `examples/dummy/apps/web/api/index.ts:45-51` covers all six kinds and exports the `Api` type; the
  demo has **no `defineApi`** in `api/index.ts` — its only one is `api/tasks.ts:10` covering
  `{ jobs, tasks }`, while that file's header repeats the one-call rule. The loss is the typed client:
  `examples/dummy/apps/web/shared/client.ts:45` builds one, the demo cannot. **The reference app is
  idiomatic here.**
- **Nine root-shape files where `examples/dummy` diverges from `x new`**: no `biome.json`, no
  `.gitignore`, no `.env.development`; `@postly/root` as the package name against
  `name: 'postly'` in `app.config.ts` (the `@postly/root` form leaks into the manifest's `app.name`);
  `bin/dev` instead of `x dev`; no `verify`/`lint` scripts; a different `typecheck`; a different
  bunfig preload; a `composite` tsconfig. Note the inversion: the root tsconfig references the demo,
  whose own config has **no `composite: true`**, while `examples/dummy` has `composite` and is not
  referenced.
- **Three CLI commands the reference app invokes that do not exist**: `x db seed dev`
  (`package.json:23` — `DB_SUBCOMMANDS` has no `seed`), `x setup --json` (`bin/setup:7`), and a
  `fix:` line reading `x db seed --list` (`scripts/test-setup.ts:94`) — an unrunnable instruction
  inside an error.
- **Four error-code declaration styles across two apps**, where `packages/core/src/error-codes.ts:28`
  says "every other package calls `registerErrorCodes()`" and
  `packages/cli/src/error-contract.ts:133` makes an unregistered code a gate finding: `examples/dummy`
  uses it **zero** times; the demo in two files of four.
- Both apps put entities in `packages/db/src/schema/<name>.ts` and both ship a
  `packages/db/src/client.ts` — **the scaffold is the outlier on both**, and here the apps are right.
  Both apps also drop the scaffold's run-once `backfill` service.

## What is genuinely clean — do not spend time here

Verified and sound: the root `CLAUDE.md` tier table (**row for row identical** to
`scripts/lib/tiers.ts`, drift-tested); the 17 verify steps and their order; `PRIMITIVE_KINDS` at
exactly eight; the `--define` and `replicas: 1` claims; `framework.manifest.json` vs the tier table;
`examples/dummy`'s absence from tsconfig references (correct — pinned in `expectedRed`);
`x.verify.json`'s 14 steps (a *floor*, not the step list — the omissions are deliberate).

**Zero real TODO/FIXME/HACK debt**, and mechanically so: three separate tests refuse to let a
generator emit one, and all 15 matches are the rules themselves or an ISO-4217 placeholder. **Zero
commented-out code** (all 30 regex hits are wrapped prose or generator samples). **Zero `@deprecated`
markers** in tracked source. **Zero finished transitional shims** — all five "legacy" comments
describe upstream protocols the code must still speak. No stale build artifacts; every workspace glob
and tsconfig reference resolves.

Minor: 15 symbols carry `export` but are referenced only in their own file and appear in no
`src/index.ts`; three declared-but-unimported deps (`@ultimat3/cache` and `@ultimat3/pwa` in the demo,
`@ultimat3/render` in `examples/dummy/packages/ui`); one imported-but-undeclared
(`@ultimat3/cli` in `examples/dummy/apps/web`).

## Sequencing

Driver divergence first — A1–A15 are live wrong answers, and A1, A2, A3 and A8 are the ones a user
meets. Deletions next, coordinated with [`08-architecture.md`](08-architecture.md) so a deletion and a
patch do not collide. The tier-0 extractions (`isRecord`, `splitWords`/`pluralize`, `formatBytes`, the
byte parser) are one PR each and each removes a place a future divergence can hide.

## Tests

- **Driver-parity tests are the deliverable here**, not per-bug tests. Every A-row is a case that
  should run against both implementations of its interface from one table — the `*-parity.test.ts`
  pattern the repo already has for jobs, extended to cache tiers, storage drivers, auth adapters, ai
  providers, vector stores and mail transports. A parity suite would have caught most of this section
  before it shipped.
- A test that `defineEnv`'s named export exists in every app root, so the drift gate cannot idle again.
- A budget test asserting every **declared** metric is either checked or reported unmeasured.

## Done when

- Every A-row resolved with the two sides agreeing, proven by a parity test.
- The four tier-0 extractions landed and every duplicate deleted.
- The eight lying headers corrected; both apps carry `x.verify.json` and an `envSchema` export.
- `bun run verify` green.
