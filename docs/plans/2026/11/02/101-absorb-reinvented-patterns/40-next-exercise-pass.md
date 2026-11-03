# 40-next-exercise-pass — Every primitive runs once, with no test written

> Part of [`overview.md`](overview.md). Depends on: [`39-testing-property.md`](39-testing-property.md), [`08-testing-mock-fetch.md`](08-testing-mock-fetch.md), [`18-ai-scripted-and-meter.md`](18-ai-scripted-and-meter.md), [`21-cli-verify-and-stop.md`](21-cli-verify-and-stop.md). Tier: 5 (`testing`, `cli`). Foundation of `40-next-tenant-proof`, `40-next-query-plans`, `40-next-job-crash-proof`, `40-next-subject-data`.

## Why
An agent's weakest output is the test for the path it did not think of. The gate proves an action's schema and its anonymous denial, and `.contract()` passes with 0 handler runs (`action/src/contract-test.ts:50,68`; `90-deferred.md`). So an action nobody tested can be green and never have run.
Seeds cannot help today: `defaultFor` guesses from the column name, so `postId` gets a fresh uuid that fails its foreign key and an enum gets `status-0` (`testing/src/factory-registry.ts:44,49`). `defineSeed` is hand-written (`examples/dummy/packages/db/seeds/dev.ts`).
Hard to match: needs a closed primitive list, input schemas, roles and table declarations in one registry. A framework whose handlers are arbitrary functions over an arbitrary ORM has nothing to walk.
Beside 39, not a second way. 39 asks of one action, in a test someone wrote: does a generated legal input crash its handler? This asks of the whole app, with no test: what does each primitive do to real rows? It reuses 39's walker, option shape and unreached code.

## Decisions
| Question | Answer |
|---|---|
| Primitive? | none: a pass over `listActions()`, `listQueries()`, `registeredJobs()` (`action/src/registry.ts:148`, `query/src/registry.ts:56`, `jobs/src/job.ts:458`) |
| Second schema walker? | no. An id-resolving `Draw` over 39's `minimalDraw` (`@ultimat3/schema/sample`) |
| Isolation | a fresh pair of tenants per primitive, committed. 39 rolls back, which suits one action; here the tenant proof must read rows after the call, and `testing/src/template-db.ts:1` records what rollback wrappers break. Clones per primitive cost too much |
| Side effects | sealed network, mail fixture, memory job driver, frozen clock. A real call out is a refusal, so `unreached`, never sent |
| Overrides | `apps/web/exercise.ts`: `defineExercise({ publishPost: { input, actor }, sendInvoice: { off: 'reason' } })`. Each value is 39's `exercise` option type, so a `.contract({ exercise })` passes the same value: one shape. A test helper, not a primitive. Unknown name: `X_DECLARATION_UNKNOWN` |
| Silent skip? | no. `unreached` is a finding with the paste-ready override; `off` needs 39's non-blank reason |
| Step or rider? | a new `exercise` step: `verify-step.ts:19` admits a step that asks its own question, and "what happens when it actually runs" is none of the 20 |

## Files to change
- `packages/testing/src/seed-graph.ts` (new) — `seedGraph(entities, { tenants, perTable, seed })`: topological over `relationsOf` (`entity/src/relations.ts:150`), same-tenant parents, per-row canary recorded.
- `packages/testing/src/seed-graph-values.ts` (new) — value from the column's description (`entity/src/describe.ts`): type, nullability, enum, money, default. A registered `defineFactory` wins.
- `packages/testing/src/factory-registry.ts:43` — `defaultFor` reads the description, not the name: one way.
- `packages/testing/src/exercise.ts`, `exercise-input.ts`, `exercise-actor.ts`, `exercise-report.ts`, `define-exercise.ts` (new). `testing/src/index.ts`.
- `packages/cli/src/cmd-exercise.ts`, `cmd-exercise-spec.ts` (new), `registry.ts`, `policy-facts.ts:108` (exported for the granting role).
- `packages/cli/src/db-seed.ts`, `cmd-db-spec.ts` — `x db seed --generate [--rows n] [--seed n]`, dev tier only; production still refused.
- `packages/cli/src/verify-step.ts:19`, `verify-checks.ts:55`, `verify-part-step.ts` — the step, after `job`; `applies` as `policy` does (`verify-checks.ts:333`).
- `packages/cli/src/templates/` — a scaffold's `apps/web/exercise.ts`; `scripts/generator-counts.ts` re-pins.
- `.github/workflows/ci.yml:120`, `scripts/lib/gated-apps.ts` — runner part; ratchet.
- `examples/dummy/apps/web/exercise.ts`, `dummy/social-media-clone/apps/web/exercise.ts` (new).
- `CLAUDE.md`, `docs/idea/21-the-range.md`, `docs/idea/10-testing.md`, `wiki/Testing.md`, `wiki/CLI-Reference.md`, `wiki/Error-Codes.md`, `packages/testing/{README,CLAUDE}.md`, `packages/cli/{README,CLAUDE}.md` — 21 steps; `grep -rn '20 steps'` finds the rest.

## Steps
Phase 1, minor: seed graph.
1. `seedGraph` over both tracked apps' entities with no factory; every row inserts on Postgres and PGlite. A cycle: insert with the nullable side null, then update. A non-nullable cycle or a CHECK no generated value meets: `X_SEED_GRAPH_UNSATISFIED`, fix names the `defineFactory` to write.

Phase 2, minor: `x exercise [<name>] [--seed n] [--json]`.
2. For each primitive: seed, build the actor from a role that grants its permission (the evaluation `x policy explain` uses), resolve input: override, then an id field whose stem matches a seeded entity (`postId` → `posts`), then the minimal draw. A wrong guess is visible as `unreached`.
3. `invoke` (`action/src/invoke.ts:77`), `runQuery` (`query/src/read.ts`), or a job drain. Record `{ kind, name, outcome: reached|refused|unreached|off, code, statements, effects, ms }` in `.x/exercise.json`. Statements come from `setStatementObserver`; effects from row observer, mail, network, enqueue.
4. Drive both tracked apps to zero `unreached`; each override is a line in `exercise.ts`. Measure the pass on both, and state it in the PR.

Phase 3, breaking: the gate.
5. The `exercise` step reads the same pass. `unreached` is red. An over-budget pass is split into a runner part, never sampled.

## Error codes
`bun run new-error-code <CODE> --package testing --title '…' --cause '…' --fix '…'` (tier 5, neither flag).
| Code | When | Fix |
|---|---|---|
| `X_CONTRACT_EXERCISE_UNREACHED` (from 39) | a primitive never succeeded as an allowed actor; `meta.outcomes` names the code it stopped on | paste `<name>: { input: … }` into `apps/web/exercise.ts`, then `x exercise <name> --json` |
| `X_SEED_GRAPH_UNSATISFIED` (new) | no generated row satisfies a table | `defineFactory(<entity>, { defaults })` |

## Tests
- `testing/src/seed-graph.test.ts` (unit): same seed, same bytes; every reference same-tenant; a cycle resolves; an unsatisfiable CHECK refuses. `seed-graph.live.test.ts`: inserts on Postgres.
- `testing/src/exercise.test.ts`: a handler that throws is `unreached`, never `reached`; a call out is refused and counted; a mutated handler changes the outcome.
- `cli/src/cmd-exercise.test.ts`: `--json` shape, one-primitive run, ratchet.
- `bun test packages/testing/src/exercise.test.ts`; `bun run x -- exercise --cwd examples/dummy --json`.

## Semver
Phases 1, 2: minor. Phase 3: breaking (a new red verdict, a changed exported constant). Upgrading: run `x exercise --json`; for each `unreached`, paste its printed override or state `off: '<why>'`.

## Done when
- `x exercise --json` on both tracked apps: every primitive `reached`, `refused` by design, or `off` with a reason.
- A freshly generated `x g action` with a broken handler turns the gate red with no test written.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green; `scaffold-smoke` green twice per shape.
