# 06 — A step answers what it stored

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`jobs`), 4 (`notify`).

## Why
`step.run` hands back the live value on the first run (`jobs/src/steps.ts:334`) and the JSON cast as `T` on a replay (`:299`). Probe 2026-11-02: `s.run('stamp', () => new Date(0))`, then `.getTime()`, then `s.sleep`. Attempt 1 passed; on resume, `TypeError: ….getTime is not a function`. It typechecks, and a test with no replay never sees it.
The tree already pays for this: `notify/src/fanout-digest.ts:113-122` and `fanout.ts:28-31` hand-rebuild a `Date` ("a string that the type still calls a `Date`"). The reference app passes stored rows to mail templates at `examples/dummy/apps/web/app/digest/jobs/deliver-digest.ts:82` and `posts/jobs/notify-subscribers.ts:63`, typed `Date`, a string on resume. `undefined` has the same split: the driver stores `null` (`jobs/src/driver-pg.ts:102`) and the scaffold compares `row === undefined` (`cli/src/templates/job.ts:36-37`), so a replayed miss skips the skip.

## Decisions
| Question | Answer |
|---|---|
| `T extends JsonValue` | no. It refuses any row with a `Date` even when the body never reads that column, and an interface for lacking an index signature |
| `step.run(name, schema, fn)` overload | no. A second spelling of one call; a body that wants a `Date` writes `new Date(row.at)`, which the new type asks for at the read |
| Mechanism | the return type states the stored form, and the first run returns the stored form. Both attempts then see one value, so the failure lands on attempt 1, in every test |
| Cost | one stringify + parse per EXECUTED step, none on a replay. A step persists a cursor, not a page (`backfill()`'s rule) |

Measured: the return-type change alone, applied to a copy of the tree, `tsc -b` over framework and both tracked apps: **3 of ~35 production `step.run` sites fail, all three the sites above** (`fanout-digest.ts:81`, `deliver-digest.ts:82`, `notify-subscribers.ts:63`). The demo app: 0.

## Files to change
- `packages/jobs/src/steps.ts:104` — `export type StepOutput<T>`, the JSON form: primitives and brands kept; `Date` and anything with `toJSON()` become what it returns; function members dropped; `undefined` at the top or in an array becomes `null`, on an optional member stays absent; `readonly` and optionality kept; `unknown` stays `unknown`; `void` stays `void`.
- `packages/jobs/src/steps.ts:112` — `run<T>(name, fn): Promise<StepOutput<T>>`.
- `packages/jobs/src/steps.ts:294-334` — after `fn`, `const stored = jsonForm(output)`; `put` and return `stored`. Replay line `:299` casts to `StepOutput<T>`.
- `packages/jobs/src/steps-output.ts` — new: `jsonForm`, wrapping a `JSON.stringify` refusal (a `bigint`, a cycle) in the coded error.
- `packages/jobs/src/errors.ts` — the code, classified `terminal`: the same value refuses on attempt five.
- `packages/jobs/src/type-pins.ts` — pins for `Date`, a brand, `T | undefined`, a readonly array, `void`.
- `packages/jobs/src/index.ts` — exports `StepOutput`.
- `packages/notify/src/fanout-digest.ts:113-122` — `rehydrate` takes `StepOutput<…>`; the `Date` rebuild stays, the comment about the type lying goes. `fanout.ts:28` comment likewise.
- `examples/dummy/apps/web/app/digest/jobs/deliver-digest.ts:58,82`, `posts/jobs/notify-subscribers.ts:34,63` — load only what the mail needs, as a plain view, inside the step. Check `x.manifest.json` and the digest job suite.
- `packages/cli/src/templates/job.ts:37` — `row === null`, in both template shapes. `guard` copies untouched; the templates' scaffold suite regenerates.
- Docs: `wiki/Jobs-And-Workflows.md:75`, `docs/idea/04-jobs.md` (idempotency section, one rule line), `wiki/Error-Codes.md`, `wiki/Upgrading.md`; `packages/jobs/README.md`, `packages/jobs/CLAUDE.md` ("Step results are persisted BEFORE the step returns" gains "and it returns what it persisted").

## Steps
1. `bun run new-error-code X_STEP_OUTPUT_UNSERIALIZABLE --package jobs --title 'a step returned a value JSON cannot hold' --cause '…' --fix '…' --off-socket`, registered `terminal` in the package's retry table.
2. `StepOutput` and pins first; the compiler then lists the three sites.
3. `jsonForm` in `run`. `sleep` and `waitForEvent` already write JSON-safe values and are left alone.
4. Fix the three sites and the scaffold.
5. Run the scaffold smoke: a generated job must still gate twice.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_STEP_OUTPUT_UNSERIALIZABLE` | `step.run(name, fn)`'s value has a `bigint` or a cycle, so no attempt could replay it | return plain JSON from the step: `String(id)` for a `bigint`, the ids rather than the object graph |

## Tests
- `packages/jobs/src/steps-output.test.ts`: first run and replay `toEqual` for a `Date`, a `Map`, `undefined` nested and at the top; the value on attempt 1 is already a string. Fails today.
- `packages/jobs/src/steps-output.test.ts`: `bigint` and a cycle raise the code, and `nextRetryForError` answers `stoppedBy: 'terminal'`.
- `packages/jobs/src/driver-parity.test.ts` extended: memory and Postgres answer one value for one step.
- `packages/notify/src/fanout-digest.job.test.ts`: a digest resumed after a suspension sends the same `at`.
- `bun test packages/jobs packages/notify`; `bun run scripts/reference-app-gate.ts`.

## Semver
Breaking. Upgrading entry: `step.run` returns the JSON form on every attempt and its type says so. A `Date` read off a step result is a compile error at the read: `new Date(value)`. A miss stored from `undefined` is `null`: compare `=== null`. A value JSON cannot hold is `X_STEP_OUTPUT_UNSERIALIZABLE`. Runs in flight across the upgrade replay as they always did.

## Done when
- The probe fails at compile time, and if forced, fails on attempt 1.
- `tsc -b` green with the three sites changed and no cast added at any of them.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
