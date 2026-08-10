# Postly

Multi-tenant team blog on Ultimate. Orgs own members; members write posts; posts get comments
and likes; each org sits on a billing plan; a nightly digest mails every member at 09:00 in
their own timezone.

This app is the framework's reference application — Ultimate's CI runs `x verify` here.
Keep it small, keep it idiomatic. A clever file in Postly is a bug.

## Commands

| Task | Command |
|---|---|
| setup | `bin/setup` (installs, writes `.env`, migrates, seeds) |
| dev | `bin/dev` → `x dev` (web + sync + worker + scheduler, MCP on `ws://localhost:9229`) |
| verify | `bin/check` → `x verify` — the only gate |
| migration | `x db gen "<message>"` then `x db apply`. Never hand-write SQL |
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

`apps/web/shared/theme.scss` is loaded once by the framework for both surfaces; it emits the
`@ultimat3/ui` tokens and styles bare elements. `/signin`, `/signup` and `/signout` are mounted by
the wrapped Better Auth integration, so they are in the route table without living in `site/`.

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
- `t` is two different things by file kind: the schema namespace (`@ultimat3/schema`) in schema/entity/action
  files, the i18n translator (`useI18n()`) in components. Never both in one file.
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
  scores). A prompt with no eval fails `x verify` with `X_EVAL_MISSING`; the gate is the drop from
  the baseline, so re-record with `ULTIMATE_EVAL_RECORD=1 x test eval` and commit the diff.
- Test fixtures come from `scripts/test-setup.ts`, the one preload in `bunfig.toml`. `clock`,
  `mail` and `runJobs` are the framework's; `seed` and `actorFor` are Postly's. A test that
  destructures anything else fails with `X_TEST_FIXTURE_UNKNOWN` — register it there, once.

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
- The digest job schedules per member, not per org — timezone is a member column.
- Plan prices are per-currency rows in the plan catalog; never convert currencies at runtime.
