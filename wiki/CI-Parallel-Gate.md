# CI: the gate across parallel jobs

`bin/check` (`x build --target static --no-preflight && x verify`) is the gate on a laptop: one
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
| `live` | `x verify --only live --json` | a Postgres with `wal_level=logical` (`TEST_DATABASE_URL`) — serial, never sharded |
| `e2e` | `x verify --only e2e --json` | the static build (`x build --target static --no-preflight`), Chrome — serial, never sharded |
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

- Only with `--only`, and only over `unit`, `contract` and `job`. `live` and `e2e` are serial by
  design (one replication slot, one built output) and are refused with `X_VERIFY_SHARD_INVALID`.
- The split is a pure function of the step's **sorted** file list: round-robin by default, so job
  2 of 4 is the same files on every runner and on your laptop. `--timings <file>` (Bun's
  `--timings` file, e.g. the `.x/test-timings.json` every parallel run refreshes — cache it
  between CI runs) splits greedy longest-first instead; a file the timings do
  not know is costed at their median.
- The part's JSON carries `data.shard` (`index`, `total`, and per step the `corpusHash` of the whole
  list plus the `files` this shard ran), and each step carries the same facts as `steps[].shard`.
- A shard whose slice is empty, or ran only skipped tests, is not red: the zero-tests floor
  (`x.verify.json`) is applied by `merge`, on the counts summed over every shard.
- A red shard reproduces locally with the same flags.

## `x verify merge <part.json…>` — the verdict

```bash
x verify merge parts/*.json --json
```

Reads each part (the **last** JSON line of the file, so `bin/check --json` output works too) and
answers the gate:

- every step of the gate appears — `X_VERIFY_MERGE_INCOMPLETE` names a step no part ran;
- a sharded step has shards `1..n` exactly once, all with one `corpusHash` — a missing shard, a
  duplicate, or two corpora (jobs on different commits) is named;
- the zero-tests floor is applied to each sharded step's summed counts;
- a red step in any part is red here, with its findings and output kept.

The merged document has no `notAGateRun` — it is the gate's answer — and its `durationMs` is the
slowest part's, which is the wall time CI waited. A part that is not an `x verify --json`
document is `X_VERIFY_MERGE_INPUT`.

## A GitHub Actions workflow

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
            --json > part.json || true
      - uses: actions/upload-artifact@v4
        with: { name: 'part-${{ matrix.name }}', path: part.json }

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

## Width and memory, per job

Each job sizes its own test width the same way the laptop does (`x verify` prints it on the step
line, e.g. `3 workers (budget 4.0 GB)`): a budget of `min(4 GiB, 25% of the runner's RAM)`,
1.25 GiB planned per worker, never more workers than cores. On a 16 GB `ubuntu-latest` that is 3
workers. `ULTIMATE_TEST_MEMORY_BUDGET=6g` or `ULTIMATE_TEST_MAX_WORKERS=4` override it; `--workers`
wins over both. The machine-wide slot pool (see [Testing](Testing#memory-width-and-isolation))
has nothing to share on a one-job VM; `ULTIMATE_TEST_SLOTS=0` turns it off.

## Skipping the build's duplicate preflight

`x build` runs the six static steps before it builds (typecheck, lint, boundaries, filesize,
package-shape, errors) so a bare build never ships an artifact from a tree that does not typecheck.
In a gate that runs those steps anyway, `--no-preflight` skips them — `bin/check` does, and so does
the `built` job above. The default stays safe.
