// How wide a parallel test run goes, decided in one place. `x test --workers`, `x verify
// --workers` and every parallel step of the gate read this — a second default would split the same
// suite two different ways, and the `--worker N` reproduction a shard failure prints would then
// name a shard the gate never ran.

// Bun ships no CPU-count or free-memory primitive: `cpus()` is the fallback when navigator cannot
// answer, and `freemem()` is the only reader of available memory.
import { cpus, freemem } from 'node:os';
import type { TestType } from '@ultimat3/testing';

/** navigator first: it is the runtime's own answer, and it respects a container's CPU limit. */
export function availableCpus(): number {
  const hinted = typeof navigator === 'undefined' ? Number.NaN : navigator.hardwareConcurrency;
  return Math.max(1, Number.isFinite(hinted) && hinted > 0 ? Math.trunc(hinted) : cpus().length);
}

/**
 * Deliberately MORE workers than cores, bounded by memory rather than by a fixed count.
 *
 * `cpus - 1` is the intuitive default and it was measured to be worthless exactly where it has to
 * pay off. On a 4-core `ubuntu-latest` — the runner this repo commits to — the `unit` step:
 *
 *   | workers | wall  |
 *   |---------|-------|
 *   | serial  | 43.2s |
 *   | 3 (cpus - 1) | 44.8s |   <- the old default: slower than not sharding at all
 *   | 4       | 41.6s |
 *   | 6       | 34.8s |
 *
 * Three workers on four cores loses to serial because sharding is not free — each worker reloads
 * the framework's module graph — and three of them cannot cover that cost. The reason more-than-
 * cores wins is that a test worker is not CPU-bound end to end: it spends real time on module
 * resolution, on `--isolate` rebuilding a registry per file, and on waiting for its database.
 * Oversubscribing fills those stalls.
 *
 * The bound is memory, not cores. A worker is a whole Bun process with the framework's module
 * graph loaded and — in the typed suites — its own cloned Postgres or an in-process PGlite. Until
 * 22.3 that was a FIXED ceiling of 8, which held a 12-core box to 8 workers with 30 GB free: the
 * notificado.co `unit` step (381 files) sat at 51s on 8 workers against a 90s gate budget. The
 * ceiling is now what the machine can actually hold — `os.freemem()` (MemAvailable on Linux, so
 * reclaimable page cache counts as free) divided by `WORKER_BYTES` — which still binds on a small
 * CI runner and on a loaded laptop, the two places an unbounded count would swap.
 *
 * The floor of 2 keeps a 1-core box sharding rather than silently reverting to serial.
 */
export const WORKER_OVERSUBSCRIBE = 1.5;

/** The floor the paragraph above names: a 1-core box shards rather than reverting to serial. */
export const WORKER_FLOOR = 2;

/**
 * What one test worker is budgeted at, for the memory bound above. MEASURED — peak RSS of the whole
 * `x test unit` process tree on the notificado.co corpus (381 files, PGlite per worker), 12-core
 * box, `As of 2026-09-25`:
 *
 *   | workers | peak tree RSS |
 *   |---------|---------------|
 *   | 8       | 20.7 GB       |
 *   | 12      | 22.5 GB       |
 *   | 16      | 24.3 GB       |
 *
 * The MARGINAL worker costs ~0.45 GB (the slope); the ~17 GB intercept is the corpus itself —
 * every file's module graph and database, retained per worker — and does not shrink with fewer
 * workers, so it is not this bound's to budget. The constant is the slope doubled and rounded to a
 * power of two, because free memory is read once, before a single worker has started.
 */
export const WORKER_BYTES = 1024 * 1024 * 1024;

/**
 * The most `--workers` accepts, on either command. Not a default and not a memory rule — a sanity
 * bound: without one `--workers 5000` parsed, the run clamped only to the file count, and it
 * started one Bun process per test FILE. An explicit width below it is the caller's call.
 */
export const WORKER_CEILING = 64;

/** Bun ships no memory primitive; `freemem()` is libuv's MemAvailable on Linux. */
export const availableMemory = (): number => freemem();

/**
 * `ceil(cpus x 1.5)`, held to what free memory can carry and never below the floor. The file-count
 * clamp is `test-passes.ts`'s (every pass is clamped to its own file list), because only the
 * caller knows the selection.
 */
export const defaultWorkers = (
  available: number = availableCpus(),
  freeBytes: number = availableMemory(),
): number => {
  const byCpu = Math.ceil(available * WORKER_OVERSUBSCRIBE);
  const byMemory = Math.floor(freeBytes / WORKER_BYTES);
  return Math.max(WORKER_FLOOR, Math.min(byCpu, byMemory, WORKER_CEILING));
};

/**
 * The width for a parallel suite that SHARES the machine — `x verify` runs the static steps beside
 * `live`, `job`, `e2e` and `eval` (`verify-run.ts`), and each of those scans is a CPU-bound process
 * of its own. `defaultWorkers()`' oversubscription fills a worker's own stalls when nothing else
 * wants the cores; beside six other processes it only multiplies the contention. Measured on
 * notificado.co, 8 vCPU (#537): at 1.5x, `errors` went 1.8s alone → 7.9s in the gate and
 * `boundaries` 2.3s → 9.7s. So: one worker per core, still held to what memory can carry.
 */
export const sharedWorkers = (
  available: number = availableCpus(),
  freeBytes: number = availableMemory(),
): number => Math.min(defaultWorkers(available, freeBytes), Math.max(WORKER_FLOOR, available));

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
