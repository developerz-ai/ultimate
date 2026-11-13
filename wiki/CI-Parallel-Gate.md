# CI: the gate across parallel jobs

`x verify` is the gate on a laptop (its `budgets` step builds when the stats are stale): one
process tree, bounded to a memory budget. On CI, where wall time is what a pull request waits on,
the same gate splits across jobs — each step runnable on its own, the parallel test steps sharded —
and one aggregate job folds the parts back into the one verdict. Green means exactly what the local
gate's green means: every step, over the whole tree, passed.

## Every step is its own command

`x verify --only <step>[,<step>…] --json` runs just those steps, in one process, paying nothing
for the others (no app load for a step that does not need one, no test run for a static step). Its
JSON is a *part*: `x verify merge` reads it back.

| Step | One job runs | Needs |
|---|---|---|
| `typecheck` | `x verify --only typecheck --json` | nothing |
| `lint` `boundaries` `filesize` `package-shape` `errors` | `x verify --only lint,boundaries,filesize,package-shape,errors --json` | nothing |
| `unit` | `x verify --only unit --shard i/n --json` | nothing (PGlite in process) |
| `contract` | `x verify --only contract --shard i/n --json` | nothing |
| `job` | `x verify --only job --shard i/n --json` | nothing |
| `live` | `x verify --only live --json` (or `--shard i/n`) | the test services (`docker/test-services.env`): Postgres (`TEST_DATABASE_URL`), the logical + TLS server (`TEST_REPLICATION_URL`, `TEST_TLS_REPLICATION_URL`), pooler, standby, Redis, NATS, S3 — one process per runner |
| `e2e` | `x verify --only e2e --json` (or `--shard i/n`) | the static build (`x build --target static --no-preflight`), Chrome — one process per runner |
| `eval` | `x verify --only eval --json` | nothing; baselines committed |
| `drift` `contract-diff` | `x verify --only drift,contract-diff --json` | nothing |
| `budgets` `seo` `i18n` `policy` | `x verify --only budgets,seo,i18n,policy --json` | the static build — `budgets` weighs `.x/build-stats.json` |
| `manifest` `roadmap` | `x verify --only manifest,roadmap --json` | nothing |

The grouping is yours: any split works as long as every step lands in exactly one part (or, for a
sharded step, in shards `1..n` exactly once). `x verify merge` refuses anything else.

## `--shard i/n` — the parallel test steps

```bash
x verify --only unit --shard 2/4 --json > part-unit-2.json
```

- Only with `--only`, and only over the test steps: `unit`, `contract`, `live`, `job`, `e2e`
  (any other step is `X_VERIFY_SHARD_INVALID`). `live` and `e2e` stay ONE process inside a shard —
  serial means one replication slot and one browser per machine, and each runner starts its own
  services — so when sharded, their shards split across runners, never across workers. `As of 2026-11-07` this
  repository's CI still runs each as one part: its longest job is a `packages` coverage shard, so
  a second live or e2e runner would cost runner minutes and save no wall clock.
- The split is a pure function of the step's **sorted** file list: round-robin by default, so job
  2 of 4 is the same files on every runner and on your laptop. `--timings <file>` (Bun's
  `--timings` file, e.g. the `.x/test-timings.json` every parallel run refreshes — cache it
  between CI runs) splits greedy longest-first instead; a file the timings do
  not know is costed at their median.
- The part's JSON carries `data.shard` (`index`, `total`, and per step the `corpusHash` of the whole
  list plus the `files` this shard ran), and each step carries the same facts as `steps[].shard`.
- A shard whose slice is empty, or ran only skipped tests, is not red: the zero-tests floor
  (`x.verify.json`) is applied by `merge`, on the counts summed over every shard.
- An app's coverage floor is not judged by a shard — one slice cannot hold it. The shard is green
  on coverage and carries what it covered in `data.coverage.unit.facts`; `merge` folds every shard and judges
  once (`X_COVERAGE_BELOW_FLOOR`). Shards that carry nothing fold to 0%, never to a skip.
- Under `--json` each finished step is one line on stderr (`{"step":"unit","ok":true,"ms":61250}`),
  so a cancelled job's log ends on the last step that finished. Redirect stdout only.
- A red shard reproduces locally with the same flags.

## `x verify merge <part.json…>` — the verdict

```bash
x verify merge parts/*.json --json
```

Reads each part (the **last** JSON line of the file, so an older scaffold's `bun run check --json` output works too) and
answers the gate:

- every step of the gate appears — `X_VERIFY_MERGE_INCOMPLETE` names a step no part ran;
- a sharded step has shards `1..n` exactly once, all with one `corpusHash` — a missing shard, a
  duplicate, or two corpora (jobs on different commits) is named;
- and their `files` partition that corpus: a file in two shards, or in none (the union does not
  hash to `corpusHash` — shards split by two rules, one with `--timings` and one without), is named;
- the zero-tests floor is applied to each sharded step's summed counts;
- an app's coverage floor is applied to the fold of a sharded `unit` step's `data.coverage.unit.facts`;
- a red step in any part is red here, with its findings and output kept.

The merged document has no `notAGateRun` — it is the gate's answer — and its `durationMs` is the
slowest part's, which is the wall time CI waited. A part that is not an `x verify --json`
document is `X_VERIFY_MERGE_INPUT` — and so is a step whose `durationMs` is not a number or whose
`findings` are not each a `code`, `cause` and `fix`.

## `x verify plan` — the parts, as data

`As of 31.17.0`. `x verify plan [--parts n] --json` answers the split instead of a workflow spelling
it: `data.matrix` is a GitHub `strategy.matrix`, one row per part —
`{ part, only, shard?, needs }` — derived from `VERIFY_STEP_NAMES`, so a step the gate gains lands in
a part with no workflow edit. Pure: no file read, nothing started.

```text
$ x verify plan --parts 4
unit-1  x verify --only unit,contract,job --shard 1/1  (database)
live-1  x verify --only live --shard 1/1  (services)
static  x verify --only lint,boundaries,filesize,package-shape,errors,exercise,eval,drift,contract-diff,budgets,seo,i18n,policy,manifest,roadmap  (none)
e2e  x verify --only typecheck,e2e  (database)
```

| `--parts` | Layout |
|---|---|
| `1` | `gate`: every step on one runner, `needs: services` |
| `4`–`64` (default `4`) | `static` and `e2e` (`typecheck` + `e2e`, the two slow unsharded steps) whole; the rest of the runners split between shards of `unit,contract,job` and of `live`, the unit group taking the odd one |
| `2`, `3`, `0`, `65`+ | `X_CLI_BAD_FLAG` — two or three runners cannot hold this layout |

`needs` is a level, not service names: `none`, `database` (the test Postgres alone) or `services`
(every test service) — the compose file is the app's, and the workflow is the one place its names are
spelled. **`x new`'s `.github/workflows/ci.yml` reads it**: a `plan` job runs
`bun run verify plan --parts 4 --json` and hands `.data.matrix` to the `gate` job by `fromJSON`;
each part runs `bun run setup`, starts what its `needs` asks for, runs
`bun run verify --only "$ONLY" ${SHARD:+--shard "$SHARD"} --json` and uploads the document, red or
green; `verify` downloads every part and runs `bun run verify merge`. An app scaffolded before 31.17.0
keeps its one-job workflow, which still works; to adopt, copy a fresh scaffold's
`.github/workflows/ci.yml`.

This repository's own `ci.yml` stays hand-written — it carries services and URLs only the framework
has — and `verify-plan.test.ts` holds its `gate` matrix to `verifyPlan(7)`: a step added to the gate
or a part edited out of the matrix is red there before it is `X_VERIFY_MERGE_INCOMPLETE` after a push.

## A GitHub Actions workflow, by hand

The same shape with a matrix you write yourself — for a split the plan does not make:

```yaml
name: ci
on: [push, pull_request]

jobs:
  part:
    name: ${{ matrix.name }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false # every part must upload, red or green: merge decides
      matrix:
        include:
          - { name: typecheck, only: typecheck }
          - { name: static, only: 'lint,boundaries,filesize,package-shape,errors' }
          - { name: unit-1, only: unit, shard: 1/4 }
          - { name: unit-2, only: unit, shard: 2/4 }
          - { name: unit-3, only: unit, shard: 3/4 }
          - { name: unit-4, only: unit, shard: 4/4 }
          - { name: contract-1, only: contract, shard: 1/2 }
          - { name: contract-2, only: contract, shard: 2/2 }
          - { name: job, only: job, shard: 1/1 }
          - { name: tail, only: 'eval,drift,contract-diff,manifest,roadmap' }
          - { name: built, only: 'e2e,budgets,seo,i18n,policy', build: true }
          - { name: live, only: live, postgres: true }
    env:
      TEST_DATABASE_URL: ${{ matrix.postgres && 'postgres://postgres:postgres@localhost:5432/postgres' || '' }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - if: matrix.postgres # live needs logical replication: a service container cannot pass -c
        run: |
          docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17 -c wal_level=logical
          until docker run --rm --network host postgres:17 pg_isready -h localhost; do sleep 1; done
      - if: matrix.build
        run: bunx x build --target static --no-preflight
      - name: x verify (one part)
        run: |
          bunx x verify --only '${{ matrix.only }}' \
            ${{ matrix.shard && format('--shard {0}', matrix.shard) || '' }} \
            --json > "$RUNNER_TEMP/part.json" || true
      # Outside the checkout: the file is open and empty while the part runs, and `lint` walks the tree.
      - uses: actions/upload-artifact@v4
        with: { name: 'part-${{ matrix.name }}', path: '${{ runner.temp }}/part.json' }

  check: # the one required status check
    needs: part
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with: { pattern: 'part-*', path: parts }
      - run: bunx x verify merge parts/*/part.json
```

Make `check` the single required status. A job that crashed before uploading its part is not a
pass: its steps are missing and `merge` names them.

## A push a green PR run already tested

Merging an up-to-date green pull request pushes a tree CI has already tested. `x ci tested` says
so — `data.tested` — and every job that run answered skips. As of 2026-11, 55 of this repository's
last 81 pushes to `main` were such a tree.

| `tested: true` needs | Why |
|---|---|
| the subject ends `(#N)` | only a merge of PR N is a candidate |
| PR N merged as **this** commit | a `(#N)` typed by hand proves nothing |
| its head is in this repository | a fork writes its own workflow; its green is not reused |
| its head tree is this tree | a base that moved after the run is an untested merge |
| the newest same-repository run on that head concluded `success`, under `--max-age` (default `24h`) | the runner image and the registry move |

Any doubt — a condition unmet, `gh` absent, an API that did not answer — is `false`: a full run.
The command exits 0 on every answer.

```yaml
jobs:
  tested:
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: read, pull-requests: read }
    outputs:
      tested: ${{ steps.tested.outputs.tested }}
    steps:
      # Only a push asks. Never a release commit: what publishes is a run of everything.
      - if: github.event_name == 'push' && !startsWith(github.event.head_commit.message, 'release')
        uses: actions/checkout@v4
      - if: github.event_name == 'push' && !startsWith(github.event.head_commit.message, 'release')
        uses: oven-sh/setup-bun@v2
      - if: github.event_name == 'push' && !startsWith(github.event.head_commit.message, 'release')
        run: bun install --frozen-lockfile
      - id: tested
        if: github.event_name == 'push' && !startsWith(github.event.head_commit.message, 'release')
        env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          bunx x ci tested --repo "$GITHUB_REPOSITORY" --json > tested.json
          echo "tested=$(jq -r .data.tested tested.json)" >> "$GITHUB_OUTPUT"

  part:
    needs: tested
    if: ${{ !cancelled() && needs.tested.outputs.tested != 'true' }}
    # … the matrix above, unchanged

  check:
    needs: [tested, part]
    if: ${{ !cancelled() && needs.tested.outputs.tested != 'true' }}
    # … unchanged
```

Each reused job carries that **one** `if` and nothing else, so a skip has exactly one cause:
`tested` said true. `!cancelled()` is load-bearing: a bare `needs.…` condition implies
`success()`, and a red or timed-out `tested` would skip every job instead of running them. A
reader of a skipped check (a deploy, a required status) can then accept the skip only beside a
green `tested` check. On a
pull request every step of `tested` is skipped and nothing below it is. The cost: one near-empty
job's runner acquisition ahead of every other job, a few seconds.

## Width and memory, per job

Each job sizes its own test width the same way the laptop does (`x verify` prints it on the step
line, e.g. `3 workers (budget 4.0 GB)`): a budget of `max(2.75 GiB, 25% of the runner's RAM)`,
1.25 GiB planned per worker, never more workers than cores. On a 16 GB `ubuntu-latest` that is 3
workers; a 62 GB, 16-core workstation plans 12 (`As of 2026-11-07`, when the fixed 4 GiB cap went —
the machine-wide slot pool is what keeps two runs on one box inside one budget). `ULTIMATE_TEST_MEMORY_BUDGET=6g` or `ULTIMATE_TEST_MAX_WORKERS=4` override it; `--workers`
wins over both. The machine-wide slot pool (see [Testing](Testing#memory-width-and-isolation))
has nothing to share on a one-job VM; `ULTIMATE_TEST_SLOTS=0` turns it off.

## Skipping the build's duplicate preflight

`x build` runs the six static steps before it builds (typecheck, lint, boundaries, filesize,
package-shape, errors) so a bare build never ships an artifact from a tree that does not typecheck.
In a gate that runs those steps anyway, `--no-preflight` skips them — `x verify`'s `budgets` step does
when it builds, and so does the `built` job above, whose build first leaves `budgets` fresh stats and
no second build. The default stays safe.
