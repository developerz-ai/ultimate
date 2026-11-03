# 39 — Generated inputs inside the `contract` step

> Part of [`overview.md`](overview.md). Depends on: none. Lands before [`39-action-declared-errors.md`](39-action-declared-errors.md), which extends the `query` contract test made here. Tier: 0 (`schema`), 3 (`action`, `query`), 5 (`cli`).

## Why
Probe: `.contract()` passes with 0 handler runs, and a real call of the same action gives an uncoded `TypeError`. The three assertions (`contract-test.ts:50-80`) stop before the handler: schema, denial, OpenAPI. A handler that crashes on a legal input ships green. Any team with a schema wants its schema to drive the handler.
Recorded objections: off the gate, and a second walker. Answers: a fourth assertion in `contractTestsFor`, which every `.contract()` already runs under `contract`; and one walker, parameterised.

## Decisions
| Question | Answer |
|---|---|
| Second walker? | no. `sampleFor` (`sample-input.ts:121`) takes a `Draw`. `BY_FORMAT` stays the one table. The minimal draw is today's output, pinned byte for byte |
| Where it lives | moved to `packages/schema/src/sample.ts`, subpath `@ultimat3/schema/sample`, off the barrel (`t` is in every bundle graph, axiom 6). `action`'s `sampleInput` was never on its barrel, so nothing breaks, and `query` can reach it |
| Run count | fixed: `EXERCISE_RUNS = 16`, `runs` lowers or raises it, max 64 |
| Seed | a number, never time: `action` and `query` compute `fnv1a(<name>)` (`core/src/fnv1a.ts:12`) and pass it down, since `fnv1a` lives in `core` and `schema → core` is forbidden. A rerun replays, so no flake enters a gate that bans retries |
| Budget | 16 invocations per action, in a rolled-back transaction. Reference: one posts contract file runs 12 tests in 691 ms. The PR states `bun run x -- verify --only contract` before and after; a budget is a measurement (axiom 9) |
| Side effects | `withTransaction` around each run, always rolled back, through `action/src/tx-scope.ts`: outbox stage and cache bust drop with it. Mail and egress stay sealed by the preload |
| Who acts | required: `exercise: { actor }`. No bypass exists and none is added; a policy that denies is an unreached run |
| A row loader | `exercise: { input: (drawn) => ({ ...drawn, postId }) }` binds what a generated uuid cannot |
| Opting out | `exercise: { off: '<reason>' }`. A required non-blank reason, never silent: `.contract()` lists it |
| A verdict | pass: output accepted, or a coded refusal under 500. Defect: an uncoded throw, `X_OUTPUT_INVALID`, a coded 5xx. `X_TEST_NETWORK_SEALED` counts as unreached, with its host named |
| Vacuous pass | zero runs reached the handler is its own red, the exact failure the probe found |
| Public names | `arbitrary(schema, { seed: number, run })` from `@ultimat3/schema/sample`; `exerciseAction` from `action`, `exerciseQuery` from `query` |

## Files to change
- `packages/schema/src/sample.ts` (moved from `packages/action/src/sample-input.ts`), `packages/schema/package.json` — subpath; `Draw`, `minimalDraw`, `seededDraw`, `arbitrary`.
- `packages/action/src/contract-test.ts:43,17` — imports from the subpath; fourth assertion; `ContractTestOptions.exercise`.
- `packages/action/src/exercise.ts` (new) — the run loop and verdict; `tx-scope.ts` — a rolled-back scope.
- `packages/action/src/invoke.ts:286` — a private handler-reached counter, off the barrel.
- `packages/query/src/exercise.ts`, `contract-test.ts` (new), `.contract()` on the facade: `query` has none today.
- `packages/cli/src/templates/action.ts:341`, query template — `target.contract({ exercise: { actor: member } })`.
- `examples/dummy/apps/web/app/posts/actions.contract.test.ts`, `dummy/social-media-clone` contract tests — pass an actor; fix what it finds.
- `wiki/Testing.md`, `wiki/Actions.md`, `wiki/Error-Codes.md`, `wiki/Upgrading.md`, `packages/{schema,action,query}/{README,CLAUDE}.md`.

## Steps
1. `bun run new-error-code` for each code.
2. Move the file, then introduce `Draw`: `string(node)`, `number(node)`, `boolean()`, `include(key)` for optional keys, `items(node)`, `member(anyOf)`, `nullable(node)`. `minimalDraw` answers what lines 32-160 answer today.
3. `seededDraw(seed: number, run)`: a small seeded generator (mulberry32 over the number it is handed), never `Math.random`. Runs 0-3 are boundaries from the IR: `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`. The rest draw: multibyte text, every enum and union member, optional keys on and off, `null` where nullable. Format values stay `BY_FORMAT`'s: a mutated uuid tests nothing but the validator.
4. A draw `validateInput` refuses (a provider refinement) is counted and skipped. All 16 refused keeps `X_CONTRACT_DRIFT` and `assertSampleable`'s fix, with `exercise.input` named.
5. Loop: seeded input, optional `exercise.input`, `invoke(target, input, { ctx: asActor, surface: 'http' })` in a rolled-back scope. Collect the first defect with run index and input, stop.
6. Emit the replay in the error: `bun test <file> -t '<name>'` is enough, since the seed is the name.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_CONTRACT_DEFECT` (off-socket) | a generated legal input made the handler throw uncoded, fail its output, or answer 5xx | fix the handler or tighten `input:`; `meta.input`, `meta.run`; `bun test <file> -t '<name>'` replays. `bun run new-error-code X_CONTRACT_DEFECT --package action --title '…' --cause '…' --fix '…' --off-socket` |
| `X_CONTRACT_EXERCISE_UNREACHED` (off-socket) | no run reached the handler | give `exercise.actor` a permitted actor, or bind a row with `exercise.input`; `meta.outcomes` lists what each run hit |
| `X_CONTRACT_EXERCISE_UNDECLARED` (off-socket) | `.contract()` on a non-public action with no `exercise` | `.contract({ exercise: { actor } })` or `{ exercise: { off: '<reason>' } }` |

## Tests
- `packages/schema/src/sample.test.ts` (unit): `minimalDraw` equals the moved function over the existing `sample-input` cases; same seed, same value; every draw accepted by its own schema across the fixture schemas; bounds hit by runs 0-3.
- `packages/action/src/exercise.test.ts` (unit): the probe's `TypeError` action fails with `X_CONTRACT_DEFECT` where `.contract()` passes today; zero reached is red; a coded 4xx passes; a write is gone after the run (PGlite).
- `packages/cli/src/templates/emitted-suites.test.ts`: a scaffolded action gates. `bun test packages/action/src/exercise.test.ts`

## Semver
Breaking: a new red verdict in `contract`. Upgrading: "`.contract()` on a non-public action needs `{ exercise: { actor } }` or `{ exercise: { off: '<reason>' } }`. It now calls your handler 16 times with generated legal input, inside a rolled-back transaction."

## Done when
- The probe's action fails `x verify --only contract`, and passes once fixed.
- `sampleInput`'s output unchanged by test; `grep -rn 'function sampleFor' packages` answers one file.
- Contract step's growth on both tracked apps stated in the PR; `bun run scripts/reference-app-gate.ts` green; `scaffold-smoke` green twice per shape.

## Risks
- An app that never calls `.contract()` runs nothing. `x g action` always emits it; the reference app calls it in one file of eight, so this slice extends those files. No guard here: a file-naming rule would refuse idiomatic layouts.
- A handler writing outside the ambient transaction (a second client, `outsideTransaction`) is not rolled back. The test database is a clone, so the cost is one file's fixtures; stated in `wiki/Testing.md`.
