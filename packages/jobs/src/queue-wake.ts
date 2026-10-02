// The cross-process wake: one `LISTEN` session per worker pod, turning "another process committed
// a job / an outbox row" into the two in-process signals the idle loops already hear
// (`enqueue-signal.ts`). An optimisation, never the guarantee — a notification is lost with the
// session that would have carried it, and a transaction-pooling proxy delivers none at all — so
// the poll keeps running underneath, and this file's other job is to say whether the wake is
// PROVEN: the loops raise their idle ceiling only while it is.

import type { Random } from '@ultimat3/core';
import { backoffDelay, finiteOption, logger, renderThrowable } from '@ultimat3/core';
import type { PgExecutor } from './driver-pg';
import { JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL, SQL_WAKE } from './driver-pg-wake-sql';
import { setWakeLive, signalEnqueued, signalStaged } from './enqueue-signal';

/**
 * What holds the session. Declared structurally, as `PgExecutor` is: `@ultimat3/db`'s
 * `PostgresClient` and `PgliteClient` both satisfy it, and this package takes no client from it.
 * `onListening` fires each time the subscription is (re-)established — the driver re-dials a
 * session that died, and what was notified in between is gone.
 */
export interface PgListener {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListening?: () => void,
  ): Promise<{ unlisten(): Promise<void> }>;
}

export interface QueueWakeOptions {
  readonly listener: PgListener;
  /** The POOLED executor: it sends the probe a fresh subscription is proven with. */
  readonly executor: PgExecutor;
  /** How long a probe may take to come back before the wake is reported unproven. Default 5 s. */
  readonly verifyTimeoutMs?: number;
  /** First and longest gap between attempts to subscribe or probe. Default 1 s doubling to 30 s. */
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly random?: Random;
  /** Arm a timer; answers its cancel. Injected so a test advances time instead of waiting. */
  readonly setTimer?: (run: () => void, delayMs: number) => () => void;
}

export interface QueueWake {
  /** A notification has crossed the session since it was last (re-)established. */
  live(): boolean;
  /** End the session. Idempotent; the loops fall back to their no-wake ceiling. */
  stop(): Promise<void>;
}

const CHANNELS = [JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL] as const;
type Channel = (typeof CHANNELS)[number];

const UNVERIFIED_FIX =
  'point DATABASE_URL at Postgres itself or at a SESSION-pooling proxy (PgBouncer pool_mode = session) for the worker role — a transaction-pooling proxy delivers no notification. Nothing is lost meanwhile: jobs start on the poll, at most idlePollMaxMs late';

const armTimer = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  // Never the thing keeping a drained process alive — the rule every timer in this package states.
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function startQueueWake(options: QueueWakeOptions): QueueWake {
  const subject = 'startQueueWake';
  const verifyTimeoutMs = finiteOption(
    subject,
    'verifyTimeoutMs',
    options.verifyTimeoutMs ?? 5_000,
  );
  const retryBaseMs = finiteOption(subject, 'retryBaseMs', options.retryBaseMs ?? 1_000);
  const retryMaxMs = finiteOption(subject, 'retryMaxMs', options.retryMaxMs ?? 30_000);
  const setTimer = options.setTimer ?? armTimer;

  let stopped = false;
  let stopping: Promise<void> | undefined;
  const held: { unlisten(): Promise<void> }[] = [];
  /** Which channels a notification has crossed since the session was last established. */
  const proven = new Set<Channel>();
  let cancelTimer: (() => void) | undefined;
  let cancelVerdict: (() => void) | undefined;
  /** Every channel has been subscribed once: from here an `onListening` is a re-dial. */
  let subscribed = false;
  let probing = false;
  /** A channel was (re-)established while a probe was in flight: that probe may predate it. */
  let reprobe = false;
  let reportedUnverified = false;

  const later = (attempt: number, run: () => void): void => {
    cancelTimer?.();
    cancelTimer = setTimer(
      run,
      // Equal jitter: a fleet that lost its database together must not re-dial it together.
      backoffDelay({
        attempt,
        base: retryBaseMs,
        max: retryMaxMs,
        jitter: 'equal',
        ...(options.random === undefined ? {} : { random: options.random }),
      }),
    );
  };

  const crossed = (channel: Channel): void => {
    if (proven.has(channel)) return;
    proven.add(channel);
    if (proven.size < CHANNELS.length || stopped) return;
    cancelVerdict?.();
    cancelVerdict = undefined;
    setWakeLive(true);
    logger.info('jobs.wake.live', { channels: CHANNELS });
  };

  /**
   * Prove the path end to end: a notification sent through the POOL must come back on the
   * session. It is also the catch-up — an empty payload wakes every loop once, which re-reads
   * whatever was committed while no session was listening.
   */
  const probe = (attempt: number): void => {
    if (stopped) return;
    probing = true;
    void Promise.all(CHANNELS.map((channel) => options.executor.query(SQL_WAKE, [channel, ''])))
      .then(() => {
        probing = false;
        if (reprobe) {
          reprobe = false;
          probe(1);
          return;
        }
        if (stopped || proven.size === CHANNELS.length) return;
        cancelVerdict?.();
        cancelVerdict = setTimer(() => {
          if (stopped || proven.size === CHANNELS.length || reportedUnverified) return;
          // Once per process: the proxy in the way does not change between probes.
          reportedUnverified = true;
          logger.warn('jobs.wake.unverified', {
            waitedMs: verifyTimeoutMs,
            fix: UNVERIFIED_FIX,
          });
        }, verifyTimeoutMs);
      })
      .catch((error: unknown) => {
        probing = false;
        reprobe = false;
        logger.warn('jobs.wake.probe-failed', { attempt, error: renderThrowable(error) });
        later(attempt, () => probe(attempt + 1));
      });
  };

  /** The session is new: nothing is proven about it, and what it missed has to be re-read. */
  const established = (): void => {
    if (stopped) return;
    proven.clear();
    setWakeLive(false);
    // Not before every channel is subscribed: a probe sent ahead of a `LISTEN` proves nothing.
    if (!subscribed) return;
    if (probing) reprobe = true;
    else probe(1);
  };

  /** Each channel and what one notification on it becomes. A list, so the dial reads no table. */
  const subscriptions: readonly (readonly [Channel, (payload: string) => void])[] = [
    [
      JOBS_WAKE_CHANNEL,
      (payload) => {
        crossed(JOBS_WAKE_CHANNEL);
        signalEnqueued(payload === '' ? undefined : payload);
      },
    ],
    [
      OUTBOX_WAKE_CHANNEL,
      () => {
        crossed(OUTBOX_WAKE_CHANNEL);
        signalStaged(true);
      },
    ],
  ];

  const release = async (): Promise<void> => {
    await Promise.allSettled(held.splice(0).map((subscription) => subscription.unlisten()));
  };

  const dial = async (attempt: number): Promise<void> => {
    try {
      for (const [channel, onNotify] of subscriptions) {
        if (stopped) break;
        held.push(await options.listener.listen(channel, onNotify, established));
      }
      // A `stop()` that landed mid-dial found nothing to hand back yet.
      if (stopped) {
        await release();
        return;
      }
      subscribed = true;
      established();
    } catch (error) {
      await release();
      subscribed = false;
      if (stopped) return;
      logger.warn('jobs.wake.listen-failed', { attempt, error: renderThrowable(error) });
      later(attempt, () => {
        void dial(attempt + 1);
      });
    }
  };

  void dial(1);

  return {
    live: () => !stopped && proven.size === CHANNELS.length,
    stop() {
      stopping ??= (async () => {
        stopped = true;
        cancelTimer?.();
        cancelVerdict?.();
        setWakeLive(false);
        await release();
      })();
      return stopping;
    },
  };
}
