# Postly

Multi-tenant team blog on Ultimate. Orgs own members; members write posts; posts get comments
and likes; each org sits on a billing plan; a nightly digest mails every member at 09:00 in
their own timezone.

This app is the framework's reference application — Ultimate's CI runs `x verify` here and
**blocks** on the result, through the ratchet in `scripts/reference-app-gate.ts`: a step passing
today must keep passing, and the steps still being repaired are pinned by name in this app's
`expectedRed` table in `scripts/lib/gated-apps.ts` — repair one and delete its pin in the same
change, with `bun run ../../scripts/reference-app-gate.ts --unpin examples/dummy:<step>`. Keep it
small, keep it idiomatic. A clever file in Postly is a bug.
(`dummy/social-media-clone` runs through the same gate with its own
`expectedRed` entries — it is the deployed demo, not the reference app, and neither app's pins
excuse the other's red step. Idiom is decided here.)

## Commands

| Task | Command |
|---|---|
| setup | `bin/setup` (installs, writes `.env`, migrates, seeds) |
| dev | `bin/dev` → `x dev` (web + sync + worker + scheduler, MCP on `ws://localhost:9229`) |
| verify | `bin/check` → `x verify` — the only gate |
| migration | `x db gen "<message>"` then `x db migrate`. Never hand-write SQL |
| seed | `x db seed dev` |
| one test type | `x test unit\|contract\|live\|job\|e2e\|eval` |
| manifest | `x manifest --json` (regenerated every build; never edited) |

## Layout

```
app.config.ts                  the one config file
x.manifest.json                GENERATED facts: routes, entities, actions, jobs, policies
apps/web/site/                 static/isr, 0kb JS baseline, SEO-critical
apps/web/app/                  auth'd, stream/spa, realtime, feature-sliced
apps/web/api/                  actions + tasks only, no rendering
apps/web/shared/               tokens, policies, entity types — leaf
apps/admin/                    defineAdmin dashboard, MCP on
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
`X_STYLES_GLOBAL_MISSING` from the gate's `budgets` step. **There is no `/signin`, `/signup` or
`/signout`** — this file claimed all three were mounted "by the wrapped Better Auth integration"
until 2026-08, which contradicted its own gotcha twelve lines down: `app/auth/login.ts`'s two route
descriptors are declared, tested and **not served**, and there is no Better Auth wrapper in this
repo. The route table is exactly `site/` + `app/` + `api/`, and `site/page.tsx`'s CTA points at
`/pricing` because that is the funnel that exists.

`NotAMember` (`X_ORG_NOT_A_MEMBER`) lives in **`@postly/core`**, beside the `memberOf` whose `null`
it refuses — it moved down from `apps/web/shared/errors.ts` on 2026-08-24 when `packages/mcp` needed
the same refusal and could not reach `apps/web/`. Every surface that resolves a tenant resolves it
the same way: `memberOf(ctx.actor)`, then `member.orgId`, never `ctx.actor.orgId` — core's `Actor`
types that `string | undefined`, so it is neither an `OrgId` nor evidence of a membership.

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
| `actions.ts` | `action` declarations | logic — delegate to `service.ts` |
| `mutator.ts` | `mutator` declarations (local twin + server) | I/O inside `local` |
| `live.ts` | `query` declarations | writes |
| `jobs.ts` | `job` declarations | inline slow work |
| `backfills/` | `backfill()` sweeps — a job factory, so each one registers in `defineApi({ jobs })` | a `step` of its own; the pass mints one per page |
| `policy.ts` | `policy` rules — `can()` or `definePolicy()`, both returning the same `Policy` | data shaping |
| `ui/` | Solid components | fetching, business logic, authz |

## Conventions

- Route file = `export const config = defineRoute({...})` + `export function Page()`. No default
  exports anywhere; Biome fails the build on them.
- Every route sets `render`, `offline`, `hydrate`, `meta`. `site/` routes need `meta.description`
  (50–160 chars) or the build fails.
- Entities live in `packages/db`; a feature's `entity.ts` owns only that feature's view schemas.
- One authz definition. `policy.ts` predicates are reused verbatim by HTTP, live queries, jobs,
  MCP tools, and admin. Never re-check authz inside `handle`.
- `t` is two different things by file kind: the schema namespace in declaration files, the i18n
  translator (`useI18n()`) in components. Never both in one file. A declaration file imports the
  schema `t` from the package it declares in — `@ultimat3/action` in `actions.ts`/`mutator.ts`,
  `@ultimat3/query` in `live.ts`, `@ultimat3/jobs` in `jobs.ts`, `@ultimat3/mail` in `mail.ts`,
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
  `x verify`.
- `idempotencyKey` on every job is required by the type. Keys derive from `input` only. A
  `backfill()` supplies its own — the sweep's `name` — so one live pass runs per name, forced or
  not, and a second kick is the same pass rather than a second writer on one table.
- A backfill's `handle` is **at least once**: it runs before its checkpoint lands, so an attempt
  cancelled between the two replays that page whole. Write through `upsertAll`, `updateWhere` or a
  statement whose second run changes nothing — never `count + 1`. What a step persists is a
  **cursor**, never the page. `app/posts/backfills/post-excerpts.ts` is the worked example, and its
  `.job.test.ts` asserts the projection twice through equals once through.
- Two policy authoring forms, and the choice is who reads the denial. `can(permission, predicate)`
  where only an agent does — the reason is `x actions describe`. `definePolicy(permission, { deny,
  check })` where a person does: `deny` is a message KEY, so the refusal goes through `t()` like
  every other user-facing string. Same `Policy` object either way, so every surface evaluates them
  identically and neither form is a second authz path.
- `packages/db/src/client.ts` NAMES its driver rather than taking `database()`'s default, because
  the seed and the app have to write and read one store. `postgresDriver()` everywhere except
  `bun test`, where nothing installs a client.
- Tests sit next to their source: `<file>.test.ts` (unit), `.contract.test.ts`, `.live.test.ts`,
  `.job.test.ts`, `.e2e.test.ts`, `.eval.test.ts`.
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

- `local()` in a mutator must be replayable: no `Date.now()`, no `Math.random()`, no I/O.
- A live query must be bounded (`orderBy` + `limit`) or `x verify` rejects it.
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
  owns the key and the signature. Nothing here builds an object key by hand.
- `app/auth/login.ts` is the whole of "log in with GitHub" — `defineAuth` + `oauthLogin`, and the
  three decisions an app owns: `providers`, `link` and where a signed-in member lands. Its two
  route descriptors are **declared and driven by `login.test.ts`, but not served**, and that is a
  framework gap rather than a shortcut here: an app's HTTP surface is composed in
  `packages/cli/src/serve.ts` out of actions, queries, assets, storage, islands and page routes,
  and there is no seam by which an app contributes a raw `Route` — `configureAuthenticator()` is
  the only app-installed hook of that shape. So `start`/`callback` stay exported and unmounted
  until that seam exists.

  **Two things blocked a Postly session and one of them is now closed** (`As of 2026-08-25`). The
  second was the schema: `BuiltinAdapter` reads `x_users`, `x_sessions`, `x_accounts`,
  `x_verifications` and `x_api_keys`, **nothing in the framework had ever created them**, and
  neither half was a file anybody could hand-write — `AUTH_TABLES` is DDL `@ultimat3/auth`
  exports "so an app can paste them into a migration", while `x db gen` diffs `describeEntities()`
  and these are not `entity()` declarations. The paragraph above used to record the symptom with
  no cause, and the cause was that nobody had asked which framework tables have an applier: five
  of them did not. They are now rows of `FRAMEWORK_SCHEMA`
  (`packages/cli/src/framework-schema.ts`), applied by `applySchema` — which is on every boot path
  there is, `ROLE=migrate` included — so `postlyAuth()`'s default adapter has tables to read.

  **What is left is the raw-`Route` seam alone.** Until it lands `start`/`callback` are unserved,
  which is why `configureAuthenticator()` is still uncalled, `ctx.auth` is still undeclared, and
  `app/auth/demo-actor.ts` still answers every development request as a declared viewer — its own
  warning says "this app mounts no sign-in route", and that sentence is now the whole of it.
