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
| `tsc -b` of a monorepo (`x verify`'s `typecheck`, `bun run typecheck` at this repository's root) | 6,016 MB, plus this checkout's one-compiler lock |
| `tsc -p .` of an app (`x verify --only typecheck`) | 768 MB, plus the same lock |
| `biome check .` (`x verify --only lint`) | 2,112 MB |
| every batch of `bun test` workers (`x test`, `x verify`'s suites) | 704 MB + 1,280 MB per worker |
| an e2e lane (`x test e2e`, `x verify --only e2e`) | 3,072 MB |
| one coverage unit (`bun run coverage`), one heavy `bun run preflight` step | 704 MB + 1,280 MB per worker |
| anything under `x heavy run` | `--mb`, default a monorepo typecheck |

**What does not enter it, stated:** a bare `bun test ./path`; `x test` selecting 3 files or fewer; an app's own `bun run typecheck` and `bun run lint` scripts (raw `tsc` and `biome`: a scaffolded agent brief says `bunx x verify --only typecheck` instead); `x build`, including the one `budgets` runs; the `drift`, `exercise` and `contract-diff` steps; `x dev`; the test services in Docker; the agent sessions themselves. Those are why only half the memory is offered.

Every entry is an `flock(2)`, and a holder hands the locked descriptor to the command it starts, so the kernel frees a reservation only when the holder **and** that command are gone. Kill a wrapper with `kill -9` and its reservation lasts until the command it started exits; a killed waiter leaves the queue at once. Descendants keep it only by inheritance: a shell's background job does, and a process started through `Bun.spawn` or `node:child_process` does not, because both close the descriptor. So a daemon a shell left running keeps the reservation until it stops (`x heavy status` names the run), and workers a killed `bun` command leaves behind are unaccounted. `As of 2026-11-18`, Bun 1.4.4.

```sh
x heavy status            # who runs, who waits, load, memory
x heavy status --json
x heavy run --label suite --mb 4096 -- bun run test   # any command, in any repository
x heavy run --max-wait 300 -- bun run test            # give up after 5 minutes in the queue
```

**A waiter needs nothing from you: leave it running, it starts by itself.** It prints one line on stderr saying its position, who holds the memory and that, and again only when that changes, so `--json` output stays one document. Killing a waiter loses its place, so a harness with a short command timeout should run the command in the background. To bound the wait, `x heavy run --max-wait <seconds>` stops with `X_HEAVY_WAIT_EXPIRED` and exit 75, without starting the command; `0` is one attempt.

`x heavy status` names each reservation's processes. After `kill -9` of a wrapper it reads `wrapper pid N exited, command pid M`: M is what still holds the memory, and `--json` carries the same as `wrapperAlive` and `childPids`.

`x heavy run` passes the exit code through and forwards stop signals. A process started inside a reservation inherits it (`ULTIMATE_HEAVY_HOLD`) and never queues behind its own parent. Time spent queued does not count against an `x verify` step's deadline.

## Merging two features

**Two branches that each ran `x g resource` merge with no hand edit.** `bun run setup` installs the drivers (`x merge-driver install`); `.gitattributes` says which file takes which. `As of 2026-11-19`.

| Files | On a merge | After it |
|---|---|---|
| `apps/web/api/index.ts`, `apps/web/exercise.ts`, `apps/web/shared/roles.ts`, `packages/db/src/client.ts` | what both sides **added** is kept, sorted, so either merge direction writes the same bytes | nothing |
| `packages/i18n/catalogs/*.json` | three-way by key | nothing |
| `x.manifest.json`, `openapi.json` | our copy is kept | `bunx x manifest`, then commit |

```sh
git merge feature-b
bunx x manifest
bunx x verify
```

**What stays a conflict, on purpose:**

| Both branches | Why a person decides |
|---|---|
| changed or removed one existing line | `merge=union` would keep both, so a revoked grant in `roles.ts` would come back |
| declared one key, or one import name, differently | either could be the right one |
| gave one catalog key two wordings | which text ships is a decision |

`X_MERGE_UNRESOLVED` lists what is left: `git diff --name-only --diff-filter=U`. Resolve each, `git add` it, finish the merge.

- **Why one entry per line.** Registries are written that way (`x new`, and the `merge-drivers` codemod on `x upgrade`), because a list on one line is one line both sides changed. Keep the comment inside the list: it is what stops Biome joining the list back up.
- **Where the drivers do not run.** A hosted merge button and a clone that never ran setup use git's plain text merge, so the same files conflict there and nothing is lost. Merge locally. `x doctor` warns `X_MERGE_DRIVER_UNSET` on such a clone.
- **Migrations are not merged by this.** Two `x db gen` runs on two branches fork the chain: each snapshot lacks the other's table. Keep the earlier branch's migration, delete the later one's `.sql`, `.snapshot.json` and `.hash` if it was never applied, and regenerate it after the merge.

## CPU pressure

Memory alone does not bound a machine: at 14.3 of 15.9 GB reserved, an 8-core box sat at load 74 with 69 runnable tasks and `cpu some avg10` at 95.8 (`As of 2026-11-18`). So the queue's head also waits while the CPU is saturated **and** another heavy run is admitted:

| Signal | Waits at |
|---|---|
| PSI `cpu some avg10` (`/proc/pressure/cpu`) | 80% |
| without PSI: runnable tasks per core | 2 |

First come, first served still holds: only the head is judged. With nothing admitted one run always starts, whatever the pressure and wherever it comes from, and a head held back by CPU alone goes anyway after 5 minutes, so a long holder cannot starve the queue. The wait line then reads `waits for CPU … CPU pressure 96% (new runs wait at 80%)`; `x heavy status` prints the reading as `cpu:`, and `--json` carries `data.machine.cpu` and `data.cpuGate`. Off in CI, inside a test run, and with `ULTIMATE_HEAVY_CPU=0`. The figures and the reasoning: `packages/cli/src/heavy-pressure.ts`.

## Cores

Locally a run takes **at most 4 cores**, fewer when other sessions' runnable tasks already fill the machine, and never below 2. Test workers are capped per batch, so a run narrows and widens as the machine changes; `tsc` and `biome` get the cap as `GOMAXPROCS` and `RAYON_NUM_THREADS`. `--workers N` is taken as written. CI takes every core. A run held below its plan says `ran 2 at once (peak), planned 4`; `x test --json` carries it as `data.peakWorkers`.

## Neighbouring dev servers

`x dev` on a taken port refuses with `X_PORT_IN_USE`, naming the holder's pid and directory, and its fix names a pair of ports that is free when asked. `x doctor` reports a port held from **another checkout** as a warning, because nothing is wrong with this environment. A port held from this checkout, or by a process the OS will not name, stays a finding.

## Test service stacks

The `live` step prints one line on stderr for the stack it got:

| Line | Meaning |
|---|---|
| `services: started <project>` | this run started containers, and leaves them running for the next |
| `services: reused <project>` | they were already up, from this checkout |
| `services: shared <project> with <dir>` | another checkout of this app started them (same first commit, or same `origin`), or `ULTIMATE_TEST_SERVICES_SHARED=1` says the share is intended |

The compose project and its ports come from the app's name, so two different apps with one name land on the same stack. That is refused: the step warns with `X_TEST_SERVICES_UNAVAILABLE` naming the other directory, compose is not run, and the live suites run without the stack. Checkouts git cannot tie together count as different apps.

`x clean --services` stops this checkout's stack, keeps one another living checkout started, and lists every other test stack on the machine with its stop command, marking those whose checkout is gone. It stops nothing else.

## Switches

| Variable | Effect |
|---|---|
| `ULTIMATE_HEAVY_MEMORY=8g` | what the ledger admits; `0` turns it off |
| `ULTIMATE_HEAVY_CORES=6` | the local core ceiling |
| `ULTIMATE_HEAVY_CPU=0` | no waiting on CPU pressure; memory still applies |
| `ULTIMATE_HEAVY_DIR=<path>` | another ledger; also opts a test run in |
| `ULTIMATE_TEST_SLOTS=0` | test workers skip the ledger |
| `ULTIMATE_TEST_SERVICES_SHARED=1` | another app's test stack under this app's project name is shared on purpose |

Admission is off under `CI`, inside `bun test` (a fixture's `x test` must not queue behind real work), and on **Windows**, which has no `flock`: the core cap still applies there and `x heavy status` says why admission is off. A ledger that cannot work is reported as `X_HEAVY_LEDGER_UNAVAILABLE` and the command goes ahead; it never fails a run.

## Re-measuring a weight

Each figure sits in [`packages/cli/src/heavy-weights.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/heavy-weights.ts) beside its command. Re-read one on a clean snapshot:

```sh
GOMAXPROCS=4 bun run scripts/heavy-peak.ts -- node_modules/.bin/tsc -b --pretty false
```
