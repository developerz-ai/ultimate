// One claimed job, wired: its lease heartbeat, the fleet slot it holds, the signal the run is
// cancelled by, and the span it is executed under — all started together and handed back in one
// `finally`. Apart from `worker.ts` because that file's job is the claim loop and the drain; this
// one is everything that has to be true for the duration of a single run.

import type { Clock, Ctx } from '@ultimat3/core';
import { parseTraceparent, withSpan } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from './driver';
import { JobSlotLostError } from './errors';
import type { JobExecution } from './execute';
import { executeJob } from './execute';
import { startLeaseHeartbeat } from './heartbeat';
import { getJob } from './job';
import { createRunSignal } from './run-signal';
import type { EventLookup } from './steps';
import type { FleetSlots } from './worker-fleet-slots';

export interface RunClaimedOptions {
  readonly driver: JobDriver;
  readonly claimed: ClaimedJob;
  /** Supplies the ambient Ctx for this run; the app wires ALS + tenant here. */
  readonly context: () => Ctx;
  readonly fleetSlots: FleetSlots;
  readonly workerId: string;
  readonly visibilityTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly clock?: Clock;
  readonly events?: EventLookup;
}

/** A name this deploy does not know, parked rather than failed — almost always a deploy skew. */
function unknownJob(claimed: ClaimedJob): JobExecution {
  return {
    outcome: 'suspended',
    jobId: claimed.id,
    job: claimed.name,
    attempt: claimed.attempt,
    durationMs: 0,
    error: `no job registered as "${claimed.name}"`,
    steps: [],
    replayed: [],
  };
}

/** Run one claimed job under its lease, its slot and its span, and settle it with the driver. */
export async function runClaimedJob(options: RunClaimedOptions): Promise<JobExecution> {
  const { claimed, driver, fleetSlots, workerId, visibilityTimeoutMs } = options;
  const handle = getJob(claimed.name);
  if (handle === undefined) {
    // Park it, do not burn attempts: the job may well be registered by the pod next to this one.
    await driver.nack(claimed.id, {
      delayMs: 30_000,
      error: `no job registered as "${claimed.name}"`,
      countsAsAttempt: false,
    });
    return unknownJob(claimed);
  }

  // Read BEFORE the timers start. `context()` is the app's own function and it can throw; started
  // first, a heartbeat interval and a slot renewal were left running for a job that never ran,
  // with nothing left holding a reference to stop them.
  const base = options.context();

  // The lease, kept alive and NOT kept quiet: a renewal that stops landing means the queue hands
  // this job to another worker while this one is still running it, and `.catch(() => undefined)`
  // made that — the one failure a queue cannot recover from on its own — indistinguishable from a
  // healthy run.
  const heartbeat = startLeaseHeartbeat({
    driver,
    claimed,
    visibilityTimeoutMs,
    intervalMs: options.heartbeatIntervalMs,
    workerId,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  // The caller's context plus this lease's cancellation, so a job cancelled from outside — or one
  // this worker lost the lease on — stops at the next renewal. `steps.ts` refuses every write past
  // the signal, which is what unwinds a body that never reads it. Composed through a controller
  // this worker owns rather than `AbortSignal.any`, for two reasons: it is handed BACK when the run
  // settles (an app whose `context()` carries a process-lifetime signal was accumulating one
  // composite per job), and the worker can abort it itself — which is the only way a fleet slot
  // taken by somebody else reaches the body running under it.
  const runSignal = createRunSignal([base.signal, heartbeat.signal]);
  const ctx: Ctx = { ...base, signal: runSignal.signal };

  // The fleet slot this job already holds, kept alive for as long as the lease is and stopped in
  // the same `finally`: one clock for "this worker still owns the job" and "this worker still owns
  // the slot" is one fewer way for them to disagree. A renewal answering "not yours" means another
  // worker is already running this job under a cap of one, so it CANCELS — discarding that boolean
  // made `job.concurrency` a number the framework prints and does not hold.
  const stopSlotRenewal = fleetSlots.startRenewal(claimed.id, (slot) => {
    runSignal.abort(
      new JobSlotLostError({ job: claimed.name, jobId: claimed.id, slot: slot.slot }),
    );
  });

  // The job's span is a CHILD of the request that queued it when the row carries a trace. That
  // link is what `04-jobs.md` promised and no column existed to hold: without it a checkout's
  // `chargeCard` opens a fresh root two seconds later with nothing pointing back.
  const parent = parseTraceparent(claimed.traceparent);

  try {
    return await withSpan(
      `job.${handle.name}`,
      () =>
        executeJob({
          driver,
          claimed,
          handle,
          ctx,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.events === undefined ? {} : { events: options.events }),
        }),
      {
        ...(parent === undefined ? {} : { parent }),
        attributes: {
          'job.name': handle.name,
          'job.id': claimed.id,
          'job.attempt': claimed.attempt,
          ...(claimed.enqueuedBy === undefined ? {} : { 'job.enqueued_by': claimed.enqueuedBy }),
        },
      },
    );
  } finally {
    stopSlotRenewal();
    heartbeat.stop();
    // Nothing of the caller's is held past the run: `dispose` is what makes the composition above
    // reversible, and it is the whole reason this is not `AbortSignal.any`.
    runSignal.dispose();
  }
}
