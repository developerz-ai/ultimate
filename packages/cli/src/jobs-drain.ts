// `x jobs drain`: moving in-flight work from one queue driver onto another. Its own file because
// it is the only command here that WRITES to two drivers at once, and the ordering rule that makes
// that safe — lease, copy steps, enqueue, then ack — has to be readable in one screen.

import { uuid } from '@ultimat3/core';
import type { JobDriver, JobRecord, JobState } from '@ultimat3/jobs';
import { inspectJobList } from '@ultimat3/jobs';
import type { Finding } from './output';
import { findingFrom } from './output';

/** `running` is deliberately excluded: a job a worker is mid-execution on is not "pending". */
const PENDING_STATES: readonly JobState[] = ['ready', 'delayed', 'suspended'];

/**
 * The lease has to outlive the WHOLE transfer loop, not one record: the batch is claimed up
 * front, and a lease expiring mid-drain would hand a half-transferred job back to a source
 * worker. The snapshot is bounded by the drivers' own 100-row-per-state list cap, so this is a
 * ceiling over a few hundred sequential enqueues rather than a guess about one.
 */
const DRAIN_LEASE_MS = 300_000;

const NO_LEASE = 'no lease could be taken — not yet due, or a worker is already running it';

export interface DrainFailure {
  readonly id: string;
  readonly name: string;
  readonly finding: Finding;
}

/** A candidate the drain deliberately left alone, because it could not prove it owned the job. */
export interface DrainSkip {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly state: JobState;
  readonly reason: string;
}

export interface DrainOutcome {
  readonly from: string;
  readonly to: string;
  readonly dryRun: boolean;
  readonly candidates: readonly JobRecord[];
  readonly moved: readonly JobRecord[];
  readonly skipped: readonly DrainSkip[];
  readonly failures: readonly DrainFailure[];
}

/**
 * The lease IS the proof of ownership. `ack()` takes only a job id, so a drain that ack'd rows
 * off a snapshot could acknowledge a job a source worker claimed and is executing right now —
 * the target would then run a duplicate of a job still in flight. One batch claim over the
 * candidates' own queues; whatever comes back is the drain's to move, and everything else is
 * left alone. `queues` is always explicit because the pg driver reads an empty list as
 * `['default']` rather than as "every queue".
 */
function leaseCandidates(
  source: JobDriver,
  candidates: readonly JobRecord[],
): Promise<readonly JobRecord[]> {
  if (candidates.length === 0) return Promise.resolve([]);
  return source.claim({
    queues: [...new Set(candidates.map((record) => record.queue))],
    limit: candidates.length,
    visibilityTimeoutMs: DRAIN_LEASE_MS,
    workerId: `x-jobs-drain:${uuid()}`,
  });
}

/** Steps carry their own `runId`, so a copy lands under the same key the target job resumes on. */
async function copySteps(source: JobDriver, target: JobDriver, runId: string): Promise<void> {
  for (const record of await source.steps.list(runId)) await target.steps.put(record);
}

/**
 * Hand a leased job back exactly as the drain found it. `countsAsAttempt: false` is the point:
 * a transfer that failed is not a failed attempt, and burning one per `x jobs drain` retry would
 * dead-letter a job nobody ever ran.
 *
 * It returns to `ready`, which is what "as the drain found it" means — the drain leased a ready
 * job and could not move it. It used to land in `suspended`, not by intent but because
 * `countsAsAttempt: false` was the only bit the drivers had and `step.sleep` had claimed it;
 * `NackOptions.park` now carries the suspension, so the two callers no longer share one meaning.
 */
async function releaseLease(source: JobDriver, id: string): Promise<void> {
  try {
    await source.nack(id, { delayMs: 0, countsAsAttempt: false });
  } catch {
    // The lease expires on its own. Masking the transfer's real error with this one helps nobody.
  }
}

const toSkip = (record: JobRecord): DrainSkip => ({
  id: record.id,
  name: record.name,
  queue: record.queue,
  state: record.state,
  reason: NO_LEASE,
});

/**
 * Move every pending job the drain can take a lease on from `source` onto `target`. `--dry-run`
 * reports the candidate list, takes no lease and enqueues nothing. Per-record try/catch, not a
 * batch operation: one record that cannot enqueue on the target (a redis/nats stub, a transient
 * error) must not stop the rest from moving, and the caller reports each failure on its own.
 */
export async function drainJobs(
  source: JobDriver,
  target: JobDriver,
  dryRun: boolean,
): Promise<DrainOutcome> {
  const lists = await Promise.all(PENDING_STATES.map((state) => inspectJobList(source, { state })));
  const candidates = lists.flat();
  const base = { from: source.name, to: target.name, candidates };
  if (dryRun) return { ...base, dryRun: true, moved: [], skipped: [], failures: [] };

  const leased = await leaseCandidates(source, candidates);
  const held = new Set(leased.map((record) => record.id));
  const found = new Map(candidates.map((record) => [record.id, record]));
  const skipped = candidates.filter((record) => !held.has(record.id)).map(toSkip);

  const moved: JobRecord[] = [];
  const failures: DrainFailure[] = [];
  for (const record of leased) {
    let enqueued = false;
    try {
      // Steps BEFORE the job: a worker on the target must never be able to claim a run whose
      // checkpoint has not landed, or it repeats completed steps or loses them outright.
      await copySteps(source, target, record.runId);
      await target.enqueue({
        name: record.name,
        queue: record.queue,
        input: record.input,
        idempotencyKey: record.idempotencyKey,
        runId: record.runId,
        maxAttempts: record.maxAttempts,
        runAt: record.runAt,
        ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
      });
      enqueued = true;
      // Only now is the ack the drain's to make: the lease proves no source worker holds this
      // job, and the target already has both the row and its steps. A crash between the two
      // leaves the job live on both drivers, where `idempotencyKey` dedupes it.
      await source.ack(record.id);
      // Report the row as the drain FOUND it: `claim()` returns it mid-lease (`running`, one
      // attempt higher), a state nothing on either driver is in once this returns.
      moved.push(found.get(record.id) ?? record);
    } catch (error) {
      // A failed enqueue left nothing on the target, so the lease goes back. A failed ack did
      // not: the job is already live there, and releasing it would race the target's worker.
      if (!enqueued) await releaseLease(source, record.id);
      failures.push({ id: record.id, name: record.name, finding: findingFrom(error) });
    }
  }
  return { ...base, dryRun: false, moved, skipped, failures };
}
