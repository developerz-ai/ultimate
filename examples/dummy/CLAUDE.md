# Postly

Multi-tenant team blog on Ultimate. Orgs own members; members write posts; posts get comments
and likes; each org sits on a billing plan; a nightly digest mails every member at 09:00 in
their own timezone.

This app is the framework's reference application — Ultimate's CI runs `x verify` here and
**blocks** on the result through `scripts/reference-app-gate.ts`. As of 2026-11, both tracked
apps' `expectedRed` tables in `scripts/lib/gated-apps.ts` are empty: all declared steps must pass,
and neither app has a pin to remove. `--unpin` is retained only for future pins:
`bun run ../../scripts/reference-app-gate.ts --unpin examples/dummy:<step>` from this app's root.
New failures are regressions to fix, not pin. Keep it small, keep it idiomatic. A clever file in
Postly is a bug.
(`dummy/social-media-clone` runs through the same gate — it is the deployed demo, not the reference
app. Both apps must pass independently. Idiom is decided here.)

## Commands

| Task | Command |
|---|---|
| setup | `bun run setup` (installs, writes `.env`, migrates, seeds) |
| dev | `bun run dev` → `x dev` (web + sync + worker + scheduler, MCP on `ws://localhost:9229`) |
| verify | `bun run verify` → `x verify` — the only gate |
| migration | `x db gen "<message>"` then `x db migrate`. Never hand-write SQL |
| seed | `x db seed dev` |
| one test type | `x test unit\|contract\|live\|job\|e2e\|eval` |
| manifest | `x manifest --json` (regenerated every build; never edited) |

`AGENTS.md` is a symlink to this file. Facts (routes, actions, policies, jobs) are
`x.manifest.json`'s, always right; this file holds what code cannot say. Point an MCP client at
the dev server: `routes.list`, `schema.describe`, `policies.list` answer faster than grep.

## Layout

```
app.config.ts                  the one config file
x.manifest.json                GENERATED facts: routes, entities, actions, jobs, policies
apps/web/site/                 static/isr, 0kb JS baseline, SEO-critical
apps/web/app/                  auth'd, stream/spa, realtime, feature-sliced
apps/web/api/                  actions + tasks only, no rendering
apps/web/shared/               tokens, policies, entity types — leaf
apps/admin/                    defineAdmin dashboard, mounted at /admin, MCP on
apps/mobile/ apps/desktop/     placeholders — the packages are already reusable
packages/domain                pure types + constants, no I/O
packages/db                    entity() + migrations + seeds, no business logic
packages/core                  business services shared by web, admin, worker
packages/i18n                  en + es catalogs, feature-namespaced
packages/ui                    app components on @ultimat3/ui
packages/mcp                   the app's own MCP tools + prompts
```

`apps/web/shared/global.scss` is the app's global CSS layer — `@ultimat3/ui`'s custom properties
and its reset — and `apps/web/shared/global.ts` is the one-line side-effect import that puts it in
the module graph, which is what makes the framework's boot scan load it once for both surfaces. No
other stylesheet in the app emits top-level CSS: every module is its own Sass compilation, so a
second emitter would duplicate the `:root` block. A document that carries none is
`X_STYLES_GLOBAL_MISSING` from the gate's `budgets` step. **There is no `/signin` or `/signup`
page**: sign-in is `GET /auth/sso/github` (and `/auth/sso/corp` with an IdP configured), mounted by
`app/auth/sign-in-routes.ts`; sign-OUT is the `endSession` action
(`app/auth/actions/end-session.ts`: it revokes the session, expires its cookie, sets the demo cookie
to `signed-out` and redirects, and the layout's native form posts to it). There is no Better Auth
wrapper in this repo. The page route table is exactly `site/` + `app/` + `api/`, and
`site/page.tsx`'s CTA points at `/pricing` because that is the funnel that exists.

`NotAMember` (`X_ORG_NOT_A_MEMBER`) lives in **`@postly/core`**, beside the `memberOf` whose `null`
it refuses — it moved down from `apps/web/shared/errors.ts` on 2026-08-24 when `packages/mcp` needed
the same refusal and could not reach `apps/web/`. Every surface that resolves a tenant resolves it
the same way: `memberOf(ctx.actor)`, then `member.orgId`, never `ctx.actor.orgId` — core's `Actor`
types that `string | undefined`, so it is neither an `OrgId` nor evidence of a membership.

An org API key (`/v1`) has no membership: `postPublish` and `ctx.posts.publish`/`authorship` decide it
by `ctx.actor.orgId`, the key's own org (`app/runs/keys.ts`'s `ORG_KEY_SCOPES`).

`apps/web/shared/actor.ts` is the app half of the actor — the member row, their org, the request
clock — read through `useActor()`. It rides on core's own `ActorFacts` seam, on the SAME actor
every policy reads (`memberOf`, `@postly/core`), and `postlyActor()` is the one constructor for a
signed-in Postly actor. It was a `ctx.session` service nothing registered until 2026-08, which is
to say every `app/` render was a `TypeError`; an actor nobody resolved facts for is now
`X_ACTOR_UNRESOLVED`. Never a second answer to "who is calling". `useCan('post:publish')` is how a
component asks about a permission, and the row-level half of any rule is decided by the server,
never in the browser.

`imports.test.ts` at the app root loads every module and checks every named import against what
the packages actually export. Both halves matter: Bun's test runner links lazily, so a symbol that
does not exist is `undefined` under `bun test` and a hard failure under `bun run`.

Feature slice: `apps/web/app/<feature>/{entity,repo,service,actions,mutator,live,jobs,policy,ui}.ts`,
plus `backfills/<name>.ts` for a one-pass table sweep.

| File | Owns | Never |
|---|---|---|
| `entity.ts` | view schemas + invariants for this feature | I/O, policy |
| `repo.ts` | SQL for this feature | business rules, HTTP |
| `service.ts` | business logic composed from repos | HTTP, rendering, raw SQL |
| `actions/<name>.ts` | one `action` or `mutator` per file — a mutator's `server`, `policy`, `conflict` | logic — delegate to `service.ts`; DECLARING `local`, which lives one file over |
| `live/<name>.ts` · `queries/<name>.ts` | one `query` per file, `live: true` or not | writes |
| `jobs/<name>.ts` · `tasks/<name>.ts` | one `job` / `task` per file | inline slow work |
| `backfills/` | `backfill()` sweeps — a job factory, so each one registers in `defineApi({ jobs })` | a `step` of its own; the pass mints one per page |
| `policy.ts` | `policy` rules — `can()` or `definePolicy()`, both returning the same `Policy` | data shaping |
| `ui/` | Solid components | fetching, business logic, authz |

## Conventions

- Route file = `export const config = defineRoute({...})` + `export function Page()`. No default
  exports anywhere; Biome fails the build on them.
- Every route sets `render`, `offline`, `hydrate`, `meta`. `site/` routes need `meta.description`
  (50–160 chars) or the build fails.
- A feature is a folder under `apps/web/app/<feature>/`. Never a `lib/`, `utils/` or `helpers/`
  directory: those names mean the code has no owner. Logic two apps need goes to `packages/core`.
- One way per thing: deleting the alternative is the fix, never documenting both.
- Entities live in `packages/db`; a feature's `entity.ts` owns only that feature's view schemas.
- One authz definition. `policy.ts` predicates are reused verbatim by HTTP, live queries, jobs,
  MCP tools, and admin. Never re-check authz inside `handle`.
- `t` is two different things by file kind: the schema namespace in declaration files, the i18n
  translator (`useI18n()`) in components. Never both in one file. A declaration file imports the
  schema `t` from the package it declares in — `@ultimat3/action` in `actions/`,
  `@ultimat3/query` in `live/` and `queries/`, `@ultimat3/jobs` in `jobs/`, `@ultimat3/mail` in `mail.ts`,
  `@ultimat3/mcp` in the MCP package — never reaching past it to `@ultimat3/schema`. It is the same
  object either way. A module that declares no primitive (a feature's `entity.ts` view schemas)
  imports `@ultimat3/schema` directly, because that already is its one import.
- Money is `{ minor, currency }`. Arithmetic in `packages/core/src/billing.ts`; formatting only
  in `<Money>` at the edge.
- Dates are UTC instants in the DB, rendered only through
  `<DateTime value={at} timeZone={member.tz} dateStyle="long" />` — the prop is `timeZone`, and
  `format` takes a `DateTimeFormatter` FUNCTION rather than a style name. `<RelativeTime>` is the
  "3 minutes ago" half. Both from `@ultimat3/ui`; `apps/web/app/settings/page.tsx` is the worked
  call.
- Colours are `var(--color-*)` from `@ultimat3/ui` tokens. A raw hex fails lint.
- User-facing strings come from `t('<feature>.<key>')`. A missing key renders `⟦key⟧` and fails
  `x verify`. A new key goes in **both** `packages/i18n/catalogs/en.json` and `es.json`: an English
  fallback in the Spanish catalog is worse than a loud `⟦key⟧`.
- A new action sets `mcp: { expose: true }` unless it must never be agent-callable, and then a
  comment says why (`runs/actions/issue-run-key.ts`).
- `idempotencyKey` on every job is required by the type. Keys derive from `input` only. A
  `backfill()` supplies its own — the sweep's `name` — so one live pass runs per name, forced or
  not, and a second kick is the same pass rather than a second writer on one table.
- A backfill's `handle` is **at least once**: it runs before its checkpoint lands, so an attempt
  cancelled between the two replays that page whole. Write through `upsertAll`, `updateWhere` or a
  statement whose second run changes nothing — never `count + 1`. What a step persists is a
  **cursor**, never the page. `app/posts/backfills/post-excerpts.ts` is the worked example, and its
  `.job.test.ts` asserts the projection twice through equals once through.
- Two policy authoring forms, and the choice is who reads the denial. `can(permission, predicate)`
  where only an agent does — the reason is `x actions show`. `definePolicy(permission, { deny,
  check })` where a person does: `deny` is a message KEY, so the refusal goes through `t()` like
  every other user-facing string. Same `Policy` object either way, so every surface evaluates them
  identically and neither form is a second authz path.
- `packages/db/src/client.ts` NAMES its driver rather than taking `database()`'s default, because
  the seed and the app have to write and read one store. `postgresDriver()` everywhere except
  `bun test`, where `testDriver()` is memory until a test installs its migrated database
  (`app/posts/repo-join.test.ts`).
- Tests sit next to their source: `<file>.test.ts` (unit), `.contract.test.ts`, `.live.test.ts`,
  `.job.test.ts`, `.e2e.test.ts`, `.eval.test.ts`.
- A route that reads or writes over the socket declares an `island()`, and the hook call lives in
  that island's component. An island builds NOTHING of the realtime runtime: `x build` prepends the
  bootstrap that installs it, the document names the sync node in its `<head>`, and every island on
  a page shares one record store and one socket (plan 101). The hooks are the whole API:
  `useQuery` (reads — `/feed`'s live `liveFeed`), `useRecord` (one record), `useChannel` (keeps
  records current — `org-posts`, `app/posts/channel-ref.ts`), `useMutation` (writes over HTTP).
  A component calling a hook on a route with no island is `X_LIVE_ROUTE_NO_ISLAND`.
- **A record lives in the page's store once, and islands READ it — they never hold a copy.**
  `/posts/{id}` has two islands showing `posts:<id>`: the like control seeds it (`postRecord`),
  joins its channel and writes it; the header's `likes-badge` only reads it — the chunk ships no
  socket. A like in either tab moves both. A query whose rows are whole entity rows declares
  `rows: <entity>.$schema`, which is what makes its answer a record envelope the store adopts.
- **A channel is declared in two halves on one ref.** `app/posts/channel-ref.ts` is the browser
  half (`channelRef` — name, params, catch-up read; no entity), `app/posts/channels.ts` the server
  half (`channel(ORG_POSTS, { records: [posts], policy: feedRead })`, registered on import). An
  island importing the server half would bundle `@postly/db` and `@ultimat3/entity`.
- **A count an island shows is phrased by the catalog's forms, in the browser** — the server sends
  every CLDR form of the key (`shared/plural-forms.ts`) and `shared/plural-text.ts` picks one with
  `Intl.PluralRules`. A record another tab moved can hold a count no pre-rendered string covers.
- The optimistic twin (`app/posts/like-mutation.ts`) writes `tx.posts.update(key, fn)` into the
  store's OVERLAY, keyed explicitly; a refusal takes the overlay back. `type-pins.ts` beside it is
  the build error that keeps `@ultimat3/action`'s `LocalTable` and realtime's store tx one shape.
- **Every island in this app carries `<name>.island.states.ts`, enforced by
  `guards/island-without-states.ts`.** The shot harness refuses `WebSocket` outright
  (`packages/cli/src/island-harness-script.ts:70`), so `feed` and `like` render their server
  state and hold it, and `contact-sales` takes the SERVER's markup over, which the harness renders
  none of. Each states file says which it is. `settings` and `likes-badge` open no socket.
- An island that has states worth reviewing carries a sibling `<name>.island.states.ts`, and
  `x shot --island <name> --json` photographs every one of them into `.x/shot/island/<name>/`.
  `apps/web/app/settings/settings.island.states.ts` is the worked example: `empty-options` is what
  the editor looks like when the preference-options read comes back empty, `save-failed` is the
  retry banner after a write the server refused, and neither is reachable by clicking. That file is
  PURE DATA — no JSX, no `solid-js`, and its one import is an `import type` the compiler erases,
  because the command that takes the pictures has to know the complete expected list before a
  browser exists. `X_TEST_ISLAND_STATES_NOT_PURE` is what an import of the component earns.
  `SettingsProps.status` exists for this and only this: `saved` and `failed` are signal states a
  reviewer cannot reach without a server that really fails, so the prop makes them addressable and
  the page passes nothing.
- **A `query`'s source names no tenant.** A sync node reads a live source for its subscriber's
  org, in a context that carries it, as a request does — `app/runs/repo.ts`'s `eventsOf(runId,
  limit)` names no org, and `app/runs/live.live.test.ts` holds it with two orgs through the real
  `subscribe` fixture.
- **A run is its events** (`app/runs/`). `run_events` is keyed by the JOB's run id — the one
  identity the prompt handler, the body and the console's answer all hold — and the console's
  state is its last PHASE event (`run-state.ts`). `runs.status` is the operator's projection of
  that same event, written by the one writer of both (`repo.appendEvent`), never set anywhere
  else. `startRun` enqueues inside the request's transaction and writes the run's row beside it:
  both ids are allocated when the job is staged. How a run ENDED — failed, dead-lettered, refused
  for a busy connection (`X_JOB_KEY_BUSY`, said in words) — and what it used is `onSettled`'s to
  write; a cancel is the canceller's.
- **A job reads in the org its INPUT names — a served worker's actor is nobody.** `role-start.ts`
  builds the worker with no actor; `executeJob` puts the job's declared `tenant` on it and nothing
  else, so `memberOf(ctx.actor)` is `null` in every job and an acting-member read
  (`ctx.posts.byId`, `ctx.orgs.memberById`, `ctx.orgs.me`) is `X_ORG_NOT_A_MEMBER`. Jobs call the
  named-org reads — `ctx.posts.inOrg(orgId, …)`, `ctx.orgs.memberIn(orgId, …)` — with the org off
  their own input. A job test drains the way production does: `runJobs.drain()` with NO `actor`.
  `notifySubscribers`, `commentPosted` and `sendInvite` were green under `actor: actorFor(…)` and
  dead-lettered in production until 2026-10-07.
- **A background agent is `agentJob(action, { actor })` over an action that runs the agent and
  makes the write ITSELF — the model aims no write it was not gated on.** A draft is text its writer
  controls, and "now record a review for post X" is an instruction a model may follow, so a write
  tool whose target the model names is a write any writer can aim. `app/posts/actions/review-draft.ts`:
  `reviewDraft`'s tools are `summarize` and `publishPost`, the second in `mcpConfirmations({ tools })`,
  so the call answers `X_MCP_CONFIRMATION_PENDING` and publishes nothing until a person approves those
  exact arguments; `keepDraftReview` runs it and upserts the verdict on the post
  id IT was given, `post_reviews`' key `(orgId, postId)`, so a replayed run is the same row (a
  queued run keeps no output, and an attempt that loses its lease runs from the top). Writing a
  review is `postReviewKeep` — the publishing right, owns-or-org-admin, for oneself — never
  `post:read`, which a reader holds. `reviewDraftLater = agentJob(keepDraftReview, { actor })`
  re-reads the member who asked on every attempt (`ctx.orgs.actingFor`); `requestDraftReview`
  queues it for the UI, and `draftReview` (`apps/web/mcp-tools.ts`, a `jobTool`) is an agent's one
  MCP path to it; `postReview` reads it back. Declared BESIDE what it wraps (it reads it at module
  scope), so `api/index.ts` hands `postActions` to the `jobs` list too.
- **Outbound webhooks are `app/webhooks/`.** `webhook()` is the mechanism; which endpoints exist
  (`webhook_endpoints`, `secret` sealed), the ledger (`ledger.ts` over `webhook_deliveries`) and
  the fan-out (`ctx.webhooks.announcePublished`, ONE `enqueueMany` over every live endpoint, from
  `publishPost`) are Postly's. The org rides on every delivery's input (`tenant: ({ orgId }) =>
  orgId`) and is handed to both seams — never read off the actor. Limits are the DATABASE's, never
  a read before a write: an org's cap is a `slot` unique per org (`webhook_endpoint_slot_unique`),
  and the ledger numbers each endpoint's attempts with a unique `seq`, so concurrent deliveries
  each count from the row before them. A receiver URL is screened at REGISTRATION by the
  delivery screen's own rules (`url-screen.ts`: https, no private or loopback address) — one it
  would refuse dead-letters every publication and is never disabled. `removeWebhookEndpoint`
  (owner, no MCP) is a leaked secret's remedy.
- **`repo.appendEvent` updates the run by id**, one row by primary key. A filtered write
  (`updateWhere`) re-reads every live window over that entity on the next change; the framework
  defect that left that change undelivered is fixed in 23.0.0, and a by-id update needs no re-read.
- **The admin is mounted** — `apps/admin/app/admin/admin.ts`, the path `x dev` and the container
  scan — and the owner's grants for it are in `shared/policies.ts`: a permission the dashboard
  asks for and no role grants is `X_PERMISSION_UNGRANTED` in the `policy` step.
- **`x dev` needs a master key once the app seals anything**: `connections.credential` and
  `.exit` are `.sealed()`, the stored scrape session and a prompt's answer are sealed too, and with
  no `.secrets.key` each refuses with `X_SEAL_KEY_MISSING` — `x secrets init`. `bun test` and the
  e2e harness install a throwaway key themselves.
- Every prompt carries `<name>.evals.ts` (the cases) and `<name>.vN.baseline.json` (the recorded
  scores). A prompt with no eval fails `x verify` with `X_EVAL_MISSING`, and an eval with no
  committed baseline fails it with `X_EVAL_BASELINE_MISSING`; the gate is the drop from the
  baseline, so re-record with `ULTIMATE_EVAL_RECORD=1 x test eval` and commit the diff — never
  inside a `x verify`, which refuses to run while recording.
- Test fixtures come from `scripts/test-setup.ts`, the one preload in `bunfig.toml`. `seed` and
  `actorFor` are Postly's — REGISTERED and DECLARED there, in the same file: the
  `declare module '@ultimat3/testing' { interface Fixtures { … } }` beside `defineFixtures` is
  what makes `test('…', async ({ seed, actorFor }) => …)` typecheck at all, and its absence was 48
  of the 116 `typecheck` errors this app carried on 2026-08-24. `seed('dev').pick({ … })` answers each
  label's own ENTITY row (`SeedRowFor`, keyed off the `<entity>:<name>` prefix), never a bag of
  `unknown`. Everything else is the framework's — `clock`, `mail`, `network`,
  `runJobs` and `subscribe` built in-process, and `page`, `budget`, `signIn`, `deploy` waiting on a
  driver (`X_TEST_FIXTURE_UNAVAILABLE` until one is installed). `subscribe` builds a whole `sync`
  node in this process — see `app/posts/live.live.test.ts`, whose five tests had never run. A test that destructures a name
  nobody registered fails with `X_TEST_FIXTURE_UNKNOWN` — register it there, once. Never register
  a framework name here: two apps would then disagree about what a `page` is.

## `guards/` — this app's own conventions, as build errors

`guards/*.ts` is discovered by `x verify` (never registered) and every guard runs inside the
`boundaries` step: the directory IS the registration, so delete a file to drop its rule and write
`x g guard <name>` to add one. **Every guard `x new` ships runs here, `As of 2026-10`** — the
list is `SHIPPED_GUARD_NAMES` in `packages/cli/src/templates/scaffold-guards.ts`, and
`x doctor --json` names any this app lacks (`data.guards.missing`) — each with its own `.test.ts` beside it, which the `unit` step runs and the gate
does not import. Their codes are APP codes derived from the guard's name, so none of them is in
`wiki/Error-Codes.md` or in any manifest. Every file here is byte-identical to
`scaffoldGuardFiles()`'s output (`packages/cli/src/templates/scaffold-guards.ts`) — a guard edited
in place is a rule this app and `x new` disagree about, so the repair for one of them goes in the
template and comes back through a re-emit.

**Two of the nine were absent until 2026-09-08, and both were absent because they were broken in
the framework's own template — never to make the gate green.** Every finding either one produced
here was a false positive, which is the failure this repo names outright: noise is how a rule gets
switched off. Both are fixed in `packages/cli/src/templates/` and both now report **zero** against
this app.

The two guards measured here, and their repairs, are recorded in
[`docs/history/reference-app.md`](../../docs/history/reference-app.md).

## Boundaries (build errors, not lint warnings)

| Rule | Error |
|---|---|
| `site/` imports `app/` | `X_BOUNDARY_VIOLATION` with the transitive chain |
| `shared/` imports `site/` or `app/` | `X_BOUNDARY_VIOLATION` — `shared/` is a leaf |
| `app/` imports `api/` at runtime | types only; call the typed client instead |
| a route touches the DB | only `repo.ts` may |
| a service imports HTTP | a service that knows about requests cannot be reused by a job |
| cross-feature `repo.ts` import | go through that feature's `service.ts` |
| `packages/domain` performs I/O | `X_BOUNDARY_VIOLATION` |

## Gotchas

- `local()` in a mutator must be replayable: no `Date.now()`, no `Math.random()`, no I/O — and
  **convergent**, which is the stronger rule the weaker one hides: it is replayed on every rebase,
  so applying it N times has to equal applying it once. `likeCount + 1` is the counter-example that
  shipped; `post.likedByMe ? {} : { likedByMe: true, likeCount: post.likeCount + 1 }` is the repair.
- **A local twin lives in the BROWSER-reachable module of its feature, and the declaration imports
  it.** `app/posts/like-mutation.ts` holds `likePostLocally` and the `LocalTables` augmentation;
  `app/posts/actions/like-post.ts` writes `local: likePostLocally`. An island cannot import that —
  the declaration drags `@ultimat3/action`, the policy and the Postgres client into the chunk — and
  `local` is by definition the half that runs in the tab, so the file a browser can load is its one
  home. Two copies is two declarations of one intent.
- A live query must be bounded (`orderBy` + `limit`) or `x verify` rejects it.
- `publishPost` and `likePost` look alike on purpose: `publishPost` is an `action`
  (server-authoritative, no local twin), `likePost` a `mutator` because likes work offline. The
  primitive encodes the difference; never merge them.
- `X_DB_DRIFT` means an entity changed with no migration: run the `fix:` it prints, never edit SQL.
- The digest's DST cases in `packages/core/src/digest-schedule.test.ts` are its scheduling spec.
- The digest schedules per (org, zone), never per org alone — timezone is a member column, so one
  org spanning two zones is two deliveries at two instants. The unit is a group and not a member
  because the post window is org-scoped and bounded by the group's own slot: reading it once per
  member is the same query N times.
- Plan prices are per-currency rows in the plan catalog; never convert currencies at runtime.
- A service reaches the app through `shared/services.ts` and nowhere else. `CtxServices` carries a
  string index signature, so `ctx.whatever` compiles as `unknown` and an undeclared service is a
  runtime `TypeError` rather than a build error — `ctx.storage.ensureBucket()` shipped that way
  until it was deleted for `app/orgs/avatar.ts`, which calls `@ultimat3/storage`'s real surface.
  `ctx.auth` is the ONE remaining instance, not a pattern to copy — `ctx.billing.charge(...)` was
  the other until 2026-08-24, when the call was deleted from `app/orgs/service.ts` exactly as
  `ctx.storage` was: `upgrade()` now moves the plan and returns the quote, which is every part of
  an upgrade an app with no payment provider owns. **A service that IS declared and still unregistered
  is worse**, because the type checks: `ctx.session` and `ctx.channel` were both, and both are
  gone as of 2026-08 — the member row moved onto the actor's facts, and the channel publish that
  dead-lettered `notifySubscribers` on every run is deleted, because a `ChannelHub` is built by the
  socket process and no seam hands one to an app.
- Uploads are `grantUpload` wrapped in an app `action` — the app owns the policy, the framework
  owns the key and the signature. Nothing here builds an object key by hand. A grant lands in
  `pending/`; a second action promotes it through `runtime.ts`'s `postlyUploadScanner()`.
- `withLock`, `variant()`: `app/orgs/avatar*.ts`; `partitionBy`, `smsChannel`: `app/quota/`;
  SAML: `app/auth/sso.ts`, mounted only when `POSTLY_SSO_IDP_METADATA` is set.
- `app/auth/login.ts` is the whole of "log in with GitHub" — `defineAuth` + `oauthLogin`, and the
  three decisions an app owns: `providers`, `link` and where a signed-in member lands.
  `app/auth/sign-in-routes.ts` mounts its `start`/`callback` on `runtime.routes` (`As of 2026-11`),
  built on the first request, never at import; the ONE `GET /auth/sso/:provider` answers `corp` as
  the SAML start and anything else as the OAuth start. Credentials are `GITHUB_CLIENT_ID` /
  `GITHUB_CLIENT_SECRET`; unset, `/auth/sso/github` is the same 404 an unknown provider gets.
- **Who a request is: `app/auth/authenticator.ts`**, installed at module scope in every environment.
  A session cookie (GitHub, SAML or a passkey minted it) is that session's MEMBER — `x_users.id` is
  the member's id, as passkeys and `x exercise` key it — read by `sessionMember` (`app/orgs/repo.ts`,
  three statements, the second cross-tenant read in the app) into `postlyActor`; an identity no org
  seated is itself with no grant; a forged, revoked or expired one is `null`, never a fallback.
- **No session cookie under `x dev` is the demo viewer** (`app/auth/demo-actor.ts`, a cookie naming
  one of four seeded members), and nobody anywhere else — the install fails closed
  (`fallback: 'production'`). It stays because a fresh clone has no GitHub client id, no IdP and no
  enrolled passkey, and every e2e suite signs in with its cookie (`e2e/fixtures/postly.ts`,
  `scripts/test-setup.ts`). Deleting it needs an e2e sign-in that mints a real session out of
  process — the in-process provider stubs (`login.test.ts`, `sign-in-routes.test.ts`) cannot serve
  a separate app process. The auth tables are `FRAMEWORK_SCHEMA` rows
  (`packages/cli/src/framework-schema.ts`), applied on every boot path, `ROLE=migrate` included. The
  seed writes no `x_users` row, so a seeded member signs in with GitHub only once a row with their
  id and a verified address exists.
