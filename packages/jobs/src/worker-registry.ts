// One worker's row in the registry: announced when it starts, re-announced on its heartbeat
// interval with the jobs it holds, and forgotten when it stops. A worker that is KILLED announces
// nothing, and its row expires `ttlMs` after its last heartbeat — the lease rule (`leases.ts`),
// applied to "who is working".

import type { Clock } from '@ultimat3/core';
import { logger, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import type { JobDriver } from './driver';
import { MAX_WORKER_IN_FLIGHT } from './introspection';
import { registeredJobs } from './job';
import { type IntervalScheduler, startRenewalTimer } from './renewal-timer';

export interface WorkerRegistryOptions {
  readonly driver: JobDriver;
  readonly workerId: string;
  /** Where this worker runs. A pod name under an orchestrator; `HOSTNAME` when nothing says. */
  readonly host: string | undefined;
  readonly queues: readonly string[];
  /** Slots across every queue served. */
  readonly concurrency: number;
  /** The job ids held right now. */
  readonly inFlight: () => readonly string[];
  readonly ttlMs: number;
  readonly intervalMs: number;
  readonly clock?: Clock;
  /** What every renewal runs on (`renewal-timer.ts`). Default: a real, unrefed interval. */
  readonly schedule?: IntervalScheduler;
}

export interface WorkerRegistration {
  /** Stop announcing and hand the row back. Never rejects. */
  stop(): Promise<void>;
}

/** Announces at once, so a worker is visible the moment it serves — not one interval later. */
export function startWorkerRegistry(options: WorkerRegistryOptions): WorkerRegistration {
  const registry = options.driver.introspect;
  // A driver with no introspection has no registry to appear in.
  if (registry === undefined) return { stop: () => Promise.resolve() };
  const startedAt = nowMs(options.clock);
  const host = options.host ?? Bun.env['HOSTNAME'] ?? 'unknown';

  /**
   * Every announce still on the wire. `stop()` waits them out before it forgets: the row an
   * announce writes after the forget is a stopped worker listed as serving for a whole TTL.
   */
  const announcing = new Set<Promise<void>>();

  const send = (): Promise<void> =>
    registry
      .announceWorker(
        {
          id: options.workerId,
          host,
          startedAt,
          queues: options.queues,
          concurrency: options.concurrency,
          inFlight: options.inFlight().slice(0, MAX_WORKER_IN_FLIGHT),
        },
        options.ttlMs,
      )
      // The registry is what an operator READS; a failed heartbeat must not stop a worker working.
      // Enough of them in a row and the row lapses, which is the honest thing for it to say.
      .catch((error: unknown) => {
        logger.warn('jobs.worker.announce-failed', {
          workerId: options.workerId,
          error: renderThrowable(error),
        });
      });

  const announce = (): Promise<void> => {
    const sent = send().finally(() => announcing.delete(sent));
    announcing.add(sent);
    return sent;
  };

  // Not awaited — a worker serves whether or not its row has landed — and held in `announcing`.
  void announce();
  const timer = startRenewalTimer(
    options.intervalMs,
    () => {
      if (!timer.stopped()) return announce();
    },
    options.schedule,
  );

  return {
    async stop() {
      timer.stop();
      // `send` never rejects (it logs), so neither does this.
      await Promise.all(announcing);
      await registry.forgetWorker(options.workerId).catch((error: unknown) => {
        logger.warn('jobs.worker.forget-failed', {
          workerId: options.workerId,
          error: renderThrowable(error),
        });
      });
    },
  };
}

/**
 * A queue this worker polls that NO registered job names. Not refused: a per-call
 * `enqueue({ queue })` may still land work there, and an idle pass is one statement however many
 * queues it covers. Said once, at boot, because it is almost always a config leftover — `x new`
 * configures `['<app>-default']` while a `job()` naming no queue lands on `default`.
 */
export function reportUnregisteredQueues(workerId: string, queues: readonly string[]): void {
  const named = new Set(registeredJobs().map((handle) => handle.queue));
  const unnamed = queues.filter((queue) => !named.has(queue));
  if (unnamed.length === 0) return;
  logger.info('jobs.worker.queue-unregistered', {
    workerId,
    queues: unnamed,
    fix: 'remove the queue from jobs.queues in app.config.ts, or set queue on the job that should run there — x jobs list --json shows what each queue holds',
  });
}
