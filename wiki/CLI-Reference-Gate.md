# CLI reference: the gate and tests

Part of the [CLI reference](CLI-Reference): `x verify`, `x exercise`, `x drill`, `x test`, `x clean`, `x affected`, `x policy`, `x i18n`. Conventions, global flags and the command index are on the index page.

## x verify

```bash
x verify [--only <step>[,<step>…] [--shard i/n [--timings file]] | --changed [--base <ref>] [--dirty]] [--workers N] [--isolate] [--json]
x verify merge <part.json…> [--json]
x verify plan [--parts n] [--json]
```

**`x verify plan`** (`As of 31.17.0`) — the gate cut into CI parts, as data: each part an `x verify
--only <steps> [--shard i/n]` for one runner, and `data.matrix` a GitHub `strategy.matrix`
(`{ include: [{ part, only, shard?, needs }] }`) a workflow reads with `fromJSON`. `--parts`: `1`
(the whole gate on one runner) or `4`–`64`, default `4` — a `static` part (every step that is not a
suite), an `e2e` part (`typecheck` + `e2e`), and the rest split between shards of `unit,contract,job`
and of `live`, the unit group taking the odd one. `needs` says what the runner starts first:
`none`, `database` (the test Postgres) or `services` (every test service). Derived from
`VERIFY_STEP_NAMES`, so a new gate step lands in a part with no workflow edit, and every step sits in
exactly one part or every shard of one split — the rule `x verify merge` refuses a run by. `x new`'s
`.github/workflows/ci.yml` is three jobs: `plan` → one `gate` per part → `verify` (the merge) →
[CI: the gate across parallel jobs](CI-Parallel-Gate). Pure: it reads no file and starts nothing.

**`--changed`**, `As of 31.0` — the steps whose inputs the diff touches, NOT A GATE RUN like `--only`
and never beside it (`X_CLI_BAD_FLAG`). The diff is `x affected`'s: `<base>...HEAD`, `--base` default
the remote-tracking default branch (`origin/HEAD`, else `origin/main`, else local `main`; `As of 31.1`), `--dirty` adds uncommitted and untracked work. Each file gets one rule, each rule selects
steps; `data.changed` carries `{ base, dirty, files: [{ path, rule }], steps: [{ name, files }] }` and
the human render one `step ← files` line per step. Fail-open: a path no rule speaks for runs the gate.
Each suite but `eval` then runs only the test files the diff's import closure reaches — `x test
--affected`'s selection, `data.changed.tests` — a suite none of them belongs to is dropped, and the
`unit` coverage floor is not judged on the subset; a file the import graph cannot speak for (a root
config, a catalog) runs every test.

| rule | files | steps |
|---|---|---|
| `doc` | `*.md`, `docs/`, `wiki/` | package-shape, errors, unit, manifest, roadmap |
| `test` | `*.test.ts(x)`, `e2e/` | typecheck, lint, filesize, package-shape, errors + the suite that owns the file |
| `generated` | `x.manifest.json` | lint, contract-diff, manifest |
| `page` (`As of 31.22`) | `apps/<app>/site/**/page.tsx`, `apps/<app>/app/**/page.tsx` | typecheck, lint, boundaries, filesize, i18n + the suites, cut to that route's tests. An inner-loop answer, not proved idle: `budgets`, `seo`, `exercise`, `manifest` wait for the full `x verify` |
| `source` | `apps/`, `packages/`, `guards/`, `scripts/`, `types/`, `bin/` | every step but `drift` |
| `drift-input` | `packages/db/**`, `apps/*/clients/**`, `openapi.json`, any module importing `@ultimat3/entity` and everything it imports | every step |
| `root-config` · `deleted` · `unknown` · `outside` | a root file, any `app.config.ts`, a vanished module, another directory, a path outside the app | every step |

**`As of 22.7`** — the width is a memory budget (`max(2.75 GiB, 25% of RAM)` at 1.25 GiB a worker — no fixed 4 GiB cap since 2026-11-07,
at most one per core, printed on the step line; `ULTIMATE_TEST_MEMORY_BUDGET` /
`ULTIMATE_TEST_MAX_WORKERS` override, `--workers` wins), shared machine-wide across concurrent runs,
and test files are NOT isolated unless `--isolate` or `x.verify.json` `"isolate": true` says so →
[Testing](Testing#memory-width-and-isolation). `--shard i/n` (with `--only unit|contract|live|job|e2e`)
runs one CI job's deterministic slice — round-robin over the sorted files, or with `--timings
<file>` (`{ "path": ms }`, committed so every job reads one) heaviest-first to the lightest shard,
an unknown file at the median; `live` and `e2e` stay one process inside it, a slice per
runner, each runner with its own services (`As of 2026-11-07`) — and `x verify merge` folds every job's `--json` part back
into the gate verdict (`X_VERIFY_SHARD_INVALID`, `X_VERIFY_MERGE_INCOMPLETE`,
`X_VERIFY_MERGE_INPUT`) → [CI: the gate across parallel jobs](CI-Parallel-Gate). The paragraphs
below on `--workers` and batching describe 22.6 and earlier where they differ.

| `x.verify.json` key | What it sets |
|---|---|
| `steps` | steps this repo may never report as skipped (`X_VERIFY_SUITE_VANISHED`) |
| `coverage` | `{ "lines", "funcs", "why"?, "exclude"?: [{ "glob", "why" }] }` — the `unit` step's floor for the app's whole source tree (`X_COVERAGE_BELOW_FLOOR`, `X_COVERAGE_FLOOR_UNSTATED`, `X_COVERAGE_FLOOR_STALE`) → [Testing](Testing#coverage). `x doctor` prints every `exclude` |
| `stepTimeoutMs` | `{ "<step>": milliseconds }` — a step's own deadline. Default 8 minutes for the six suites, 5 otherwise; past it, `X_VERIFY_STEP_TIMEOUT`, its processes killed |
| `localOnly` | `{ "<step>": "<why>" }` — steps a `CI` run leaves out, each why in a line and `data.localOnly`; run locally and by `--only`. An unknown step or empty why is a `manifest`-step problem |
| `exercise` | `{ "unprovenMax"?: <0–1>, "statementsMax"?: <whole ≥ 1> }` — what the `exercise` step's pass may leave unproven, and statements per call (`X_EXERCISE_UNPROVEN_ABOVE_FLOOR`, `X_STATEMENTS_OVER_BUDGET`); absent, a warning → [`x exercise`](#x-exercise), `As of 31.16.0` |
| `isolate` · `typecheckBin` · `agentsMdMaxBytes` | a fresh global per test file · the `tsc`-compatible binary · the `AGENTS.md` byte budget |
| `strict` | `true`: each step the run selects runs a check or has a `skip` why, else red (`X_VERIFY_STRICT_UNRUN`). Otherwise a warning line and `data.unwaived` name the steps that ran none. `As of 2026-11-15`; the default flips to `true` on `next` |
| `skip` | `{ "<step>": "<why>" }` — why a step runs no check here: a gate step not in `steps`, a non-empty why. A why over a step that ran warns `drop its entry` |
| `guardBaseline` | `{ "<guard>": n }` — a `guards/<guard>.ts` may still report `n` findings: up to `n` notices on `boundaries`, above it red (`X_GUARD_OVER_BASELINE`), below it red naming the lower number (`X_GUARD_BASELINE_STALE`): it only falls. A baseline for a removed guard is stale; a report-only guard (`severity: 'warning'`) is never judged |

Either render prints one line per finished step on **stderr** as each finishes — under `--json`
`{"step":"lint","ok":true,"ms":21987}`, otherwise (`As of 31.22`) `✓ lint 22.0s`, `○ seo 0.0s` for a
step that did not apply, and for a red step its narrowest re-run: `✗ unit 3.1s → x test unit --filter
<the test files its findings name> --json`, else `x verify --only <step> --json` — and every minute a step is still running a `still running: unit (12m 3s)` line;
under `--json` stdout stays the single document. A cancelled job's log ends on the last step that
finished, and a harness that kills a process after N silent minutes never kills a healthy gate.

The single gate. Green means shippable; CI runs exactly this. One step list, in cost order, shared
with the framework repo's own `bun run verify` — and **the gate is this command with no flag**,
because "green" has to mean the same thing for everyone. `--only <step>` runs one step for an
iteration loop, and `--only typecheck,lint,boundaries` runs several in ONE process — one CLI boot
and one app load instead of one per step — always in the gate's declared order, whatever order they
were typed in. Neither is a gate run: it announces `NOT A GATE RUN` in the summary and in `--json`
(`data.notAGateRun`, and `data.only` as the list of steps — a list of one for a single name), exits
with the steps' own status, and writes no floor file — even a list naming every step. An unknown or
empty item is refused (`X_CLI_BAD_FLAG`) naming every valid step, with a fix that corrects the typo
and keeps the rest of the list. There is no `--skip`. A step with nothing to check in this project
reports as skipped (`-`), never as passed — and the summary counts skips apart from passes and
names them, so a gate that is green because a suite does not exist has to say so on the one line
every reader sees:

```text
✓ 20 of 21 steps passed in …ms — 1 skipped: roadmap
```

`--json` carries the same fact twice: `steps[].skipped` per step, and `data.skipped` as the list of
names beside `data.failed`. `all {n} steps passed` is printed only when nothing was skipped.

Every step that ran no check — a skip, a vanished suite, a strict refusal — is printed under the
table as `skipped: <step> — <reason>` (`no *.e2e.test.ts file in this tree`, `found 3 test(s) and
every one skipped itself`) and carried in `data.skipReasons` as `{ "<step>": "<reason>" }`,
`As of 2026-11-15`.

`x.verify.json` ratchets those skips. Hand-written, committed at the repo root, read by the gate
and written by nothing:

```json
{ "steps": ["typecheck", "lint", "boundaries", "unit", "contract", "live", "e2e", "manifest"] }
```

Every name in it is a step this repo has already run, so a step in the list with nothing left to
check is a deleted suite — reported as **failed**, not skipped, with `X_VERIFY_SUITE_VANISHED` and
the two edits that resolve it. A repo with no such file is not ratcheted, and a name the gate does
not run is refused by the `manifest` step (`X_CONFIG_INVALID`) rather than silently covering
nothing. Removing a line is allowed; it just has to be a diff somebody reviews.

**`live` starts its own test database, `As of 2026-11-15`.** When `x.verify.json` holds `live`
(or `--only` names it), the step runs the idempotent `docker compose -f
docker/docker-compose.test.yml up -d --wait --wait-timeout 120` — the stack `x new` wrote — and
hands that env file's values to the suites, for every key the shell left unset. It runs even when
`TEST_DATABASE_URL` already answers: a Postgres still starting is waited for, and Redis, NATS and S3
come up beside it. If `up` fails while the database answers our login (a concurrent run's container
conflict, say), only the keys whose service answers are handed over — a suite with no URL skips; one
with a dead URL would fail. A Postgres on that port that refuses this app's login is another app's
stack: `X_TEST_SERVICES_UNAVAILABLE`, and nothing is handed over. A `TEST_DATABASE_URL` that is not
the env file's is your own server, and is never probed or second-guessed. The stack is **left
running** (RAM only; the next run reuses it) and the step's warning says so, with the stop line,
`docker compose -f docker/docker-compose.test.yml down`. No Docker, or a start that fails with no
database answering: a warning carrying `X_TEST_SERVICES_UNAVAILABLE` and the start command as its
fix, and the suites run exactly as before. When the floor holds `live` and that run executed no
test, `X_TEST_SERVICES_UNAVAILABLE` is the step's **finding**, first and red, with its working fix —
not `X_VERIFY_SUITE_VANISHED`, which is no longer added when the step already says why
(`As of 2026-11-19`). `--only live` with no floor, or a live run where some tests ran, keeps the
warning.
One stderr line names the stack: `services: started|reused <project>`, or `services: shared <project>
with <dir>` for another checkout of this app (same first commit or `origin`). A stack under this
project name started by a different app is refused before compose runs:
`X_TEST_SERVICES_UNAVAILABLE`, unless `ULTIMATE_TEST_SERVICES_SHARED=1` says the share is intended.
A **stopped** one is called stopped, never "already running", and its fix removes it by name:
`docker compose -p <project> down --volumes` (its data was in RAM), then `x verify --only live`. It
is reported, never taken over. `x new` (`As of 2026-11-19`) writes the compose `name:` as
`<app>-test-<8 hex of the scaffold directory's hash>` and picks the ports from name and directory,
so two scaffolds with one name on one machine get two stacks; an existing app keeps the `name:` its
compose file states, and a moved checkout keeps its scaffold-time name.
`x clean --services` stops the stack.
`packages/cli/src/verify-live.ts` decides when; `verify-services.ts` probes and starts;
`verify-services-stack.ts` reads whose stack it is.

`--workers` widens the test steps only. `unit`, `contract`, `job` and `eval` run as
`bun test --parallel=N`, each worker with its own database; `live` and `e2e` are serial by
declaration and say so in the output. **`x test live` and `x test e2e` obey the same declaration,
`As of 2026-08-27`** — they did not, so `x test live --workers 8` ran eight processes over the very
files `x verify` ran one over. `--workers` is accepted there and clamps to 1. That clamp read the
POSITIONAL, so the bare `x test --workers 8` still widened over the same files until 2026-09; the
selection is now partitioned by each file's own type. `x test`'s e2e pass also LAUNCHES as the
gate's `e2e` step does, `As of 2026-11`: in an app root with a browser (`CHROME_PATH`, or one
`x doctor` finds) it runs under `@ultimat3/testing`'s e2e preload, which spawns the app, with the
device zone `America/Los_Angeles` — before, `x test e2e` never opened a browser and every
browser-backed case skipped. With no browser both skip those cases alike, and under
`E2E_BROWSER_REQUIRED=1` those cases refuse instead of skipping, in both. The default width is
a memory budget, `As of 2026-11-07`: `max(2.75 GiB, 25% of RAM)` (`BUDGET_RULE`) at 1.25 GiB a worker
(`WORKER_BYTES`, `GATE_BUDGET_FLOOR` and `GATE_BUDGET_SHARE` in
`packages/cli/src/test-workers.ts`), at most one per core — the paragraph under `x verify` above.
**No fixed ceiling of 8**: it held a 12-core box with 30 GB free to 8. `--workers` accepts 1 to
64 on both `x verify` and `x test`; an explicit width is the caller's call and is not held to memory.

**A large selection runs in batches, `As of 22.6.2`.** A `--parallel` worker's heap grows with
every file it runs and is returned only when its `bun test` exits, so one process over the whole
corpus peaked higher with every test an app added — and the default of 22.6.1 (18 workers on a
12-core box with 35 GB free, 1 GiB budgeted a worker) took a 45 GB machine with no swap down.
A pass now runs as `ceil(files / (workers x 24))` `bun test --parallel=N` processes in sequence,
the files dealt round-robin over the sorted list, so the peak depends on the width and not on the
corpus. One adopter's `x test unit`, 768 files, 12 cores: 22.6.1's default (18 workers, one
process) peaked at 17.1-18.2 GB of process tree in 132-167s; 22.6.2's default (13-14 workers,
3 batches) at 11.3-12.2 GB in 152-163s, on a box shared at load 30-40. At the same width the split
costs no wall time within noise (12 workers: 150-158s unbatched, 147s in three batches). The split is a pure function of the file list and the width,
so the `fix:` a failure prints (`x test unit --workers N`) reruns the same batches; a `-- --watch`
run is never split; a forwarded `-- --bail` starts no batch after a red one. `x test --json` carries `batches`
when a pass was split, and each batch's output is kept under a line naming it.

**Bun owns the pool, `As of 2026-08-27`.** The CLI used to pack the files into N bins itself
(largest-first greedy over file SIZE) and spawn one `bun test` per bin; `--parallel=N` hands each
free worker the next file instead. **Expect no speed-up** — the two forms measure the same. Four
interleaved runs each on this repo's 1296-file unit corpus, 8 workers: 58.2/60.0/65.0/66.5s
hand-packed against 54.5/57.8/61.7/64.5s under `--parallel=8`. Both are work-bound — the corpus is
436.7s of file time, so eight workers cannot beat 54.6s however the files are dealt, and the
slowest single file is 20.5s. The packer is gone because it was 233 lines buying nothing, not
because it was slow ([#342](https://github.com/developerz-ai/ultimate/issues/342)).

| Step | Checks |
|---|---|
| `typecheck` | `tsc` across every workspace |
| `lint` | Biome: no `any`, no default exports, no bare `Error`, no raw colours, no hardcoded user-facing strings |
| `boundaries` | surface and layer imports, resolved transitively; package tiers in a monorepo; an app's `guards/*.ts`. A guard may spawn a process (`check` is any async function): it runs under this step's deadline, so a slow one sets `stepTimeoutMs.boundaries` in `x.verify.json` |
| `filesize` | a source file over 500 lines |
| `package-shape` | a workspace package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, `src/index.ts`; a workspace importing a sibling workspace it does not declare (`X_WORKSPACE_DEP_UNDECLARED`); a workspace's shipped source importing a registry package — `@ultimat3/*` included, type-only imports too — that neither its own `package.json` nor the root's declares (`X_WORKSPACE_EXTERNAL_DEP_UNDECLARED`, fix `bun add <pkg> --cwd <workspace>`). Builtins (`node:*`, `bun`, `bun:*`), workspaces and tsconfig `paths` aliases are exempt. `As of 31.1` |
| `errors` | every `X_*` code has a runnable fix and a docs page |
| `unit` | pure logic — services, money, policy predicates, matchers |
| `contract` | action/query schemas, policy denials, emitted OpenAPI and MCP shapes |
| `live` | live-query snapshot, incremental patches, reconnect delta, policy-filtered rows |
| `job` | step replay, idempotency dedupe, retry/backoff, concurrency, outbox atomicity |
| `e2e` | a real browser (raw CDP) against the app, spawned on a throwaway database when Chrome is present, including offline and SW update |
| `eval` | prompt scores vs. their recorded baselines, and a prompt with no eval at all |
| `drift` | schema vs migrations |
| `contract-diff` | the code vs the **committed** `x.manifest.json`: a breaking change without a major bump |
| `budgets` | per-route JS bytes, the global style layer every document carries (`X_STYLES_GLOBAL_MISSING`), and every route that reads live rows with no island to receive them (`X_LIVE_ROUTE_NO_ISLAND`). **Builds first** when `.x/build-stats.json` is missing, of an earlier measurement rule, or older than the newest app source: `x build --target static --no-preflight --no-capture --out .x/verify-static`, under this step's deadline (`stepTimeoutMs.budgets`), never over a deployable `.x/static`. A failed build is the step's verdict, with the build's own findings. `As of 30.0` |
| `manifest` | the files an agent reads: `x.manifest.json` **and `openapi.json`** freshness — the one check `x manifest --check` runs (`X_MANIFEST_MISSING` / `X_MANIFEST_DRIFT` / `X_MANIFEST_STALE`) — `.env.example`, a hand-written `AGENTS.md` that exists and is under 12kB, and `x.verify.json` naming only steps the gate runs |
| `roadmap` | framework repo only — every `docs/idea/14-roadmap.md` milestone carries a status marker, and a milestone marked shipped still has the artifacts its own row names |

A test's type is its filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`,
`*.e2e.test.ts` (or any test under `e2e/`), `*.eval.test.ts`. Everything else is a unit test, so no
test can fall between two steps.

`eval` is the one step that applies with no suite of its own: a prompt no `defineEval` names is
`X_EVAL_MISSING`, and an eval whose baseline was never recorded is `X_EVAL_BASELINE_MISSING`,
because a skipped step — or one gating against nothing — would read as a green gate over untested
code. It gates on the drop from each eval's committed baseline, never on an absolute score —
`ULTIMATE_EVAL_RECORD=1 x test eval` re-records those baselines so accepting a new number is a
reviewable diff. `0`, `false`, `no`, `off` and empty (any case, trimmed) are off and gate; any
other value records (`As of 2026-11-19`, `packages/ai/src/eval-baseline.ts`).

That flag and this step are mutually exclusive. `x verify` with `ULTIMATE_EVAL_RECORD` set is
`X_EVAL_RECORDING` and the suite does not run: recording makes every eval write the numbers it
just measured and pass, so a gate that inherited the flag reports green over scores nothing
compared — and rewrites the committed baselines on its way through.

```bash
$ x verify --json
{"ok":false,"command":"verify",
 "summary":"1 of 21 steps failed — 3 skipped: e2e, contract-diff, roadmap","steps":[
  {"name":"budgets","ok":false,"durationMs":812,"skipped":false,"findings":[
    {"code":"X_BUDGET_EXCEEDED","cause":"/pricing ships 61.2kb of JS (minified, uncompressed) over a 40kb budget via site/pricing/page.tsx -> islands/post-form-04f75f18.js; charged: /islands/post-form-04f75f18.js 50123 B, inline scripts 855 B",
     "fix":"edit apps/web/site/pricing/page.tsx — set budget: { js: '62kb' } with // measured: 62682 B (x build --target static) — why: <the function it buys> directly above it, then x manifest (x.manifest.json carries the budget); or x routes --json for the chain and move the heavy import behind hydrate: 'interaction'",
     "docs":"https://github.com/developerz-ai/ultimate/wiki/Error-Codes",
     "at":"apps/web/site/pricing/page.tsx",
     "meta":{"jsBytes":62682,"charged":[{"url":"/islands/post-form-04f75f18.js","bytes":50123}],"inlineJsBytes":855}}]}],
 "data":{"failed":["budgets"],"skipped":["e2e","contract-diff","roadmap"],"durationMs":11153}}
```

A finding is `code`, `cause`, `fix`, and optionally `docs`, `at` and `meta`. `at` is the
path an agent opens — a file, or the stuck test file for a timed-out step — and is absent
when there is no such path. `meta` is structured facts behind `cause`, never the only home of
one: an unmeasured budget carries its route in `meta.route` (`X_BUDGET_UNMEASURED` — `at` names
the file that declares it), while `X_BUDGET_EXCEEDED` carries what the bytes were charged as
(`meta.jsBytes`, `meta.charged`, `meta.inlineJsBytes`) and spells the route in `cause`.
`X_VERIFY_STEP_TIMEOUT`
carries `meta.step`, `meta.deadlineMs`, `meta.killed: [{pid, command}]` and
`meta.inFlight: [{command, files, workers, stuck}]`; `at` is the stuck test file when
one could be named, and the failed step's `output` is the tail of what the killed run had printed.

Errors: `X_VERIFY_FAILED` (with the failing step names), plus each step's own code.

## x exercise

```bash
x exercise [<name>] [--seed n|random] [--shard i/n] [--json]
```

Every action, query and job the app registers, run **once** against generated rows, with no test
written. The question no written test answers: what does each primitive do when it actually runs?

| Step | What happens |
|---|---|
| database | a scratch one — embedded, or a server named by `TEST_DATABASE_URL` when a migration needs an extension the embedded one cannot link — with the framework tables and every migration applied. Never the developer's own: the pass commits |
| rows | a fresh pair of tenants per primitive, every table seeded off its declaration (`x db seed --generate`'s graph) |
| actor | the first of `x policy explain`'s actors the primitive's policy allows, in its own tenant |
| input | the override, then an id field whose stem names a seeded entity (`postId` → `posts`), then the minimal draw of its schema |
| room | network sealed, mail captured, job queue in memory, clock frozen. A call out is refused, so the primitive is `unreached`, never sent |

Each primitive ends `reached`, `refused` (no actor its policy allows — by design), `off` (an
override with a reason) or `unreached`. `--json` and `.x/exercise.json` carry the same document:
`{ seed, counts, records[] }`, each record `{ kind, name, outcome, code?, reason?, statements,
effects, ms, override? }`. A `<name>` runs that one primitive; an unknown name is
`X_DECLARATION_UNKNOWN`.

`unreached` is red: `X_CONTRACT_EXERCISE_UNREACHED`, and its `fix:` is the entry to paste into
`apps/web/exercise.ts` — valid TS naming the actor the pass ran as (`testActor(…).actor`, imported
from `@ultimat3/policy`) and the seeded row each id field was bound to (`As of 2026-11`). The
`exercise` option `.contract()` takes, one shape:

```ts
import type { Actor } from '@ultimat3/core';
import { defineExercise } from '@ultimat3/testing';

declare const author: Actor; // a signed-in actor the policy allows

export const exercise = defineExercise({
  publishPost: {
    actor: author,
    input: (drawn) => ({ ...(drawn as Record<string, unknown>), postId: '<a real id>' }),
  },
  sendInvoice: { off: 'charges a card through the payment provider' },
});
```

**The seed** (`As of 31.47.0`). Row ids and tenants are drawn from it, so it is part of the verdict.

| Run | Seed | For |
|---|---|---|
| `x exercise`, and the gate's `exercise` step | one constant, `DEFAULT_SEED` from `@ultimat3/testing` | one tree, one verdict |
| `x exercise --seed <n>` | `n`, 0 to 2147483647 | replaying a run |
| `x exercise --seed random` | a fresh one | looking for a seed-dependent helper; never the gate |

The first output line and `seed` in `.x/exercise.json` and `--json` name the seed used. Each pass
has its own scratch database, so repeating a seed collides with nothing.

A blank `off` reason is `X_CONTRACT_EXERCISE_UNDECLARED`; so is an `exercise.ts` with no single
`defineExercise()` export. The gate's `exercise` step runs this command as a child and is red on
exactly its findings, plus the static half of the tenant proof: an entity with no tenant column
that references one with a tenant and declares no `shared` reason.

**The `exercise` floor** (`As of 31.16.0`). `x exercise` and the gate step judge the pass against
`x.verify.json`'s `exercise` key ([Configuration](Configuration#the-gates-file--xverifyjson)). Without the key every
judgement below is a warning line (`! …`, and `data.warnings[]` under `--json`) naming the figure to
write, and the run stays green; with it, above a declared figure is red.

| Judged | Red, once opted in | Warning otherwise |
|---|---|---|
| unproven ÷ reached — a tenant, crash or scale proof that could not ask | `X_EXERCISE_UNPROVEN_ABOVE_FLOOR`, naming the first three | the ratio, rounded up, to write as `unprovenMax`; also when it fell under the floor, naming the lower figure |
| a sized-seed table the database refused | `X_EXERCISE_SEED_FAILED`, one per table, naming the entity, the driver's words and its readers — red exactly when the unproven ratio is | the same finding as a line |
| one call over its statement ceiling — `statementsMax`, or the entry's own `statements: { max, why }` | `X_STATEMENTS_OVER_BUDGET`, the busiest call and its three largest shapes | the same finding as a line, judged at 100 |

**Route loads** (`As of 31.17.0`). After the primitives, the pass runs every `app/` and `site/`
file route that declares a `load` — the route table `x routes` prints — once in its own seeded
tenant, as the runtime calls it: in a request, as the first actor the route's permission allows (a
signed-in one where it names none), its params a seeded row's id or the route's own `prerender()`
sample. Each load gets the primitives' proofs: its statements counted against the ceiling (100), a
scale sweep at 2 and 8 rows a table, and the plan oracle over what it sent. The records ride beside
`records`, as `routes[]` in `--json` and `.x/exercise.json` (`{ kind: 'route', name, file, outcome,
reason?, statements, effects, ms, statementCeiling?, plans?, scale? }`), and every finding is a
**warning line** on `main` — `route /messages (apps/web/app/messages/page.tsx) · X_QUERY_SCALES_WITH_ROWS …`,
`· X_STATEMENTS_OVER_BUDGET …`, a plan code, or `· load not exercised: <reason>` — never red: no
floor key opts a page read in yet.

**Reached with nothing to prove** (`As of 31.17.0`): a primitive reached that sent no statement and
had no effect has vacuous proofs — a sweep of nothing is `flat`. One warning line names the first
five, `X_EXERCISE_EMPTY_REACH … — fix: edit exercise.ts: give each an input that reaches its work, or
{ off: '<why>' }`. A warning, not red, on a whole-pass run only.

**Route entries** (`As of 2026-11-15`). What a page needs that a seeded id and a role cannot give it
is `defineExercise`'s second argument, keyed by the URL pattern `x routes` prints:

```ts
import type { Actor } from '@ultimat3/core';
import { defineExercise } from '@ultimat3/testing';

declare const author: Actor; // a signed-in actor the policy allows
declare function asMember(seated: Actor | null): Promise<Actor | null>;
declare function ownThread(): Promise<{ id: string }>;
declare function consentQuery(): Promise<string>;

export const exercise = defineExercise(
  { publishPost: { actor: author } },
  {
    routes: {
      '/posts/board': { actor: asMember }, // (seated) => the actor the authenticator resolves: its facts
      '/messages/:id': { params: ownThread }, // computed in the load's own request, as its actor
      '/oauth/consent': { search: consentQuery }, // the query string a load reads off `url`
      '/about': { empty: 'renders a static page: no row' },
      '/admin': { off: 'measured by its own e2e test' },
    },
  },
);
```

`params`, `search` and an `actor` function run inside the load's request before the observed call,
so their statements are never the load's; a function that throws leaves the load `unreached` with
`its exercise.ts <field> threw`. `statements: { max, why }` moves its ceiling. A blank `off`, `empty`
or `why` is `X_CONTRACT_EXERCISE_UNDECLARED`; a pattern no route with a `load` has is
`X_DECLARATION_UNKNOWN` before a row is written. A load that reads the app's own typed client
(`queries.orgPosts(…)` over `APP_URL`) is answered **in process** by the app's API, as the actor the
load runs as — `APP_URL` is set to `http://localhost:3000` when the env names none — so its
statements are counted and swept like the page's own. A route load reached with no statement and no
effect is its own `· X_EXERCISE_EMPTY_REACH` line, its fix the `empty` entry to paste; a primitive's
entry takes `empty: '<why>'` too, and a record whose entry gives one carries it as `empty`.

**Push is an effect** (`As of 2026-11-15`). Every actor holds one stand-in Web Push device in the
pass, as the memory mail driver accepts every address, so a notifier's `webPush()` encrypts, signs
and sends to the captured push service, and the record carries `{ kind: 'push', host, count }`. A
pusher that sends nothing leaves no effect: its job is an empty reach, not a delivered push.

**A storage write is an effect** (`As of 2026-11-15`). An object the call puts, copies or deletes
through a `defineStorage` disk is `{ kind: 'storage', disk, op, count }` on its record, so an upload
or export that stores only an object is no empty reach. A read is none, nor is a write the driver
refused. A multipart session (`grantMultipart`, `abortUpload`) is not counted yet: its calls are not
on the event bus.

**`--shard i/n`** (`As of 2026-11-15`) runs the i-th of n disjoint slices of the pass — primitives,
then routes, by their position in the registry — on its own scratch database, and writes
`.x/exercise.<i>-of-<n>.json` (never `.x/exercise.json`). Run the n slices as n processes. Each
slice's findings are its own; the static findings and the subject proof are slice 1's; the whole-pass
floor (`unprovenMax`, its warning line) is judged only unsharded. Beside a `<name>`, or not i/n,
`X_VERIFY_SHARD_INVALID`, fix `x exercise --shard 1/2 --json`.

Errors: `X_CONTRACT_EXERCISE_UNREACHED`, `X_CONTRACT_EXERCISE_UNDECLARED`, `X_DECLARATION_UNKNOWN`, `X_CLI_BAD_FLAG`, `X_EXERCISE_UNPROVEN_ABOVE_FLOOR`, `X_EXERCISE_SEED_FAILED`, `X_STATEMENTS_OVER_BUDGET`; warning lines only: `X_EXERCISE_EMPTY_REACH`.

## x drill

```bash
x drill [<name>] [--list] [--budget-ms n] [--json]
```

The app run through its dependencies failing, `As of 2026-11-06`. Each drill boots a fleet on a
scratch database made on `TEST_DATABASE_URL` and dropped after: `ROLE=migrate`, then `web` and
`worker` as separate processes (`apps/web/server.ts`), each dialling Postgres, and Redis or NATS
where the app declares them, through a Bun TCP fault proxy; `nats-down` adds the `sync` role and a
sync client that dials it. Load runs before, through and after the fault over the site's
parameterless pages and every action an anonymous POST reaches, each request a fresh input drawn
as `x exercise` draws one (`apps/web/exercise.ts` honoured; `data.skippedWrites` names every action
left out and why) — the writes are how a job reaches the queue for the worker drills. `/readyz` is
sampled throughout.

| Drill | Fault | Must hold |
|---|---|---|
| `pg-blackhole` | live sockets unanswered, server healthy | `requests-coded`, `requests-bounded`, `recovers`, `jobs-once` |
| `pg-slow` | every byte delayed half the deadline | `requests-coded`, `requests-bounded`, `recovers` |
| `pg-restart` | `reset`, then `refuse`, then `pass` | `requests-coded`, `readyz-flips`, `recovers`, `jobs-once` |
| `redis-down` | the cache tier blackholed | `requests-coded`, `requests-prompt`, `requests-ok`, `recovers` |
| `nats-down` | the bus refused | `requests-coded`, `recovers`, `sync-resumes` |
| `worker-sigkill` | `SIGKILL` the worker, then a fresh one | `jobs-terminal`, `jobs-once`, `requests-coded` |
| `worker-sigterm` | `SIGTERM` the worker, then a fresh one | `role-exits`, `jobs-terminal`, `jobs-once` |
| `web-sigterm` | `SIGTERM` the web role under load | `requests-ok`, `role-exits` |
| `roll-before-migrate` | the roles started before `ROLE=migrate`, on a schema stamped by an older build | `roles-wait`, `serves-after-migrate`, `one-wait-line` |

`roll-before-migrate`, `As of 2026-11-15`, is the rollout order a deploy cannot always hold: no
fault and no load. The scratch database is migrated, its framework stamp (`x_jobs`' table comment)
is rewound to name only an older build, then `web`, `worker` and `scheduler` start on it without
waiting for readiness, with `sync` when `TEST_NATS_URL` is set and `replicator` when
`TEST_REPLICATION_URL` names a logical server (the scratch database then lives there) and the app
has an entity on a table. A role left out is in `data.rolesNotPlayed[]`, `{ drill, role, needs }`. Once each has logged its wait (or exited), they are held 3 s and
`ROLE=migrate` runs again. Each must stay up (`roles-wait`: an exit is a crash-loop), log exactly
one line naming `X_FRAMEWORK_SCHEMA_UNAPPLIED` (`one-wait-line`), and answer `/readyz` 200 once
migrate has run (`serves-after-migrate`). `ULTIMATE_SCHEMA_WAIT_MS` is inherited: `0` — refuse at
once — turns it red. Its evidence is `evidence.rollout.roles[]`, each
`{ role, exit, ready, waitLines, logTail }`.

Thresholds come from the app: the request deadline (`@ultimat3/http`'s default, 30 s, because
`configureHttp` is runtime code the CLI does not run), `drain.deadlineMs` plus
`drain.readinessGraceMs`, and `health.readiness` — under `'process'`, `readyz-flips` expects 200
throughout. `--budget-ms` replaces the deadline the verdict judges against, not the app's, and is
printed in `data.budgets.override`. An answer may reach the load up to 500 ms past the deadline
(`DRILL_ANSWER_SLACK_MS`: the 504 a deadline fires arrives a beat after it). A 5xx with no `X_*`
code, or `X_INTERNAL`, is always red. A property with no evidence is red, never passed: a job
property is red when no job ran during the drill, `sync-resumes` when no sync client ran.

A service the app uses must be up for every drill; an unset one is refused, never skipped. A named
drill that faults a service the app does not declare is refused; a whole run lists it under
`data.notRun`. `--list` prints the table and runs nothing. `--json`: `{ budgets, targets,
skippedWrites, drills[], notRun, rolesNotPlayed }`, each drill `{ name, verdict, evidence, budgets, baseline }`.

Errors: `X_DRILL_FAILED` (one per property that did not hold), `X_DRILL_SERVICE_MISSING`, `X_CLI_UNKNOWN_COMMAND`, `X_CLI_BAD_FLAG`.

## x test

```bash
x test [unit|contract|live|job|e2e|eval] [--filter path[,path…]] [--allow-empty] [--sample N]
       [--affected [--base <ref>] [--dirty]] [--workers N] [--seed N] [--json]
       [-- <bun test flags>]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| *(positional)* | test type | every type | one of the six; a test's type is its filename suffix |
| `--filter` | string | — | only files whose path contains this substring — or ANY of several, comma-separated (`--filter apps/web/app/billing/,apps/web/app/case/`), in one run. An empty item (`a,,b`) is refused: `''` matches every path |
| `--allow-empty` | boolean | off | a selection that matches no test file exits **0**, spawns nothing, and says so (`no test file matches … — 0 test file(s) ran`, `data.files: 0`, `data.empty: true`) instead of `X_TEST_NO_FILES`. For a runner that computes the selection; a hand-typed typo stays red without it |
| `--sample` | string | — | run at most N files of the selection, deterministically. A fast signal for the eval loop — **never a gate** |
| `--workers` | string | one per 1.25 GiB of a `max(2.75 GiB, 25% of RAM)` budget, at most one per core (the gate's width) | worker count, 1 to 64; each worker gets its own template-cloned database |
| `--affected` | boolean | off | narrow the selection to the tests the diff can break: in an app root, by import closure (the files `x affected` reports as `data.tests`); elsewhere, the workspaces the diff touches and everything that depends on them. `--base`/`--dirty` without it are refused, not ignored |
| `--base` | string | `origin/HEAD`'s branch | the ref to diff against, merge-base (`<base>...HEAD`). Unset: `origin/HEAD`'s target, else `origin/main`, else local `main` — `x affected`'s default. Needs `--affected` |
| `--dirty` | boolean | off | union the working tree in — uncommitted and untracked. Needs `--affected` |
| `--seed` | string | — | replay one `simulateJobs` seed, the `N` an `X_JOB_SIM_INVARIANT` names: handed to every `bun test` child as `ULTIMATE_JOB_SIM_SEED`, which runs that seed alone. A uint32, else `X_CLI_BAD_FLAG`. The shard reproduce line does not carry it yet |
| `-- <args>` | tail | — | handed to `bun test` verbatim, before the file list — `x test unit -- --coverage --bail`. The reproduce line carries it back. **`x test` is the only command that reads a `--` tail**: every other one refuses it (`X_CLI_BAD_FLAG`) rather than dropping it, which is what all of them did until 2026-09 |

The type rule is `x verify`'s, not a second one — so `x test contract` runs exactly what the gate's `contract` step runs. A selection that matches no files is `X_TEST_NO_FILES` (green with `--allow-empty`); an unknown type is `X_CLI_BAD_FLAG` naming the six and suggesting the nearest.

**Exit codes, `As of 2026-11-19`.** `0`: at least one test ran and none failed. `1`: a test failed — `X_TEST_FAILED`, its cause naming the failing files (up to 5) and its fix rerunning the first one alone (`x test <type> --filter <file> --workers 1`; the whole reproduce line only when bun named no file; `data.reproduce` unchanged). **`1` too when every test the run selected skipped itself** (`ran 0`, `skipped N`): `bun test` exits 0 there, but nothing was checked. The summary reads `live — 0 test(s) ran: all 1 skipped themselves, so nothing was checked`; the finding is `X_TEST_FAILED`, its cause naming any unset `TEST_DATABASE_URL`, `TEST_REDIS_URL` or `TEST_NATS_URL` and its fix starting the test services, then the same selection — or, with nothing unset, a `grep -nE 'skip|needs:'` over the files. `x verify` is unaffected: its steps do not go through this verdict.

**In an app root `--affected` narrows by import closure, `As of 2026-11`** — every slice shares the `apps/web` workspace, so the workspace answer ran the whole app. The rule is `x affected`'s `data.tests`, never a second one: a test runs when its imports reach a changed file, transitively; a changed file the import graph cannot speak for (`app.config.ts`, `package.json`, a catalog, anything outside the app) runs every test; a discovered test outside the scanned globs always runs. `data.affected.tests` carries `{ app, all, reason, forcing, files: [{ path, why }] }` — `reason` is `closure: N changed file(s)` or `all: <forcing files>`, `why` is `closure`, `all` or `unmapped`. Outside an app root, `data.affected` has no `tests` and the workspace scope is unchanged.

`--affected` narrows the FEEDBACK, never the gate. The GATE stays un-narrowable — `x verify` with no flag is the gate, and `x verify --only <step>` announces `NOT A GATE RUN` in both renderers precisely so a narrowed run can never be read as one — because a gate that can be scoped is a gate that can be scoped wrong. Nothing affected is **green with zero spawns**, not a failure: editing a `.md` should not fail a build. A failure's `fix:` carries `--affected --base <ref>` back with it, because `--affected` decides which files exist to run at all and a rerun without it selects the whole corpus.

**The inner loop in this repository is `bun run test:affected`, `As of 2026-11-07`** — `x test --affected --base origin/main --dirty` from the root: the workspaces the branch and the working tree touch, plus every workspace that depends on one; a changed file no workspace owns (`package.json`, `bun.lock`, `tsconfig*.json`, `biome.json`, `scripts/**`, the test preload) runs everything, and `.md` alone runs nothing. `bun run test` is `x test` over the whole corpus — the same passes and width as the gate's test steps. Neither is the gate: CI and `x verify merge` run full `x verify`.

**A selection that mixes serial files with the rest is more than one run, `As of 2026-09`.** `--parallel=N` is the width of the WHOLE `bun test`, so the bare `x test --workers 8` — which selects every type — ran `live` and `e2e` eight at a time beside the unit corpus, over the very files `x verify` runs one at a time. The files are partitioned by type: one pass at the requested width for everything that may share a pool, then one pass at `--parallel=1` per serial type, each reproducible on its own (`x test live --workers 1`). `--json` carries a `passes` array when there was more than one.

## x clean

```bash
x clean [--dry-run] [--services] [--json]
```

Every test leftover the framework knows of, cleared (`As of 27.3.0`): the migrated test-database templates under `.x/test-db`, the whole `.x/cache`, any `.x` folder below the app root, and — with `TEST_DATABASE_URL` set — every probe database whose run is over. `--dry-run` names them and removes nothing; `--json` carries `data.paths` and `data.databases`. Never touched: `.x/pgdata` (the dev database), `.x/storage`, the build output. The test runner sweeps the same set before every run, keeping the newest two of each cache, so `x clean` is for reclaiming the rest by hand. [Testing](Testing#database-state-and-what-a-run-leaves-behind) has the table.

**`--services`** (`As of 2026-11-18`) also runs `docker compose -f docker/docker-compose.test.yml down --volumes` for this checkout's stack. A stack another existing checkout started is kept, with the line that stops it. Every other test stack on the machine is listed, never touched. `--dry-run` stops nothing. `--json`: `data.services` with `action` (`stopped`, `would-stop`, `kept`, `none`, `failed`), `project`, `services`, `owner`, and `others[]` (`project`, `status`, `root`, `gone`). Docker failing is `X_TEST_SERVICES_UNAVAILABLE`, exit 1.

## x affected

```bash
x affected [--base <ref>] [--dirty] [--paths] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--base` | string | `origin/HEAD`'s branch | the ref to diff against. The diff is `<base>...HEAD` — **three dots**, so it is measured from the merge-base and an unrelated commit on `main` does not widen the answer. Unset, the base is the **remote-tracking** default branch, as already fetched (never fetched for you): `origin/HEAD`'s target, else `origin/main`, else local `main` when there is no remote-tracking ref (`origin/HEAD` or `origin/main`) (`As of 31.1`). `data.base` names the ref used |
| `--dirty` | boolean | off | union the working tree in: uncommitted changes plus untracked files |
| `--paths` | boolean | off | stdout is the directories alone, one per line — `bun test $(x affected --paths)`; notes and the `✓` summary go to stderr (`As of 31.1`). Under `--json` stdout stays the one document, and `data` is byte-identical either way |

**Transitive, or it is worse than nothing.** `A → B → C` means a change in `C` must reach `A`; a single pass over an unordered list reaches only `B`, and a scoped run that misses a transitive dependent is a green checkmark on a broken repo. The graph it walks is the one every workspace's `package.json` declares — which is why `package-shape` refuses an undeclared cross-workspace import (`X_WORKSPACE_DEP_UNDECLARED`): an edge missing from a manifest is an edge missing from this answer, silently.

Three rules the set obeys:

| Change | Affected |
|---|---|
| any non-doc file no workspace owns — `tsconfig.json`, `tsconfig.base.json`, `biome.json`, `bun.lock`, root `package.json`, `app.config.ts`, `scripts/**`, `guards/**` | **every** workspace, and the root itself: `x test --affected` runs every test file, those under no workspace included. Decided by ownership, never by a list of names |
| a workspace's own `package.json` | that workspace only |
| a `.md` | nothing. A doc has no compilation unit to re-check |

**Why the default base is `origin/main`, not `main`.** Local `main` moves only on a pull, so in a checkout nobody pulls — or a worktree — it lags origin, and `main...HEAD` counts every file origin merged since as this branch's work. `origin/main` moves on any `git fetch`. `x verify --changed` and `x test --affected` read the same default.

**`--base` is the default and `--dirty` is opt-in, which is the reverse of the obvious design.** This repo runs several agents concurrently in **one checkout** (no worktrees), so a working-tree diff returns every agent's uncommitted work at once and the "affected" set quietly expands to nearly the whole monorepo — narrowing nothing while reading as though it did. A ref diff is stable under that. `--dirty` is the right answer for one developer iterating alone.

**Typecheck is deliberately not scoped.** `bun run typecheck` is `tsc -b`, a project build over a shared `.tsbuildinfo`, so a "scoped" typecheck is either the whole project anyway or a weaker check. The time is in the tests, which is what `x test --affected` narrows.

## x policy

```bash
x policy [list|explain <subject> [--input '<json>']] [--json]
```

| Subcommand | Does |
|---|---|
| `list` | every permission, the roles that grant it, and the actions and queries that enforce it — plus the permissions **nothing** enforces, which are grants that do nothing |
| `explain <subject>` | one row per actor per declaration — every declared role plus `anonymous`, for each action or query that enforces the subject — naming the clause that decided and its reason. Verdict `allow`, `deny`, or `needs input` |

| Flag | Does |
|---|---|
| `--input '<json>'` | `explain` only: the request's input, as one JSON argument. A predicate that reads input is decided on it. Not JSON is `X_CLI_BAD_FLAG`, reported by length; the value is never echoed back |

`<subject>` resolves in order against a permission (`post:publish`), an action name (`publishPost`), a query name (`postFeed`), then an action's HTTP path (`/api/posts/publish`) — so the `fix:` line printed by an `X_FORBIDDEN` is runnable whichever of the four the throwing surface had to hand.

```bash
$ x policy explain closeTicket
  action closeTicket — policy ticket:write
  actor      verdict      deciding      reason
  anonymous  deny         ticket:write  no actor for ticket:write
  admin      needs input  ticket:write  not denied — every actor-only clause passes, and ticket:write has a predicate that reads the request input
  viewer     deny         ticket:write  actor lacks ticket:write
    evaluated with no request input and no row — a rule reading either decides again on the real request
✓ closeTicket — allowed for 0 of 3 actor evaluation(s); 1 not denied, decided by a predicate that reads the request input — x policy explain closeTicket --input '<the request input as JSON>'

$ x policy explain closeTicket --input '{"orgId":"0190…","ticketId":"0190…"}'
```

The verdict comes from `@ultimat3/policy`'s own `policyMatrix()` over the app's real `Policy` objects — the same evaluation the request path runs, never a second one. With no `--input` there is no request to read, so a predicate that reads one is **not decided**: the row says `needs input` (`verdict: "needs-input"`, `allowed: null` in `--json`, counted in `data.pending`), never `deny` (`As of 2026-11-19`). Reading is detected, not assumed: the predicate runs over a stand-in input that records being read, so one reading only the actor (`({ actor }) => …`) still decides. `deny` means what it says — no actor, no grant, or an actor-only predicate that refused. A row-level rule is evaluated with no row and decides again on the real request (`row?.ownerId === actor.id` still reads `deny` under that note). The actors carry no `orgId`, so an org-scoped predicate compares against `undefined` even with `--input`. With `--input`, a policy that throws on it (a field the JSON does not carry) reports `decidable: false` and a note in place of the table, never a table of invented denials.

Errors: `X_DECLARATION_UNKNOWN`, `X_CLI_BAD_FLAG`.

## x i18n

```bash
x i18n [check|add <locale>|sync <locale>|split [<locale>]] [--json]
```

| Subcommand | Does |
|---|---|
| `check` | scan every `t('…')` in the app's source, audit it against every catalog on disk, and **fail** on a missing key |
| `add <locale>` | write `packages/i18n/catalogs/<locale>.json` (a directory when the default locale is split) seeded with the default locale's keys and values |
| `sync <locale>` | add the keys that locale is missing (into its namespace file when split); a key it already has is never overwritten, translated or not |
| `split [<locale>]` | move flat catalogs into `catalogs/<locale>/<namespace>.json` plus a generated `index.ts`; lossless, idempotent ([I18n](I18n#split-catalogs)) |

Catalogs are one file per locale under `packages/i18n/catalogs/`, or one directory per locale of namespace files ([I18n](I18n#split-catalogs)). `check` reports three things separately: `missing` (a gap, and an exit code), `unused` (defined and never called), and `dynamic` — a `t(`plans.${plan}.name`)` the extractor cannot resolve. A dynamic call contributes its static head as a runtime-key prefix, so a key only ever reached that way is never listed unused; an expression with no static head contributes nothing, because a guessed prefix would suppress real gaps.

Errors: `X_CATALOG_MISSING_KEYS` (per locale, as a finding), `X_I18N_FAMILY_INCOMPLETE` (a `_select_`/`_ordinal_` family with no `_other`), `X_CATALOG_INVALID`, `X_CATALOG_LAYOUT_MIXED` (`<locale>.json` beside `<locale>/`), `X_CATALOG_KEY_DUPLICATE` (one key in two namespace files), `X_GENERATE_CONFLICT` (`add` over an existing catalog), `X_CLI_BAD_FLAG`, `X_SCAFFOLD_PATH_ESCAPE`.
