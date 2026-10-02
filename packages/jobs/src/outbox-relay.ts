// The outbox relay: the loop that turns a COMMITTED `x_outbox` row into a queued job. Split from
// `outbox.ts` — that file owns the store seam, the staging and the facade; this one owns a timer, a
// pass and the process drain around them.
//
// At-least-once by construction: publish, THEN mark published. A crash between the two re-publishes,
// which the idempotency key collapses — the opposite order would lose jobs.

import { assert, logger, onShutdown, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import { createDrainBudget, settleAllBy } from './drain-wait';
import { onStaged, signalEnqueued } from './enqueue-signal';
import { createIdleBackoff } from './idle-backoff';
import type { OutboxDeps } from './outbox';

export interface RelayOptions extends OutboxDeps {
  readonly batchSize?: number;
  /** The gap between passes while rows are being published. Default 200 ms. */
  readonly intervalMs?: number;
  /**
   * The longest gap once passes come back empty — the relay doubles its wait from `intervalMs` up
   * to this. Default `IDLE_POLL_CEILING_MS` (2 s), or `WOKEN_IDLE_POLL_CEILING_MS` (5 s) while
   * `startQueueWake` has a proven `LISTEN`. It is the most a row another process committed waits
   * for an idle relay when no notification reaches it.
   */
  readonly idlePollMaxMs?: number;
  /**
   * Register the two shutdown hooks. `false` only for a relay whose caller drives the teardown
   * itself — a test, or a script that owns the process. The same knob `WorkerOptions` carries, and
   * the default is the same: a loop nobody stops on SIGTERM keeps leasing rows this pod will never
   * publish.
   */
  readonly drainOnShutdown?: boolean;
}

export interface OutboxRelay {
  /** One pass. Returns how many rows were published. Call it directly in tests. */
  tick(): Promise<number>;
  start(): void;
  /**
   * Stop polling and WAIT OUT the pass in flight, the way `worker.stop()` waits out its rounds and
   * `scheduler.stop()` its dispatch. A pass is a publish followed by a `markPublished`, and a
   * caller that returned between the two closed the database under the row it was about to mark:
   * re-published next boot at best, a rejection against a closed pool at worst.
   */
  stop(deadlineAt?: number): Promise<void>;
  pending(): Promise<number>;
  /** The gap the loop will wait before its next pass — the floor, or wherever idling has taken it. */
  pollDelayMs(): number;
}

/**
 * At-least-once by construction: publish, THEN mark published. A crash between the two
 * re-publishes, which the idempotency key collapses — the opposite order would lose jobs.
 */
export function createOutboxRelay(options: RelayOptions): OutboxRelay {
  const batchSize = options.batchSize ?? 100;
  const intervalMs = options.intervalMs ?? 200;
  // Refused, never clamped — `worker-options.ts` carries the reason. `setInterval(fn, NaN)` reads
  // the delay as 0 and `claim(NaN)` slices `(0, NaN)`: a relay that spins and publishes nothing.
  assert(
    Number.isSafeInteger(batchSize) && batchSize >= 1,
    `createOutboxRelay batchSize is ${String(batchSize)} — a batch is a whole number of staged rows, at least one`,
    'pass a finite batchSize to createOutboxRelay(...), or omit it for the default 100',
  );
  assert(
    Number.isFinite(intervalMs) && intervalMs >= 0,
    `createOutboxRelay intervalMs is ${String(intervalMs)}, which a timer reads as 0 — the relay would spin, not poll`,
    'pass a finite intervalMs to createOutboxRelay(...), or omit it for the default 200',
  );
  const backoff = createIdleBackoff({
    subject: 'createOutboxRelay',
    floorMs: intervalMs,
    ...(options.idlePollMaxMs === undefined ? {} : { ceilingMs: options.idlePollMaxMs }),
  });
  /** What the next `arm()` waits. */
  let delayMs = intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let running = false;
  /** The pass in flight, so `stop()` joins it instead of returning underneath it. */
  let pass: Promise<void> | undefined;
  /** `'draining'` is the state in which a timer that somehow fires still claims nothing. */
  let state: 'idle' | 'running' | 'draining' | 'stopped' = 'idle';
  let releaseShutdownHooks: (() => void)[] = [];
  let stopping: Promise<void> | undefined;
  /** A committed row was announced while a pass was in flight: one more, right behind it. */
  let again = false;
  /**
   * The deadline the teardown waits under: unbound for a manual `stop()`, bound the moment a
   * shutdown lands — LATE, when it lands on a teardown already in flight. `stop()` memoises its
   * teardown, and until 2026-10-01 the one a SIGTERM joined kept the `undefined` a manual stop
   * had started it with: core abandoned the hook at the deadline and the relay sat behind a
   * publish that never returned. The shape `worker.ts` holds, for the same reason.
   */
  let budget = createDrainBudget();

  const tick = async (): Promise<number> => {
    const batch = await options.store.claim(batchSize);
    let published = 0;
    for (const record of batch) {
      try {
        await options.driver.enqueue({
          // The ids the staging enqueue ANSWERED. Published under them, a repeat of this publish
          // — a crash before the mark below — meets the job this one made rather than adding one.
          id: record.id,
          runId: record.runId,
          name: record.job,
          queue: record.queue,
          input: record.input,
          idempotencyKey: record.idempotencyKey,
          maxAttempts: record.maxAttempts,
          runAt: record.runAt,
          ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
          ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
          ...(record.enqueuedBy === undefined ? {} : { enqueuedBy: record.enqueuedBy }),
        });
        // The claim's own token goes back with the mark. Without it a relay whose lease lapsed
        // mid-stall retires a row the relay that reclaimed it has not published yet — the row is
        // gone and nothing publishes it.
        await options.store.markPublished(record.id, nowMs(options.clock), record.claimedBy);
        published += 1;
      } catch (error) {
        // STOP the batch. `claim()` returns rows in `staged_at` order and the loop used to log
        // and continue, which published every LATER row past the one that failed — so an app
        // that stages `createInvoice` then `chargeCard` in one transaction could have the charge
        // run first. The row stays unpublished and the next tick starts again from it; a
        // permanently poisoned row wedges its queue, which is visible in `pending()` and is the
        // correct trade against silently reordering committed work.
        logger.warn('jobs.outbox.publish-failed', {
          job: record.job,
          id: record.id,
          published,
          remaining: batch.length - published,
          error: renderThrowable(error),
        });
        // Hand the rest of the batch back rather than sit on a claim nobody is publishing. The
        // claim is a lease now, so without this a single pool timeout parks every committed row
        // behind it for the whole lease window instead of for one poll interval.
        await options.store.release?.(
          batch.slice(published).map((row) => row.id),
          record.claimedBy,
        );
        break;
      }
    }
    // The jobs are on the queue of THIS process's driver: wake its workers rather than leave them
    // to find out on their own backed-off poll.
    if (published > 0) signalEnqueued();
    // The loop's next wait, decided by the pass itself so `tick()` and the timer agree: the floor
    // while rows are moving, doubling to the ceiling while there are none.
    delayMs = backoff.next(batch.length > 0);
    return published;
  };

  /**
   * The `accept` phase, and all of it: flip the state, clear the timer, return. Every hook behind
   * this one — `@ultimat3/http`'s "stop listening", the sync node's "stop upgrading" — then runs
   * with the whole budget still in hand, which is what a wait parked here costs them.
   */
  const stopAccepting = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    if (state === 'running') state = 'draining';
  };

  const teardown = async (): Promise<void> => {
    stopAccepting();
    again = false;
    try {
      // The pass in flight is a `driver.enqueue` and the `markPublished` behind it. Abandoning
      // between the two republishes the row on the next boot — which the idempotency key collapses
      // only while the first job is still live — so it is waited out here, in `close`, under the
      // budget. Unbound on a manual `stop()`: a caller that asked has no deadline to spend, and
      // nothing else in this process is waiting on the answer.
      const settled = await settleAllBy(pass === undefined ? [] : [pass], budget);
      if (!settled) {
        logger.warn('jobs.outbox.drain-abandoned', {
          fix: 'raise the drain budget past one publish — configureLifecycle({ deadlineMs: 60_000 }) — and set terminationGracePeriodSeconds to at least as many seconds',
        });
      }
    } finally {
      // Whatever the wait did, this relay is done, and the hooks go back. One left registered
      // publishes through a stopped relay on the next process-wide drain — against a driver
      // already closed — and keeps this closure, its store and its driver alive with it.
      state = 'stopped';
      for (const release of releaseShutdownHooks) release();
      releaseShutdownHooks = [];
      // Fresh per teardown: a restarted relay's manual stop must not inherit a deadline spent.
      budget = createDrainBudget();
    }
  };

  const stop = async (deadlineAt?: number): Promise<void> => {
    // Answered immediately once this relay is done: the teardown always REACHES 'stopped' (its
    // wait is bounded on the SIGTERM path and the state is set in a `finally`), so a caller
    // landing after an abandoned drain gets an answer rather than joining a settled lifetime ago.
    if (state === 'stopped') return;
    // Before the join, every time: the stop that finds a teardown already waiting is the one
    // whose deadline that wait has not heard yet. The earliest bound wins.
    if (deadlineAt !== undefined) budget.bind(deadlineAt);
    // One teardown, joined rather than repeated: a SIGTERM landing on a manual stop waits out the
    // same pass instead of returning underneath it. Cleared as it settles, so a relay started
    // again stops again rather than joining a promise that settled a lifetime ago.
    stopping ??= teardown().finally(() => {
      stopping = undefined;
    });
    await stopping;
  };

  return {
    tick,
    start() {
      if (timer !== undefined) return;
      // Only from a standstill, the worker's rule: a start mid-drain would re-arm the poll on a
      // store the drain is about to leave, and stack a second pair of hooks on the one still
      // running — the first pair's unregisters are held in a single slot and would be dropped.
      if (state === 'draining') return;
      state = 'running';
      // TWO hooks, for the two phases — the shape `worker.ts` and `scheduler.ts` hold. This loop
      // had NONE: on SIGTERM it went on claiming and publishing through every phase, stamping
      // leases on rows nothing on this pod would run, and `RunningRoles.stop()` was the only thing
      // that ever stopped it — a caller a signal can skip entirely.
      //
      // Both unregisters are kept, never discarded: the teardown hands them back, so
      // start -> stop -> start holds one pair rather than one per start.
      if (options.drainOnShutdown !== false) {
        releaseShutdownHooks = [
          onShutdown('jobs.outbox.accept', stopAccepting, { phase: 'accept' }),
          onShutdown('jobs.outbox', (reason) => stop(reason.deadlineAt), { phase: 'close' }),
        ];
      }
      // One pass, then re-armed by ITS result: the floor while rows are moving, doubling to the
      // ceiling while there are none. It was a `setInterval` at 200 ms — five claims a second
      // against an outbox with nothing in it, from every pod, for as long as the pod lived.
      const arm = (): void => {
        timer = setTimeout(() => {
          // Re-read on every pass: "stop claiming" means this timer too, and a callback already on
          // the event loop when the timer was cleared must not open a claim behind the drain.
          if (running || state !== 'running') return;
          running = true;
          // `.catch` before `.finally`, the shape every other loop in this package uses. `tick()`
          // guards each publish but not `store.claim()` — one pool timeout during a failover
          // rejects here unobserved, and Bun's default for an unhandled rejection is to end the
          // process, taking every staged, unpublished row with it.
          //
          // Kept rather than discarded, because `stop()` awaits exactly this chain: the publish
          // and the `markPublished` behind it are one pass, and a teardown that returned between
          // them closed the database under the row it was about to mark.
          pass = tick()
            .then((): void => undefined)
            .catch((error: unknown) => {
              // A failed pass is not an idle one: try again at the floor.
              delayMs = backoff.next(true);
              logger.error('jobs.outbox.tick-failed', {
                error: renderThrowable(error),
              });
            })
            .finally(() => {
              running = false;
              pass = undefined;
              if (state !== 'running') return;
              if (again) delayMs = 0;
              again = false;
              arm();
            });
        }, delayMs);
        // Never the thing keeping a drained process alive — the rule `renewal-timer.ts` and
        // `lifecycle-deadline.ts` both state for their own timers. The hooks above are what stop
        // this loop, not the process refusing to end.
        timer.unref?.();
      };
      // A staged row. Either way the passes after this one run at the floor again. One staged
      // by THIS process is not committed yet, so the wait in hand is cut to the floor and the
      // passes that follow find it. One Postgres ANNOUNCED has committed: the pass runs now — or
      // right behind the one in flight, whose claim may have read before the commit.
      unsubscribe = onStaged((committed) => {
        backoff.reset();
        const wait = committed === true ? 0 : intervalMs;
        if (running) {
          again = again || committed === true;
          return;
        }
        if (delayMs <= wait || timer === undefined) return;
        clearTimeout(timer);
        delayMs = wait;
        arm();
      });
      arm();
    },
    stop,
    pending: () => options.store.pendingCount(),
    pollDelayMs: () => delayMs,
  };
}
