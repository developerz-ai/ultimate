// How wide a parallel test run goes, decided in one place. `x test --workers`, `x verify
// --workers` and every parallel step of the gate read this — a second default would split the same
// suite two different ways, and the `--worker N` reproduction a shard failure prints would then
// name a shard the gate never ran.

// Bun ships no CPU-count primitive; `cpus()` is the fallback when navigator cannot answer.
import { cpus } from 'node:os';
import type { TestType } from '@ultimat3/testing';

/** navigator first: it is the runtime's own answer, and it respects a container's CPU limit. */
export function availableCpus(): number {
  const hinted = typeof navigator === 'undefined' ? Number.NaN : navigator.hardwareConcurrency;
  return Math.max(1, Number.isFinite(hinted) && hinted > 0 ? Math.trunc(hinted) : cpus().length);
}

/**
 * Deliberately MORE workers than cores, with a ceiling.
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
 * The ceiling is memory, not cores. A worker is a whole Bun process with the framework's module
 * graph loaded and — in the typed suites — its own cloned Postgres or an in-process PGlite, so
 * width costs hundreds of MB per step. It binds on a developer's 12- or 32-core machine, which is
 * exactly where an unbounded count would swap.
 *
 * The floor of 2 keeps a 1-core box sharding rather than silently reverting to serial.
 */
export const WORKER_CEILING = 8;

/** Oversubscription factor. See the table above — it is measured, not chosen for roundness. */
export const WORKER_OVERSUBSCRIBE = 1.5;

/** The floor the paragraph above names: a 1-core box shards rather than reverting to serial. */
export const WORKER_FLOOR = 2;

export const defaultWorkers = (available: number = availableCpus()): number =>
  Math.max(WORKER_FLOOR, Math.min(WORKER_CEILING, Math.round(available * WORKER_OVERSUBSCRIBE)));

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
