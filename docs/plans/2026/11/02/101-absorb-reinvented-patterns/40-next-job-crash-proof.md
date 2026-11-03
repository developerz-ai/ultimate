# 40-next-job-crash-proof — Every job is killed at every step boundary, and races run from a seed

> Part of [`overview.md`](overview.md). Depends on: [`06-jobs-step-semantics.md`](06-jobs-step-semantics.md), [`39-action-sagas.md`](39-action-sagas.md), [`40-next-exercise-pass.md`](40-next-exercise-pass.md). Tier: 5 (`testing`, `cli`); `jobs` unchanged.

## Why
A durable job is only as good as what its author left outside `step.run`, and an agent leaves plenty. Probe 2026-11-02, a real `jobWorker().tick()` on `memoryJobDriver`, three steps, one side effect between the first two, the store's write landing and then throwing as each step commits:

| Attempt dies after | Side effect outside a step ran | `charge` step ran |
|---|---|---|
| never | 1 | 1 |
| `create` | 1 | 1 |
| `charge` | **2** | **2** |
| `mail` | **2** | 1 |

`charge` ran twice because the store's failure path overwrote the completed record (`jobs/src/steps.ts:352`): a lost answer means at-least-once. Nothing in the gate says any of this. `runJobs` drives a whole worker but injects no fault (`testing/src/fixture-jobs.ts:70`). The framework's own proof, `jobs/src/worker-soak.job.test.ts:52`, is a hand-written chaos driver for one job, and an app gets none of it.
Hard to match: needs the queue, the step store, the clock, the RNG and the fixture for every effect under one owner. Deterministic simulation is the method behind the most reliable databases; no web framework offers it, because none owns these layers. Ultimate does, down to the driver seam (`jobs/src/driver.ts:316`, `jobs/src/steps.ts:65`).

## Decisions
| Question | Answer |
|---|---|
| Oracle | the effect multiset of a clean run against a killed run. Effects: row writes (`entity/src/row-observer.ts`), mail, network, enqueue. Reads are not effects, so a read outside a step is fine |
| Death | after a kill every driver and store call from that worker rejects and lands nothing, the `chaosDriver` shape. The probe's thrown `put` is not death but the lost-answer case, and gets its own fault |
| Fault kinds | `kill`, `answer-lost` (landed, caller told no), `lease-lapse` (a second worker claims), `duplicate-claim`, `clock-jump` |
| What the gate runs | `kill` at each boundary of each registered job, with the exercise pass's input. `answer-lost` proves at-least-once: a step body rerun is expected and only reported, since no framework can prevent it |
| Advice for that report | key the external call on `` `${jobId}:<step>` ``. No new API: `jobId` is in the run arguments |
| Simulation | a library call an app writes in a `.job.test.ts`, seeded, N seeds. Off the automatic pass: only the author knows the invariant |
| Scheduler | a seeded picker at each `await` of a driver call, one thread. The test preload already freezes `Date` and `Math.random` (`testing/src/determinism.ts:1`), and the sealed network removes the rest |
| Postgres | not simulated. `testing/src/job-driver-conformance.ts` holds the memory driver to Postgres's behaviour; real sockets are `40-next-fault-drills` |
| `step.once`, compensation | shipped by [`39-action-sagas.md`](39-action-sagas.md), so the proof expects them. A kill inside a `once` step ends in `X_STEP_OUTCOME_UNKNOWN` with `fn` run at most once: the right answer, never a divergence. On a `compensates: true` job, a kill on the final attempt expects its `compensate:*` steps in the effect log, LIFO, once each, against a clean run forced to fail for good. Boundaries include `unwinding` and each `compensate:*` |

## Files to change
- `packages/testing/src/job-sim-driver.ts` (new) — wraps a `JobDriver` and `StepStore`: yield points, fault schedule, death.
- `packages/testing/src/job-sim-effects.ts` (new) — the effect log over row observer, mail, network and enqueue fixtures.
- `packages/testing/src/job-crash-proof.ts` (new) — `crashProof(handle, input)`: clean run, then one run per boundary and step count from the clean run.
- `packages/testing/src/job-simulate.ts` (new) — `simulateJobs({ seed, seeds, jobs, workers, faults, invariant })`.
- `packages/testing/src/fixture-jobs.ts:80` — constants exported for the driver; no behaviour change.
- `packages/testing/src/job-sim-soak.job.test.ts` (new) — the `worker-soak` scenario, on the shared driver.
- `packages/testing/src/index.ts`, `packages/testing/src/exercise.ts` — `crashProof` per job.
- `packages/cli/src/cmd-test.ts`, `cmd-test-spec.ts` — `x test job --seed <n>`, handed to the preload.
- `examples/dummy/apps/web/app/posts/jobs.job.test.ts` — one `simulateJobs` with a stated invariant, two workers, all fault kinds. Any real finding in the tracked apps is fixed in this PR.
- `wiki/Jobs-And-Workflows.md`, `wiki/Testing.md`, `wiki/Error-Codes.md`, `docs/idea/04-jobs.md`, `packages/testing/{README,CLAUDE}.md`, `packages/jobs/README.md`.

## Steps
1. `job-sim-driver`, proven by repeating `worker-soak.job.test.ts`'s scenario on it: same result, no `Bun.sleep`. That file stays: `jobs` cannot import tier 5.
2. `crashProof`: boundaries come from the clean run's steps, sleeps and waits included. A job with no step gets one boundary, before the ack.
3. Finding text: job, boundary, the effect and its count against the clean run. The fix names the step to wrap.
4. Wire into the `exercise` step; a job the pass cannot give input to is already `X_CONTRACT_EXERCISE_UNREACHED`.
5. `simulateJobs`: on a violated invariant throw with the seed and the fault list. Same seed, same bytes in the trace, asserted by running each seed twice.

## API
- `crashProof<I>(handle: JobHandle<I>, input: I): Promise<CrashReport>`; `CrashReport = { boundaries, divergences, reruns }`.
- `simulateJobs({ seed?, seeds = 20, jobs: [{ handle, input }], workers = 2, faults = ALL_FAULTS, invariant(state) })`; `state` carries the effect log and each run's terminal state.

## Error codes
`bun run new-error-code <CODE> --package testing …` (tier 5, neither flag).
| Code | When | Fix |
|---|---|---|
| `X_JOB_CRASH_DIVERGED` (new) | a killed run's effects differ from a clean one | move the printed effect into `step.run('<name>', …)`; then `x exercise <job> --json` |
| `X_JOB_SIM_INVARIANT` (new) | a seed violated the app's invariant | `x test job --seed <n> --filter <file>`, which replays it |
| `X_JOB_SIM_NONDETERMINISTIC` (new) | one seed, two traces | wall-clock or real I/O in the body; the first differing event is printed |

## Tests
- `testing/src/job-crash-proof.test.ts` (unit): killed for real, the probe's job diverges at `charge` and `mail`, not at `create`; moved into a step, it stays green; a read outside a step stays green; `answer-lost` is reported, never red; a kill inside `once` answers `X_STEP_OUTCOME_UNKNOWN` and is green; a killed compensating job runs each `compensate:*` once, and a compensator planted to run twice is red.
- `testing/src/job-simulate.test.ts`: a planted double claim is found within 20 seeds; its seed replays; a planted `Date.now` difference is `X_JOB_SIM_NONDETERMINISTIC`.
- `bun test packages/testing/src/job-crash-proof.test.ts`.

## Semver
`crashProof`, `simulateJobs`, `--seed`: minor. The automatic pass: breaking, with `40-next-exercise-pass` phase 3. Upgrading: each `X_JOB_CRASH_DIVERGED` is a real double effect on retry; wrap it, and no pin exists.

## Done when
- The probe's job fails `x verify` naming `charge`, `mail` and the outside effect; wrapped, it passes.
- One seed replays one trace, byte for byte, across two runs.
- Both tracked apps green. `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
