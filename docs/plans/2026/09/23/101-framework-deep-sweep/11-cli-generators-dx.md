# 11 — generators that produce working features

> Part of [`overview.md`](overview.md). Depends on: 05 (job declaration errors), 10. Tier: 5.
> Shares `templates/scaffold-auth.ts` and `scaffold-roles.ts` with plan 102 slice 12. Never run both at the same time.

Rule: `x new` + `x g resource <x>` + `x verify` green means `POST /api/<x>s/create` works for the
dev actor. Anything the gate passes that fails at runtime is a missing gate finding, and each row
below names the one it adds.

Evidence (measured 2026-09-23 on published `create-ultimate@21.0.0`): `x g resource customer`,
then `x verify` passes 19/20 steps, yet `POST /api/customers/create` returns 403 `X_FORBIDDEN`.
Granting the permission gives 403 "predicate returned false" (`dev-org` is not a uuid). The
generated form then gives 400, because it sends `{title}` to an action taking `{id, orgId}`.

## Files to change

| # | Defect | File:line | Change | Enforced by | Semver |
|---|---|---|---|---|---|
| a | generated permissions are granted by no role. The scaffold's `roles.test.ts` goes red on a correct grant because it never loads the feature's `policy.ts` (`known: false`), and it pins exact lists | `packages/cli/src/verify-checks.ts:289-296` (`policy` step), `templates/scaffold-roles.ts` | `policyFindings` adds `X_PERMISSION_UNGRANTED` for a permission some action/query requires that no role holds. Fix: `add '<perm>' to grants of a role in apps/web/shared/roles.ts`. `x g policy`/`resource` insert the grant into the lowest role that makes sense (`member` for `:read`, `admin` for `:write`). The scaffold's roles test loads policies through `loadApp` and asserts subsets | new gate finding | minor |
| b | generated jobs are never registered in `apps/web/api/index.ts`, so they get positional `anonymous-job-N` names under a green gate. `Tutorial-02:152` says the file does not exist; it does | templates for `job`, `task` and `resource`; `packages/jobs/src/job.ts:183` | Generators insert the import and list entry (the `api-routes.ts` one-list mount shape). The manifest step refuses any `anonymous-*` name as `X_JOB_UNREGISTERED`, with fix `add * as <export> to jobs: [...] in apps/web/api/index.ts` | new gate finding | minor |
| c | the dev actor's `orgId: 'dev-org'` can never pass a generated `t.uuid` tenant policy. The seed uses a third value, `id('org:demo')` | `templates/scaffold-auth.ts:69`, `templates/action.ts:39` | The dev actor's `orgId = seedId('org:demo')`, one constant imported by auth, seed and dashboard | scaffold e2e: create as dev actor → 2xx | patch |
| d | the generated `create<X>` action reads, then throws NotFound. The generated form posts `{title}`. MCP is exposed with a placeholder description | `templates/action.ts`, `templates/resource-form-island.ts:88` | `x g resource` emits a real insert whose input derives from the entity (`$view` minus `id`/`orgId`), with `orgId` from the actor. The form posts that shape. `mcp.expose` defaults to `false` until a description is written. `archive*` keeps `byId` | scaffold e2e | minor |
| e | `x g job/task/action` with no existing slice invents an entity table (`entity('nightlies', { title, price })`), and the gate then demands a migration for it | `templates/job.ts:293-322` (`isTenantScopedSlice` true on no entity), action template | With no `entity.ts`, emit the neutral body. Only `x g entity`/`resource` write an entity. A `--feature` naming no slice gets `X_FEATURE_UNKNOWN`, fix `x g resource <feature>` | generator test | patch |
| f | `x g` refreshes `x.manifest.json` but not `openapi.json`, so its own output fails `contract-diff` | `packages/cli/src/cmd-generate.ts:127-133`, `cmd-manifest.ts:83` | One `writeAppArtifacts()` both commands call | generator test runs `x verify --only contract-diff` | patch |
| g | `jobs.queues`/`jobs.concurrency` from the scaffold's config do nothing: the worker starts on `default` | `packages/cli/src/dev-roles.ts:401`, `jobs/src/worker.ts:42` | Pass both into `createWorker` | `config-readers` (row h) | patch |
| h | `config-readers` counts `validateConfig` as a reader, so a validated-but-unwired key reads as wired | `scripts/config-readers.ts`, `packages/core/src/config.ts:349-350` | Exclude `config.ts` validation from the reader set. Pin every key this exposes with a reason, or wire it | the guard itself | none |
| i | a single cause is reported by up to 4 steps (`contract-diff`, `budgets`, `manifest`, `policy`), and the scaffold's own `AGENTS.md` trips a manifest warning | `packages/cli/src/verify-checks.ts`, manifest `agents-md` check | Record module-load findings once, under the step that loaded the module. Other steps print `skipped: see <step>`. Exempt the scaffold's `AGENTS.md` table | gate test | patch |
| j | `x fix boundary <file>` prints another fix and writes nothing | `packages/cli/src/cmd-fix*.ts` | Either perform the edit (delete the import, add a `shared/` re-export) or delete the subcommand, and put the concrete edit in `X_BOUNDARY_SITE_TO_APP`'s own fix | fix-line test | patch |
| k | curl against a dev action gets `X_CSRF_BLOCKED`, with a fix naming a token dev does not have | `packages/http/src/csrf.ts` fix text | When `isLocal`, the fix names `-H 'sec-fetch-site: same-origin'` | error test | patch |
| l | an `async Page` with no `load` passes the gate. The social clone has 11 of them (slice 16) | `packages/render/src/registry.ts` / `x verify` routes check | New finding `X_ROUTE_ASYNC_PAGE`, fix `move the awaited read into load: (ctx) => …` | new gate finding | minor |
| m | the static build's measurement render makes a real HTTP call for a query (`X_CLIENT_TRANSPORT_FAILED`), and `measurementActor()` carries no app facts (`X_ACTOR_UNRESOLVED`) | `packages/cli/src/measurement-actor.ts`, the prerender query path | Run `load`'s queries in-process during `x build` (the server-side `invoke`, never `clientTransport`). Add an app hook `defineMeasurementActor()` in `app.config.ts` so budgets can render authed routes | `budgets` step in both tracked apps | minor |

## Steps
1. c, d and e first: the "create works" path.
2. Then a and b (new gate findings, which change what green means). Register `X_PERMISSION_UNGRANTED`, `X_JOB_UNREGISTERED`, `X_FEATURE_UNKNOWN` and `X_ROUTE_ASYNC_PAGE` with `bun run new-error-code`.
3. Add a scaffold e2e test to `packages/cli/src/templates/` or the scaffold-smoke CI job: `x new`, `x g resource customer`, `x dev`, then POST create as the dev actor expecting 2xx, then list and see the row. This is the assertion the audit lacked.
4. Update `wiki/Tutorial-02-First-Feature.md:152` in the same PR.

## Tests
- `bun test packages/cli/src/templates packages/cli/src/verify-checks.test.ts packages/cli/src/cmd-generate.test.ts`
- The CI `scaffold-smoke` job, extended with step 3.

## Done when
- The step 3 test is green.
- The manifest of a scaffold after `x g job ping` has no `anonymous-*` name.
- `x g task nightly` writes no entity.
