// `x_job_events`: the event bus `step.waitForEvent` needs in a real deployment. The memory bus is
// one process's heap, and in a deployment the publisher and the resumer are never the same pod —
// a Stripe webhook lands on web-3 and the worker that resumes the run is worker-7, so `find`
// answers `undefined` until the 24h timeout and the run dead-letters with nothing logged first.
//
// Stored and not broadcast, exactly as the memory bus is: a step that suspends at 12:00 and
// resumes at 12:00:30 must still see an event published at 12:00:10.

import type { PgExecutor } from '@ultimat3/core';
import { finiteOption, logger, uuidV7 } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { finiteDurationMs } from './clock';
import {
  SQL_EVENT_FIND,
  SQL_EVENT_LIST,
  SQL_EVENT_NOW,
  SQL_EVENT_PUBLISH,
  SQL_EVENT_PURGE_COUNTED,
} from './driver-pg-sql';
import type { EventBus } from './events';

interface EventRow {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly correlation_key: string | null;
  readonly published_at: number | string;
  readonly expires_at: number | string;
}

export interface PostgresEventBusOptions {
  /**
   * The only thing this bus is built from. There is no `clock`: every instant it writes or
   * compares is the database's (`SQL_EVENT_PUBLISH`), and a process clock here was the defect.
   */
  readonly executor: PgExecutor;
  /** How long an event stays matchable. Default 7d — longer than any sane wait. */
  readonly defaultTtl?: DurationInput;
  /** Rows returned by `list()`. Diagnostics only; `find()` is what a step uses. */
  readonly listLimit?: number;
}

export function postgresEventBus(options: PostgresEventBusOptions): EventBus {
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

  // Awaited and never fired-and-forgotten: it was `void`ed with nothing calling it, so the table
  // only grew. A failure REJECTS — the caller is the retention sweep's step, which retries.
  const purgeExpired = async (): Promise<number> => {
    const rows = await exec.query<{ removed: number | string }>(SQL_EVENT_PURGE_COUNTED, []);
    return Number(rows[0]?.removed ?? 0);
  };

  return {
    stored: true,
    async now() {
      const rows = await exec.query<{ now: number | string }>(SQL_EVENT_NOW, []);
      return Number(rows[0]?.now);
    },

    async publish(name, payload, publishOptions = {}) {
      const id = uuidV7();
      const ttlMs =
        publishOptions.ttl === undefined
          ? defaultTtlMs
          : finiteDurationMs(publishOptions.ttl, 'the pg event bus', 'ttl');
      const rows = await exec.query<{
        published_at: number | string;
        expires_at: number | string;
      }>(SQL_EVENT_PUBLISH, [
        id,
        name,
        JSON.stringify(payload ?? null),
        publishOptions.correlationKey ?? null,
        ttlMs,
      ]);
      logger.debug('jobs.event.published', {
        event: name,
        correlationKey: publishOptions.correlationKey ?? null,
      });
      // The stamps the statement wrote, read back: what a consumer will compare against.
      return {
        id,
        name,
        payload,
        publishedAt: Number(rows[0]?.published_at),
        expiresAt: Number(rows[0]?.expires_at),
        ...(publishOptions.correlationKey === undefined
          ? {}
          : { correlationKey: publishOptions.correlationKey }),
      };
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
