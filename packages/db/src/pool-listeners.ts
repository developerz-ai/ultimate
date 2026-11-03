// Single responsibility: the LISTEN sessions a `postgresClient` holds beside its pool, and carrying
// them across a retired pool. `Bun.SQL` re-dials a session whose backend died, but `close()` ends it
// for good, so a retirement would leave `startQueueWake` reporting live on a session that is gone.

import { backoffDelay, logger, renderThrowable, type Scheduler } from '@ultimat3/core';
import type { BunSqlDriver } from './bun-sql';
import { DbError, driverError } from './errors';
import { assertListenChannel, type DbSubscription, listenUnsupported } from './listen';
import { unrefSchedule } from './pool-timer';

const REDIAL_BASE_MS = 1_000;
const REDIAL_MAX_MS = 30_000;

type Session = Awaited<ReturnType<NonNullable<BunSqlDriver['listen']>>>;

export interface PoolListeners {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListening?: () => void,
  ): Promise<DbSubscription>;
  /** The pool behind every session is gone: establish each again on the current one. */
  redial(): void;
  /** `close()` ended every session, and the client is done with them. */
  drop(): void;
}

interface Held {
  readonly channel: string;
  readonly onNotify: (payload: string) => void;
  readonly onListening: (() => void) | undefined;
  session: Session | undefined;
  /** Moved by each redial: a dial the next retirement overtook is nobody's. */
  dial: number;
  cancelRetry: () => void;
  ended: boolean;
}

export function poolListeners(
  currentPool: () => Pick<BunSqlDriver, 'listen'>,
  schedule: Scheduler = unrefSchedule,
): PoolListeners {
  const held = new Set<Held>();

  /** Best-effort, the rule `releaseReserved` states: the session may be gone with its pool. */
  const end = (session: Session): Promise<void> =>
    session.unlisten().catch((error: unknown) => {
      logger.debug('db.unlisten_failed', { error: renderThrowable(error) });
    });

  const dialOn = (entry: Held): Promise<Session> => {
    const pool = currentPool();
    if (pool.listen === undefined) throw listenUnsupported('this Bun.SQL');
    return pool.listen(entry.channel, entry.onNotify, entry.onListening);
  };

  function redialOne(entry: Held, attempt: number): void {
    // The session is gone NOW, whether or not a re-dial ever lands: `startQueueWake` un-proves the
    // wake on this cue, so the loops drop to the poll's ceiling instead of trusting a dead session.
    // Once per retirement, not per refused attempt: each cue sends a probe.
    if (attempt === 1) entry.onListening?.();
    entry.dial += 1;
    const dial = entry.dial;
    const overtaken = (): boolean => entry.ended || dial !== entry.dial;
    entry.cancelRetry();
    entry.session = undefined;
    // `async` so a pool that cannot be built (`currentPool` throws) lands in the retry too.
    void (async () => dialOn(entry))().then(
      (session) => {
        if (overtaken()) void end(session);
        else entry.session = session;
      },
      (error: unknown) => {
        if (overtaken()) return;
        logger.warn('db.listen.redial_failed', {
          channel: entry.channel,
          attempt,
          error: renderThrowable(error),
        });
        // Equal jitter: a fleet that lost its database together must not re-dial it together.
        const wait = backoffDelay({
          attempt,
          base: REDIAL_BASE_MS,
          max: REDIAL_MAX_MS,
          jitter: 'equal',
        });
        entry.cancelRetry = schedule(() => redialOne(entry, attempt + 1), wait);
      },
    );
  }

  return {
    async listen(channel, onNotify, onListening) {
      assertListenChannel(channel);
      const entry: Held = {
        channel,
        onNotify,
        onListening,
        session: undefined,
        dial: 0,
        cancelRetry: () => undefined,
        ended: false,
      };
      held.add(entry);
      try {
        // The driver's own session, never a pin out of the pool: a reserved connection holds the
        // LISTEN and surfaces no notification, and it would cost the pool a slot for good.
        const session = await dialOn(entry);
        if (entry.dial === 0 && !entry.ended) entry.session = session;
        else void end(session);
      } catch (error) {
        // A retirement mid-dial already took this subscription over: its redial is the answer.
        if (entry.dial === 0) {
          held.delete(entry);
          if (error instanceof DbError) throw error;
          throw driverError(`LISTEN ${channel}`, error);
        }
      }
      let ended: Promise<void> | undefined;
      return {
        unlisten: () => {
          ended ??= (async () => {
            entry.ended = true;
            entry.cancelRetry();
            held.delete(entry);
            if (entry.session !== undefined) await end(entry.session);
          })();
          return ended;
        },
      };
    },
    redial() {
      for (const entry of held) redialOne(entry, 1);
    },
    drop() {
      for (const entry of held) {
        entry.ended = true;
        entry.cancelRetry();
      }
      held.clear();
    },
  };
}
