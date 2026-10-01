# Platform readiness for big systems

## Goal
Close the gaps that make a large, agent-written system on Ultimate hand-write boilerplate or work
around the framework. Proving case: a session-based scraping service — realtime dashboard, HTTP
API, MCP — sitting between a client system and a rented browser reached over a CDP URL. The
service itself is a later plan in its own repo; this plan is framework work only.

## Context
- Evidence, `As of 2026-10`, from five read-only surveys:

| Source | What it is | What it showed |
|---|---|---|
| a production SPA built without a framework | ~265k source LOC, SCSS + one store + one request seam | the patterns are right; 50–70k LOC is per-domain repetition one declaration would emit; 240 hand-written guards hold the rules |
| an existing scraping system | 46 browser integrations, one browser per run over CDP | one run per connection, per-connection secrets, egress per session, mid-run human input, usage per run — all hand-built |
| an earlier attempt at the scraping service | API + worker + dashboard, no framework | one contract hand-written three times drifted; enqueue and consume disagreed on the wire; a `retriable` flag nothing read |
| a downstream app on Ultimate 22.15.0 | 109 entities, 252 actions, 85 jobs, written by agents | 1,115 raw `sql` fragments (generator-induced), 41 raw `fetch(`, typed client past TS2589, 211 SCSS modules restating layout |
| this tree at `dad6e086` | — | see *Risks*: most of the frontend ask already ships |

- Stack: Bun only, Postgres with no ORM, SolidJS islands, SCSS modules + tokens. No new dependency
  in any slice.
- **No ninth primitive.** Each change lands on an existing one:

| Change | Primitive |
|---|---|
| sealed column | an `entity` column modifier |
| keyed concurrency, final attempt | `job` fields |
| typed client at scale | the `action` / `query` projection |
| per-session egress, browser provider, usage, sealed sessions | `scrape()` — a `job` factory (`packages/core/src/registrar.ts:71`) |
| style rules, transport gate | guards on the `boundaries` step |

- Reference patterns:
  - keyed fleet lease — `packages/jobs/src/leases.ts:18-34`, taken at `packages/jobs/src/worker-fleet-slots.ts:69`.
  - AES-256-GCM envelope — `packages/core/src/secrets.ts:15-22,167`.
  - typed repo handle — `examples/dummy/packages/db/src/client.ts:44` over `database()` (`packages/entity/src/index.ts:31`).
  - a guard as a file — `packages/cli/src/guards.ts:1-18`, scaffolded by `packages/cli/src/templates/scaffold-guards.ts:31-41`.
  - Sass `@error` carrying a code — `packages/ui/src/tokens/_mixins.scss:85-92`.
  - a declared-and-enforced job field — `packages/jobs/src/job.ts:74-82` (`X_JOB_CONCURRENCY_UNENFORCEABLE`).
  - remote CDP driver — `packages/scraping/src/driver-cdp.ts:46-49`.

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core` | 0 | `seal()` / `open()` for one value under the app's master key |
| `entity` | 2 | `.sealed()` column: sealed on write, opened on read, refused in predicates and views |
| `action`, `query` | 3 | the whole-app client type must typecheck at 300 actions; `pathStyle` stated once |
| `jobs` | 3 | `concurrency: { key, limit, whenBusy }`; `finalAttempt` on the run args |
| `ui` | 4 | `respond-down`, `respond-between`, `rem()`, `fluid()`; link-driven `Pagination`; `Link` as a button |
| `cli` | 5 | style guards, the browser-transport gate inside `boundaries`, typed-repo generator, `shared/browser-client.ts` in `x new` |
| `scraping` | 5 | per-session egress, CDP URL resolver, usage in the report, sealed stored sessions, in-run prompt over the job event bus |
| `examples/dummy`, `dummy/social-media-clone` | — | the run console proves the chain; the demo adopts the guards and drops its own helpers |

Land lowest tier first. Every new import goes down: `entity → core`, `scraping → core`,
`scraping → jobs`. Nothing is added to `SIDEWAYS_ALLOW`.

## Plan files (execute in order)
1. [`01-core-seal.md`](01-core-seal.md) — tier 0: one value sealed under the master key.
2. [`02-entity-sealed-column.md`](02-entity-sealed-column.md) — tier 2: `.sealed()` on a column.
3. [`03-action-client-at-scale.md`](03-action-client-at-scale.md) — tier 3: the typed client at 300 actions.
4. [`04-jobs-keyed-concurrency.md`](04-jobs-keyed-concurrency.md) — tier 3: one run per key, `finalAttempt`.
5. [`05-ui-ladder-and-links.md`](05-ui-ladder-and-links.md) — tier 4: the missing Sass helpers, server-rendered pager and button-link.
6. [`06-cli-style-guards.md`](06-cli-style-guards.md) — tier 5: seven shipped guards for stylesheets.
7. [`07-cli-browser-transport-gate.md`](07-cli-browser-transport-gate.md) — tier 5: raw `fetch(` refused in every app's `x verify`.
8. [`08-cli-typed-repo-generator.md`](08-cli-typed-repo-generator.md) — tier 5: `x g entity` emits the typed handle, never `sql`.
9. [`09-scraping-sessions.md`](09-scraping-sessions.md) — tier 5: egress, provider, usage, sealed sessions, prompt.
10. [`10-apps-run-console.md`](10-apps-run-console.md) — apps: one feature that exercises 01–09 end to end.
11. [`11-docs.md`](11-docs.md) — wiki, READMEs, stale lines, discoverability.

Parallel sets, path-disjoint: {01, 03, 04, 05}; then {02, 06, 07, 08}; 09 after 01 and 04; 10 after
all; 11 last.

## Done when
- `text().sealed()` round-trips through the typed handle; the physical column never holds the
  plaintext; a `where` on it is `X_ENTITY_SEALED_PREDICATE`.
- `rpc<Api['actions']>` typechecks over a 300-action fixture, with `pathStyle` stated nowhere in
  app code.
- Two runs enqueued under one concurrency key never overlap on two workers; `whenBusy: 'fail'`
  settles the second as `X_JOB_KEY_BUSY` without running its body.
- A scaffolded app's `x verify` is red on a raw `px`, a hand-written `@media (max-width`, a numeric
  `z-index`, a `styles.missing` read and a raw `fetch(` in an island — each naming file, line and
  fix.
- `x g entity widget` writes a repo with zero `sql` template literals and zero hand-written tenant
  predicates.
- A `scrape()` with `egress`, a CDP URL resolver and `auth.persist` runs on the fixture driver:
  the report carries `usage`, the stored session is sealed, the resolver's `release()` ran once.
- `examples/dummy` shows a run console: live event rows, a prompt answered mid-run, a refused
  second run. `bun run scripts/reference-app-gate.ts` green, `expectedRed` unchanged.
- `bun run manifest`; `bun run verify` green, all 20 steps.

## Risks / open questions
- **Falsified: "add a single data store".** One `RecordStore` per tab ships since 21.0.0
  (`docs/architecture/21-client-data-layer.md:165-182`). Nothing here adds a store.
- **Falsified: "add a single place to make requests".** `clientTransport`
  (`packages/core/src/client-transport.ts:31`) is the one function; the only browser `fetch` is
  `packages/core/src/client-dispatch.ts:62`. The gap is enforcement outside this repo
  (`wiki/Client-Data.md:33-35`) — slice 07.
- **Falsified: "add SCSS".** Modules, tokens, themes and 30+ mixins ship
  (`packages/ui/src/tokens/_mixins.scss`). Missing: three helpers (slice 05) and every stylesheet
  rule except raw colour (slice 06).
- **Falsified: "wrap a CDP URL".** `RemoteBrowserOptions.cdpUrl`
  (`packages/scraping/src/driver-cdp.ts:46-49`) already takes one. Missing: resolving it per
  session, with a release and a cost — slice 09.
- **Falsified: "the client hooks need realtime".** A non-live `useQuery` is one HTTP read
  (`packages/realtime/src/use-query.ts:1-4`), and realtime is on by default
  (`packages/core/src/config.ts:295`). The downstream app polled because it had set
  `enabled: false`. Slice 11 documents the non-live path.
- **Falsified: "shared island chunks should default on".** Off by measurement
  (`packages/core/src/config-islands.ts:9-17`): a small island went 712 → 16,288 B. Stays opt-in;
  slice 11 documents when to turn it on.
- **Dropped by the owner: an app CLI.** `packages/cli/src/registry.ts:1-2` stays closed; an app's
  dev commands are Bun scripts.
- **Not reopened: quotas and plans.** `docs/idea/19-mechanism-not-convention.md:88` refuses a plan
  model. A run *measuring* what it used is mechanism; slice 09 adds the measurement only.
- **Semver.** Slice 07 makes an existing app's gate red where it was green: 41 raw `fetch(` in the
  surveyed downstream app. Ship it in the next major with a `BREAKING —` entry, or decide it is a
  patch because the rule was always documented. Owner's call before 07 starts.
- **Owner decision carried, not taken here:** `recover: 'agent'`
  (`packages/scraping/src/recover.ts:40-44`) is listed in
  [`../../../09/28/101-audit-bugs-and-gaps/overview.md`](../../../09/28/101-audit-bugs-and-gaps/overview.md)
  as ship-or-delete. Evidence for *ship*: 55 of 830 monthly sessions on one integration failed on
  "a page the code does not know". Shape if shipped: an `llm()` step bounded by steps, seconds
  and cost, with an action allowlist and one event per action.
- **Existing plaintext.** `auth`'s `mfa_secret` is plaintext for lack of a seam
  (`packages/auth/CLAUDE.md:121-122`). Slice 01 supplies the seam; migrating shipped rows is a
  breaking data change and is not planned here.
- **Overlap, do not repeat:**
  [`../../../09/22/102-downstream-app-gaps/overview.md`](../../../09/22/102-downstream-app-gaps/overview.md)
  owns raw `api/**/route.ts`, audited queries, Object Lock and append-only entities. Slice 10 uses
  `appendOnly` if 102 slice 04 has landed and a plain entity if not.
- **Deferred, with the evidence that ranks them** (a later plan):

| Gap | Evidence |
|---|---|
| `defineError({ code, status, cause, fix })` | 565 hand-written classes, 51 status registrations in one app |
| a native form's refusal answer (`setRedirect` covers success, `packages/http/src/redirect.ts:16`) | 234 wrapper calls in 142 files |
| route-group defaults | 111 routes × ~25 repeated lines |
| a catalog subset for `t()` inside an island | 94 label types, 3,092 lines of label files |
| server-first dialog, menu, combobox with a small enhancer | ~2,200 app-side LOC; 13 catalog components at 0 imports |
| `QueryRef` derived from the declaration | `wiki/Queries-And-Live-Queries.md` "Not derived" row |
| a test kit: `renderView`, automatic job-driver setup | 183 casts in 119 files, 165 `setJobDriver(` |
| a `task` that runs without a companion job; a boot hook | 35 task/job pairs, 2 boot stand-ins |
| a failure bundle an agent can act on | built by hand in two of the surveyed systems |
| proxy inventory, captcha, OTP relay | product features of a scraping service — the app's |

- New codes, each through `bun run new-error-code`: `X_SEAL_KEY_MISSING`, `X_SEAL_INVALID` (core);
  `X_ENTITY_SEALED_PREDICATE`, `X_ENTITY_SEALED_IN_VIEW` (entity); `X_JOB_KEY_BUSY` (jobs);
  `X_SCRAPE_EGRESS_UNSUPPORTED` (scraping). Guard codes are the app's, derived from the filename.
