// `x_job_events`: the event bus `step.waitForEvent` needs in a real deployment. The memory bus is
// one process's heap, and in a deployment the publisher and the resumer are never the same pod —
// a Stripe webhook lands on web-3 and the worker that resumes the run is worker-7, so `find`
// answers `undefined` until the 24h timeout and the run dead-letters with nothing logged first.
//
// Stored and not broadcast, exactly as the memory bus is: a step that suspends at 12:00 and
// resumes at 12:00:30 must still see an event published at 12:00:10.

import type { Clock } from '@ultimat3/core';
import { finiteOption, logger, renderThrowable, systemClock, uuid } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { finiteDurationMs, nowMs } from './clock';
import type { PgExecutor } from './driver-pg';
import {
  SQL_EVENT_FIND,
  SQL_EVENT_LIST,
  SQL_EVENT_PUBLISH,
  SQL_EVENT_PURGE,
} from './driver-pg-sql';
import type { EventBus, JobEvent } from './events';

interface EventRow {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly correlation_key: string | null;
  readonly published_at: number | string;
  readonly expires_at: number | string;
}

export interface PgEventBusOptions {
  readonly executor: PgExecutor;
  readonly clock?: Clock;
  /** How long an event stays matchable. Default 7d — longer than any sane wait. */
  readonly defaultTtl?: DurationInput;
  /** Rows returned by `list()`. Diagnostics only; `find()` is what a step uses. */
  readonly listLimit?: number;
}

/**
 * `purgeExpired()` is SYNCHRONOUS in `EventBus` because the memory bus can be — it walks a Map.
 * Over SQL the delete is a round trip, so this fires it and answers 0: the count is a diagnostic
 * the memory bus offers and this one cannot, and blocking a step's resume on a housekeeping
 * DELETE would be a far worse trade than an unanswered number. The index on `(name, published_at)`
 * plus `expires_at > now()` in `find` means an unpurged row costs a filter, never a wrong answer.
 */
export function createPgEventBus(options: PgEventBusOptions): EventBus {
  const clock = options.clock ?? systemClock;
  // TWO screens, for the reason `events.ts` states: `defaultTtl` is the constructor's knob and
  // `ttl` is the publish call's, so one screen over `ttl ?? defaultTtl` names the wrong one for
  // whichever value actually arrived.
  const defaultTtlMs = finiteDurationMs(
    options.defaultTtl ?? 604_800_000,
    'the pg event bus',
    'defaultTtl',
  );
  const listLimit = finiteOption('the pg event bus', 'listLimit', options.listLimit ?? 1_000);
  const exec = options.executor;

  const purgeExpired = (): number => {
    void exec.query(SQL_EVENT_PURGE, []).catch((error: unknown) => {
      // Housekeeping never costs a publish: an unpurged row is filtered out of every read.
      logger.warn('jobs.event.purge-failed', {
        error: renderThrowable(error),
      });
    });
    return 0;
  };

  return {
    async publish(name, payload, publishOptions = {}) {
      const at = nowMs(clock);
      const event: JobEvent = {
        id: uuid(),
        name,
        payload,
        publishedAt: at,
        expiresAt:
          at +
          (publishOptions.ttl === undefined
            ? defaultTtlMs
            : finiteDurationMs(publishOptions.ttl, 'the pg event bus', 'ttl')),
        ...(publishOptions.correlationKey === undefined
          ? {}
          : { correlationKey: publishOptions.correlationKey }),
      };
      await exec.query(SQL_EVENT_PUBLISH, [
        event.id,
        event.name,
        JSON.stringify(event.payload ?? null),
        event.correlationKey ?? null,
        event.publishedAt,
        event.expiresAt,
      ]);
      logger.debug('jobs.event.published', {
        event: name,
        correlationKey: publishOptions.correlationKey ?? null,
      });
      return event;
    },

    /** Earliest match at or after `afterMs`, so a resumed step consumes events in order. */
    async find(name, correlationKey, afterMs) {
      const rows = await exec.query<{ payload: unknown; published_at: number | string }>(
        SQL_EVENT_FIND,
        [name, correlationKey ?? null, afterMs],
      );
      const row = rows[0];
      return row === undefined
        ? undefined
        : { payload: row.payload, publishedAt: Number(row.published_at) };
    },

    async list(name) {
      const rows = await exec.query<EventRow>(SQL_EVENT_LIST, [name ?? null, listLimit]);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        payload: row.payload,
        publishedAt: Number(row.published_at),
        expiresAt: Number(row.expires_at),
        ...(row.correlation_key === null ? {} : { correlationKey: row.correlation_key }),
      }));
    },

    purgeExpired,
    // The memory bus's `size()` is its Map's; over SQL a `count(*)` is a round trip and every
    // caller of this is a test asserting on a bound the memory bus has. `-1` is the honest
    // "not a number this bus keeps" — never `0`, which reads as an empty bus.
    size: () => -1,
  };
}
