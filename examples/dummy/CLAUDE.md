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
`X_STYLES_GLOBAL_MISSING` from the gate's `budgets` step. `/signin`, `/signup` and `/signout` are mounted by
the wrapped Better Auth integration, so they are in the route table without living in `site/`.

`apps/web/shared/actor.ts` is the app half of the actor — org, orgs, member row, request clock —
read through `useActor()`. Core's `Actor` (id, roles, scopes, tenant) is the framework half and
stays that: `useCan('post:publish')` is how a component asks about a permission, and the row-level
half of any rule is decided by the server, never in the browser.

`imports.test.ts` at the app root loads every module and checks every named import against what
the packages actually export. Both halves matter: Bun's test runner links lazily, so a symbol that
does not exist is `undefined` under `bun test` and a hard failure under `bun run`.

Feature slice: `apps/web/app/<feature>/{entity,repo,service,actions,mutator,live,jobs,policy,ui}.ts`.

| File | Owns | Never |
|---|---|---|
| `entity.ts` | view schemas + invariants for this feature | I/O, policy |
| `repo.ts` | SQL for this feature | business rules, HTTP |
| `service.ts` | business logic composed from repos | HTTP, rendering, raw SQL |
| `actions.ts` | `action` declarations | logic — delegate to `service.ts` |
| `mutator.ts` | `mutator` declarations (local twin + server) | I/O inside `local` |
| `live.ts` | `query` declarations | writes |
| `jobs.ts` | `job` declarations | inline slow work |
| `policy.ts` | `policy` rules | data shaping |
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
- Dates are UTC instants in the DB, rendered only through `<DateTime zone={member.tz}>`.
- Colours are `var(--color-*)` from `@ultimat3/ui` tokens. A raw hex fails lint.
- User-facing strings come from `t('<feature>.<key>')`. A missing key renders `⟦key⟧` and fails
  `x verify`.
- `idempotencyKey` on every job is required by the type. Keys derive from `input` only.
- Tests sit next to their source: `<file>.test.ts` (unit), `.contract.test.ts`, `.live.test.ts`,
  `.job.test.ts`, `.e2e.test.ts`, `.eval.test.ts`.
- Every prompt carries `<name>.evals.ts` (the cases) and `<name>.vN.baseline.json` (the recorded
  scores). A prompt with no eval fails `x verify` with `X_EVAL_MISSING`, and an eval with no
  committed baseline fails it with `X_EVAL_BASELINE_MISSING`; the gate is the drop from the
  baseline, so re-record with `ULTIMATE_EVAL_RECORD=1 x test eval` and commit the diff — never
  inside a `x verify`, which refuses to run while recording.
- Test fixtures come from `scripts/test-setup.ts`, the one preload in `bunfig.toml`. `seed` and
  `actorFor` are Postly's; everything else is the framework's — `clock`, `mail`, `network`,
  `runJobs` built in-process, and `page`, `budget`, `signIn`, `deploy`, `subscribe` waiting on a
  driver (`X_TEST_FIXTURE_UNAVAILABLE` until one is installed). A test that destructures a name
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
  `ctx.auth` and `ctx.billing` are still undeclared and still unimplemented; they are the two
  remaining instances, not a pattern to copy.
- Uploads are `grantUpload` wrapped in an app `action` — the app owns the policy, the framework
  owns the key and the signature. Nothing here builds an object key by hand.
- `app/auth/login.ts` is the whole of "log in with GitHub" — `defineAuth` + `oauthLogin`, and the
  three decisions an app owns: `providers`, `link` and where a signed-in member lands. Its two
  route descriptors are **declared and driven by `login.test.ts`, but not served**, and that is a
  framework gap rather than a shortcut here: an app's HTTP surface is composed in
  `packages/cli/src/serve.ts` out of actions, queries, assets, storage, islands and page routes,
  and there is no seam by which an app contributes a raw `Route` — `configureAuthenticator()` is
  the only app-installed hook of that shape. So `start`/`callback` stay exported and unmounted
  until that seam exists. Two things then remain here: mounting them, and the `x_users` /
  `x_sessions` / `x_accounts` tables `BuiltinAdapter` reads, which no migration in
  `packages/db/migrations` creates — `AUTH_TABLES` is DDL the framework exports and `x db gen`
  generates only from this app's own entities, so neither half is a file to hand-write. Until
  both land nobody can hold a Postly session, which is also why `configureAuthenticator()` is
  still uncalled and `ctx.auth` still undeclared.
