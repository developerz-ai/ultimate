# Working with many agents

**A parallel worker runs its own files. The coordinator runs the whole gate, once, at the end.** Every other rule on this page exists so that this one holds when several agents, in several checkouts and repositories, share one machine. `As of 2026-11-18`.

| Who | Runs | Never runs |
|---|---|---|
| a worker with a file set | `bun test ./its/file.test.ts`, `x test --filter <path>` over up to 3 files, `biome check <its paths>` | `x verify`, `bun run verify`, a whole `x test`, `bun run coverage` |
| the coordinator | `bun run verify` (or `x verify`) once, after the workers land | a second gate beside the first |
| a read-only agent (research, explore) | one command at a time, output bounded with `head` | any build, test, typecheck or index run |

**Read-only fan-out has its own limit.** Those agents write nothing, so they take no file set, but each is a whole session no ledger can see: its memory is outside the machine's accounting. Start a handful, not one per question.

## The machine ledger

One ledger per machine and user, at `/tmp/ultimate-heavy-<uid>`, shared by every checkout and every Ultimate app on the machine. It admits **half of the memory this process may use** (the smallest of RAM and every cgroup `memory.max` above it). Each heavy run reserves its measured peak first, in arrival order, and waits when it does not fit.

| Enters the ledger | Reserves |
|---|---|
| `tsc -b` of a monorepo (`x verify`'s `typecheck`, `bun run typecheck:locked`) | 6,016 MB, plus this checkout's one-compiler lock |
| `tsc -p .` of an app (`x verify --only typecheck`) | 768 MB, plus the same lock |
| `biome check .` (`x verify --only lint`) | 2,112 MB |
| every batch of `bun test` workers (`x test`, `x verify`'s suites) | 704 MB + 1,280 MB per worker |
| an e2e lane (`x test e2e`, `x verify --only e2e`) | 3,072 MB |
| one coverage unit (`bun run coverage`), one heavy `bun run preflight` step | 704 MB + 1,280 MB per worker |
| anything under `x heavy run` | `--mb`, default a monorepo typecheck |

**What does not enter it, stated:** a bare `bun test ./path`; `x test` selecting 3 files or fewer; an app's own `bun run typecheck` and `bun run lint` scripts (raw `tsc` and `biome`); `bun run typecheck` at this repository's root; `x build`, including the one `budgets` runs; the `drift`, `exercise` and `contract-diff` steps; `x dev`; the test services in Docker; the agent sessions themselves. Those are why only half the memory is offered.

Every entry is an `flock(2)`, and a holder hands the locked descriptor to its workload, so the kernel frees a reservation only when the holder **and** the workload are gone. Kill a wrapper with `kill -9` and its reservation lasts until the command it started exits; a killed waiter leaves the queue at once. A daemon left running by a killed run keeps its reservation until it stops, and `x heavy status` names the run.

```sh
x heavy status            # who runs, who waits, load, memory
x heavy status --json
x heavy run --label suite --mb 4096 -- bun run test   # any command, in any repository
```

A waiter prints one line on stderr saying its position and who holds the memory, and again only when that changes, so `--json` output stays one document. `x heavy run` passes the exit code through and forwards stop signals. A process started inside a reservation inherits it (`ULTIMATE_HEAVY_HOLD`) and never queues behind its own parent. Time spent queued does not count against an `x verify` step's deadline.

## Cores

Locally a run takes **at most 4 cores**, fewer when other sessions' runnable tasks already fill the machine, and never below 2. Test workers are capped per batch, so a run narrows and widens as the machine changes; `tsc` and `biome` get the cap as `GOMAXPROCS` and `RAYON_NUM_THREADS`. `--workers N` is taken as written. CI takes every core.

## Switches

| Variable | Effect |
|---|---|
| `ULTIMATE_HEAVY_MEMORY=8g` | what the ledger admits; `0` turns it off |
| `ULTIMATE_HEAVY_CORES=6` | the local core ceiling |
| `ULTIMATE_HEAVY_DIR=<path>` | another ledger; also opts a test run in |
| `ULTIMATE_TEST_SLOTS=0` | test workers skip the ledger |

Admission is off under `CI`, inside `bun test` (a fixture's `x test` must not queue behind real work), and on **Windows**, which has no `flock`: the core cap still applies there and `x heavy status` says why admission is off. A ledger that cannot work is reported as `X_HEAVY_LEDGER_UNAVAILABLE` and the command goes ahead; it never fails a run.

## Re-measuring a weight

Each figure sits in [`packages/cli/src/heavy-weights.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/heavy-weights.ts) beside its command. Re-read one on a clean snapshot:

```sh
GOMAXPROCS=4 bun run scripts/heavy-peak.ts -- node_modules/.bin/tsc -b --pretty false
```
