// How wide a parallel test run goes, decided in one place. `x test --workers`, `x verify
// --workers` and every parallel step of the gate read this — a second default would split the same
// suite two different ways, and the `--worker N` reproduction a shard failure prints would then
// name a shard the gate never ran.

// Bun ships no CPU-count or memory primitive: `cpus()` is the fallback when navigator cannot
// answer, and `totalmem()` is the only reader of the machine's RAM.
// why: Bun ships no CPU-count or total-memory primitive.
import { cpus, totalmem } from 'node:os';
import type { TestType } from '@ultimat3/testing';
import { TestBudgetInvalidError } from './verify-errors';

/** navigator first: it is the runtime's own answer, and it respects a container's CPU limit. */
export function availableCpus(): number {
  const hinted = typeof navigator === 'undefined' ? Number.NaN : navigator.hardwareConcurrency;
  return Math.max(1, Number.isFinite(hinted) && hinted > 0 ? Math.trunc(hinted) : cpus().length);
}

/**
 * The width of a default run is a MEMORY question first and a CPU question second, and the memory
 * it plans on is a BUDGET, not "whatever looks free".
 *
 * Until 22.7 the default was `ceil(cpus x 1.5)` held to 60% of `os.freemem()`. Both halves failed
 * on the machines Ultimate is for (8-16 GB, 2-8 cores, often two agents' gates at once):
 *
 * - `freemem()` is MemAvailable, which counts reclaimable page cache, so a box that had just built
 *   read as mostly free. Two gates planned independently, each took 14-18 workers, and on
 *   2026-09-27 a 45 GB box with no swap was OOM-killed with 36 `bun` processes holding ~40 GB.
 * - 1.5x the cores only paid when every worker was stalled on `--isolate` rebuilding a module
 *   registry per file. Without isolation (the default since 22.7, below) a worker is CPU-bound,
 *   and oversubscribing only multiplies memory.
 *
 * So: `min(GATE_BUDGET_CAP, GATE_BUDGET_SHARE x TOTAL memory)` — total, never free, so the plan
 * is the same on every run of the same machine — divided by `WORKER_BYTES`, clamped to 1..cpus.
 * `ULTIMATE_TEST_MEMORY_BUDGET` (e.g. `3g`) replaces the budget, `ULTIMATE_TEST_MAX_WORKERS` caps
 * the width, and an explicit `--workers` wins over both.
 */
export const GATE_BUDGET_CAP = 4 * 1024 * 1024 * 1024;

/** A quarter of the machine: an editor, a language server and another agent's gate need the rest. */
export const GATE_BUDGET_SHARE = 0.25;

/**
 * What one test worker is planned at. MEASURED, whole-tree RSS sampled every 200 ms, Bun 1.4.0,
 * 12-core box, `As of 2026-09-27`, NO isolation:
 *
 *   | corpus                                  | workers | batch | peak tree | tree / worker |
 *   |-----------------------------------------|---------|-------|-----------|---------------|
 *   | framework unit (1620 files)             | 4       | 24    | 3.61-3.78 GB | 0.90-0.95 GB |
 *   | notificado.co unit (768 files)          | 4       | 24    | 4.26-4.58 GB | 1.07-1.15 GB |
 *   | notificado.co unit (768 files)          | 4       | 48    | 4.35 GB   | 1.09 GB       |
 *   | notificado.co unit (768 files)          | 3       | 24    | 3.28-3.61 GB | 1.09-1.20 GB |
 *
 * The planning figure is what the TREE costs per worker at its peak — the `x` parent and Bun's
 * coordinator included — rounded up from the heaviest corpus, not the largest single worker:
 * workers do not all peak at the same instant. The floor of a worker is not the runner: a Bun
 * process that has booted ONE PGlite sits at 0.9-1.1 GB RSS even after `close()` and a full GC
 * (measured standalone), so a suite on the embedded database cannot plan below ~1 GB a worker.
 */
export const WORKER_BYTES = 1.25 * 1024 * 1024 * 1024;

/** The fewest workers `--workers` accepts and the fewest a default plans: one is a legal width. */
export const WORKER_FLOOR = 1;

/**
 * Files each ISOLATED worker is handed before its `bun test` process is thrown away and a fresh one
 * takes the next batch (`test-batches.ts`, which carries the measurement): under `--isolate` every
 * file re-evaluates the module graph and the heap grows per file, so the recycle point is what
 * makes the peak a function of the width rather than of the corpus.
 */
export const BATCH_FILES_PER_WORKER = 24;

/**
 * The recycle point WITHOUT isolation (the default since 22.7). A shared worker's peak is set by
 * its live PGlite, not by how many files it has run, and a batch boundary is pure cost: every
 * worker restarts, re-imports the app and re-boots its database, and the batch waits on its
 * slowest file. Measured on notificado.co's unit tier (768 files, 281 s of file time, 3 workers,
 * no isolation): 6 batches of 48/worker 150-172 s, ONE batch 92-94 s at 3.9 GB peak — the work
 * floor (281 s / 3). 256 a worker keeps a recycle point for a corpus far past that size.
 */
export const SHARED_BATCH_FILES_PER_WORKER = 256;

/**
 * The most `--workers` accepts, on either command. Not a default and not a memory rule — a sanity
 * bound: without one `--workers 5000` parsed, the run clamped only to the file count, and it
 * started one Bun process per test FILE. An explicit width below it is the caller's call.
 */
export const WORKER_CEILING = 64;

/** Replaces the budget: `3g`, `512m`, `4GiB`, or a byte count. */
export const MEMORY_BUDGET_ENV = 'ULTIMATE_TEST_MEMORY_BUDGET';

/** Caps the default width: a positive integer. */
export const MAX_WORKERS_ENV = 'ULTIMATE_TEST_MAX_WORKERS';

/** Bun ships no memory primitive; `totalmem()` is the machine's (or the cgroup-blind host's) RAM. */
export const totalMemory = (): number => totalmem();

type Env = Readonly<Record<string, string | undefined>>;

const UNITS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

/**
 * `3g` → 3 GiB. Binary units whatever the spelling, because the reader is sizing against RSS and
 * RSS is pages. `undefined` for anything else — the caller refuses it with the value in the cause,
 * rather than a typo silently meaning "the default".
 */
export const parseBytes = (raw: string): number | undefined => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
  if (match === null) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  if (!Object.hasOwn(UNITS, unit)) return undefined;
  const bytes = Math.floor(Number(match[1]) * (UNITS[unit] as number));
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
};

/** Why the width is what it is, in words a step line can print. */
export interface WorkerPlan {
  readonly workers: number;
  readonly budgetBytes: number;
  /** Which bound decided the width. */
  readonly boundBy: 'budget' | 'cpus' | 'max-workers';
  /** `4 workers (budget 4.0 GB)` — the step line's suffix. */
  readonly reason: string;
}

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/** The budget a default run plans on: the env override, or `min(4 GiB, 25% of total RAM)`. */
export function memoryBudget(total: number = totalMemory(), env: Env = Bun.env): number {
  const raw = env[MEMORY_BUDGET_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const bytes = parseBytes(raw);
    if (bytes === undefined) throw new TestBudgetInvalidError(MEMORY_BUDGET_ENV, raw);
    return bytes;
  }
  return Math.min(GATE_BUDGET_CAP, Math.floor(Math.max(0, total) * GATE_BUDGET_SHARE));
}

const maxWorkersOf = (env: Env): number | undefined => {
  const raw = env[MAX_WORKERS_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) throw new TestBudgetInvalidError(MAX_WORKERS_ENV, raw);
  return value;
};

/**
 * `clamp(1..cpus, floor(budget / WORKER_BYTES))`, then `ULTIMATE_TEST_MAX_WORKERS`. Never more
 * workers than cores, never fewer than one. The file-count clamp is `test-passes.ts`'s, because
 * only the caller knows the selection.
 */
export function workerPlan(
  cpus: number = availableCpus(),
  total: number = totalMemory(),
  env: Env = Bun.env,
): WorkerPlan {
  const budgetBytes = memoryBudget(total, env);
  const cores = Math.max(1, Math.trunc(cpus));
  const byBudget = Math.max(WORKER_FLOOR, Math.floor(budgetBytes / WORKER_BYTES));
  const cap = maxWorkersOf(env);
  let workers = Math.min(cores, byBudget, WORKER_CEILING);
  let boundBy: WorkerPlan['boundBy'] = byBudget <= cores ? 'budget' : 'cpus';
  if (cap !== undefined && cap < workers) {
    workers = cap;
    boundBy = 'max-workers';
  }
  const noun = workers === 1 ? 'worker' : 'workers';
  const why =
    boundBy === 'max-workers'
      ? `${MAX_WORKERS_ENV}=${String(cap)}`
      : boundBy === 'cpus'
        ? `${String(cores)} cores, budget ${gb(budgetBytes)} GB`
        : `budget ${gb(budgetBytes)} GB`;
  return { workers, budgetBytes, boundBy, reason: `${String(workers)} ${noun} (${why})` };
}

/** The width alone — `workerPlan(...).workers`. */
export const defaultWorkers = (
  cpus: number = availableCpus(),
  total: number = totalMemory(),
  env: Env = Bun.env,
): number => workerPlan(cpus, total, env).workers;

/**
 * The width for a parallel suite that SHARES the machine — `x verify` runs the static steps beside
 * `live`, `job`, `e2e` and `eval` (`verify-run.ts`). The default is already one worker per core at
 * most, so this is the same plan; it stays a name of its own so the overlap window has one reader.
 */
export const sharedWorkers = (
  cpus: number = availableCpus(),
  total: number = totalMemory(),
  env: Env = Bun.env,
): number => defaultWorkers(cpus, total, env);

/**
 * Which types run across worker processes, and why the other two cannot.
 *
 * Parallel is safe when the only thing a test file shares with another file is the database, and
 * the database is per worker by construction (`ULTIMATE_TEST_WORKER` → one clone of the migrated
 * template, `@ultimat3/testing`'s `acquireWorkerDatabase`). Every other process-global in this
 * framework — the permission set, the roles, the entity/action/query registries, the error-code
 * titles, the fixture bag — is handled by `--isolate` giving each FILE its own module registry.
 *
 * | Type | Why |
 * |---|---|
 * | `live` | **serial.** A logical replication slot and a publication are named at the Postgres
 * CLUSTER level, not inside a database, and this repo's own feed tests hard-code
 * `x_live_slot` / `x_live_pub` against `TEST_REPLICATION_URL` — the one server, never a per-worker
 * clone. Two workers would race `pg_create_logical_replication_slot` and the loser's failure would
 * read as a flake. A per-worker database does not isolate a cluster-wide object |
 * | `e2e` | **serial.** It runs against the *built output*: one `dist/`, one service-worker
 * registration, one browser profile. There is nothing per-worker to hand it, and the type is
 * seconds at most, so a split would buy a race and no time |
 *
 * The two are named here rather than tested for, because "can this type be sharded?" is a design
 * fact about the type, not something a run can discover about itself.
 */
export const SERIAL_TYPES: readonly TestType[] = ['live', 'e2e'];
