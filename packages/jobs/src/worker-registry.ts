// One worker's row in the registry: announced when it starts, renewed on its own interval —
// in full when the jobs it holds or its drain changed, narrowly otherwise — and forgotten when it
// stops. A KILLED worker's row expires `ttlMs` after its last heartbeat: the lease rule
// (`leases.ts`), applied to "who is working".

import type { Clock } from '@ultimat3/core';
import { logger, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import { DEFAULT_QUEUE, type JobDriver } from './driver';
import { MAX_WORKER_IN_FLIGHT } from './introspection';
import { registeredJobs } from './job';
import { type IntervalScheduler, startRenewalTimer } from './renewal-timer';

export interface WorkerRegistryOptions {
  readonly driver: JobDriver;
  readonly workerId: string;
  /** Where this worker runs. A pod name under an orchestrator; `HOSTNAME` when nothing says. */
  readonly host: string | undefined;
  /** The build this process runs, stamped on its row. Absent: the row names none. */
  readonly build?: string | undefined;
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
  /**
   * The worker stopped claiming and only finishes what it holds: every announce from now on says
   * `draining`, and one goes out NOW rather than at the next heartbeat (a third of the visibility
   * window later) — the row is what a queue-demand autoscaler leaves held jobs out by. Idempotent in
   * effect (the row keeps its first `draining_at`). Never rejects.
   */
  draining(): Promise<void>;
  /** Stop announcing and hand the row back. Never rejects. */
  stop(): Promise<void>;
}

/** Announces at once, so a worker is visible the moment it serves — not one interval later. */
export function startWorkerRegistry(options: WorkerRegistryOptions): WorkerRegistration {
  const registry = options.driver.introspect;
  // A driver with no introspection has no registry to appear in.
  if (registry === undefined) {
    return { draining: () => Promise.resolve(), stop: () => Promise.resolve() };
  }
  const startedAt = nowMs(options.clock);
  const host = options.host ?? Bun.env['HOSTNAME'] ?? 'unknown';
  /** Sticky for this registration: a worker that started again registers afresh. */
  let draining = false;

  /**
   * Every announce still on the wire. `stop()` waits them out before it forgets: the row an
   * announce writes after the forget is a stopped worker listed as serving for a whole TTL.
   */
  const announcing = new Set<Promise<void>>();

  /**
   * What the last full announce that LANDED said — the held ids and the drain flag, the only
   * columns that move. `undefined` makes the next heartbeat a full one: at the start, after a
   * failure, and while a full one is on the wire.
   */
  let announced: string | undefined;

  const full = async (inFlight: readonly string[], snapshot: string): Promise<void> => {
    announced = undefined;
    await registry.announceWorker(
      {
        id: options.workerId,
        host,
        startedAt,
        queues: options.queues,
        concurrency: options.concurrency,
        inFlight,
        ...(draining ? { draining: true } : {}),
        ...(options.build === undefined ? {} : { build: options.build }),
      },
      options.ttlMs,
    );
    announced = snapshot;
  };

  const send = async (): Promise<void> => {
    const inFlight = options.inFlight().slice(0, MAX_WORKER_IN_FLIGHT);
    const snapshot = `${draining ? 'draining' : 'serving'}\u0000${inFlight.join('\u0000')}`;
    try {
      // Nothing a reader uses moved: push the expiry and nothing else (`renewWorker`). A row that
      // is gone answers `false`, and the full announce below recreates it.
      const narrow = snapshot === announced && registry.renewWorker !== undefined;
      if (narrow && (await registry.renewWorker?.(options.workerId, options.ttlMs))) return;
      await full(inFlight, snapshot);
    } catch (error) {
      // The registry is what an operator READS; a failed heartbeat must not stop a worker working.
      // Enough of them in a row and the row lapses, which is the honest thing for it to say.
      announced = undefined;
      logger.warn('jobs.worker.announce-failed', {
        workerId: options.workerId,
        error: renderThrowable(error),
      });
    }
  };

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
    draining() {
      draining = true;
      // Not after `stop()`: the row is being handed back, and an announce landing then relists it.
      return timer.stopped() ? Promise.resolve() : announce();
    },
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
 * `enqueue({ queue })` may still land work there — `jobs.queues` exists to name exactly those — and
 * an idle pass is one statement however many queues it covers. Said once, at boot, because it is
 * almost always a config leftover (`x new` configured `['<app>-default']` until 31.0.0).
 * `DEFAULT_QUEUE` is never one: it is where every `job()` naming no queue lands and what a worker
 * with no list serves, so an app with no such job yet logged this on every boot of every pod.
 */
export function reportUnregisteredQueues(workerId: string, queues: readonly string[]): void {
  const named = new Set(registeredJobs().map((handle) => handle.queue));
  const unnamed = queues.filter((queue) => queue !== DEFAULT_QUEUE && !named.has(queue));
  if (unnamed.length === 0) return;
  logger.info('jobs.worker.queue-unregistered', {
    workerId,
    queues: unnamed,
    fix: 'remove the queue from jobs.queues in app.config.ts, or set queue on the job that should run there — x jobs list --json shows what each queue holds',
  });
}
