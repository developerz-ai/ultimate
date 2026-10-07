// The event bus `step.waitForEvent` consumes. Events are stored, not just broadcast: a step
// that suspends at 12:00 and resumes at 12:00:30 must still see an event published at
// 12:00:10, so a fire-and-forget emitter would silently strand every waiting run.

import type { Clock } from '@ultimat3/core';
import { finiteOption, logger, systemClock, uuidV7 } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { finiteDurationMs, nowMs } from './clock';
import type { PurgeTarget } from './purge';
import type { EventLookup } from './steps';

export interface JobEvent {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  /** Ties the event to one waiting run — usually an entity id. */
  readonly correlationKey?: string;
  readonly publishedAt: number;
  readonly expiresAt: number;
}

export interface PublishOptions {
  readonly correlationKey?: string;
  /** How long the event stays matchable. Default 7d — longer than any sane wait. */
  readonly ttl?: DurationInput;
}

export interface EventBus extends EventLookup {
  /**
   * Whether an event published by ONE process is found by another. `true` for a bus over a table,
   * `false` for the in-memory one — which is the whole question a wait across the web / worker
   * split asks, and the reason `eventPrompt()` refuses the in-memory bus outside development.
   */
  readonly stored: boolean;
  publish(name: string, payload: unknown, options?: PublishOptions): Promise<JobEvent>;
  list(name?: string): Promise<readonly JobEvent[]>;
  /**
   * Delete every event past its expiry and answer how many went. Measured on the bus's own clock,
   * like every other instant it holds. The memory bus also sweeps on each publish; the stored one
   * has no caller but the retention sweep (`eventsPurgeTarget`).
   */
  purgeExpired(): Promise<number>;
  size(): number;
}

export interface MemoryEventBusOptions {
  readonly clock?: Clock;
  readonly defaultTtl?: DurationInput;
  readonly maxEvents?: number;
}

export function memoryEventBus(options: MemoryEventBusOptions = {}): EventBus {
  const clock = options.clock ?? systemClock;
  // TWO screens, because these are two knobs: the default is declared at construction and belongs
  // to whoever built the bus, `ttl` rides the publish CALL. One screen over `ttl ?? defaultTtl`
  // told a caller who wrote `{ ttl: NaN }` to "pass a finite defaultTtl" — an instruction naming an
  // option they never set, on a constructor usually in another file. `steps.ts` names `timeout` for
  // the same value shape.
  const defaultTtlMs = finiteDurationMs(
    options.defaultTtl ?? 604_800_000,
    'the memory event bus',
    'defaultTtl',
  );
  const maxEvents = finiteOption('the memory event bus', 'maxEvents', options.maxEvents ?? 10_000);
  const events = new Map<string, JobEvent>();

  const purgeExpired = (): number => {
    const at = nowMs(clock);
    let removed = 0;
    for (const [id, event] of events) {
      if (event.expiresAt <= at) {
        events.delete(id);
        removed += 1;
      }
    }
    return removed;
  };

  return {
    stored: false,
    now: () => Promise.resolve(nowMs(clock)),
    publish(name, payload, publishOptions = {}) {
      purgeExpired();
      const at = nowMs(clock);
      const event: JobEvent = {
        id: uuidV7(),
        name,
        payload,
        publishedAt: at,
        expiresAt:
          at +
          (publishOptions.ttl === undefined
            ? defaultTtlMs
            : finiteDurationMs(publishOptions.ttl, 'the memory event bus', 'ttl')),
        ...(publishOptions.correlationKey === undefined
          ? {}
          : { correlationKey: publishOptions.correlationKey }),
      };
      events.set(event.id, event);
      while (events.size > maxEvents) {
        const oldest = events.keys().next();
        if (oldest.done === true) break;
        events.delete(oldest.value);
      }
      logger.debug('jobs.event.published', {
        event: name,
        correlationKey: publishOptions.correlationKey ?? null,
      });
      return Promise.resolve(event);
    },

    /**
     * Earliest matching event at or after `afterMs`, so a resumed step consumes events in
     * publication order rather than jumping to the newest one.
     */
    find(name, correlationKey, afterMs) {
      const at = nowMs(clock);
      let best: JobEvent | undefined;
      for (const event of events.values()) {
        if (event.name !== name) continue;
        if (event.expiresAt <= at) continue;
        if (event.publishedAt < afterMs) continue;
        if (correlationKey !== undefined && event.correlationKey !== correlationKey) continue;
        if (best === undefined || event.publishedAt < best.publishedAt) best = event;
      }
      return Promise.resolve(
        best === undefined ? undefined : { payload: best.payload, publishedAt: best.publishedAt },
      );
    },

    list(name) {
      const all = [...events.values()]
        .filter((event) => name === undefined || event.name === name)
        .sort((a, b) => a.publishedAt - b.publishedAt);
      return Promise.resolve(all);
    },

    purgeExpired: () => Promise.resolve(purgeExpired()),
    size: () => events.size,
  };
}

/** The table the stored bus keeps — the sweep's durable step key, log field and report name. */
export const EVENTS_PURGE_TARGET = 'x_job_events';

/**
 * The bus as one table of the retention sweep (`purge()`). `x_job_events` takes a row per publish
 * and an expired one is only FILTERED by `find`, so with no sweep the table grows for the life of
 * the deployment. The sweep's `nowMs` is not passed on: a bus holds its own clock.
 */
export function eventsPurgeTarget(bus: EventBus): PurgeTarget {
  return { name: EVENTS_PURGE_TARGET, purgeExpired: () => bus.purgeExpired() };
}

let ambientBus: EventBus = memoryEventBus();

/**
 * **Install `postgresEventBus({ executor })` here in any deployment with more than one process.**
 * The default above is one process's heap: the pod that publishes and the pod that resumes are
 * never the same one, so a webhook landing on web-3 strands a run on worker-7 until its 24h
 * timeout dead-letters it, with nothing logged before then. This line used to promise a
 * "NATS/Redis-streams bus swapped at boot"; no such bus existed and boot installed the memory one.
 */
export function setEventBus(bus: EventBus): void {
  ambientBus = bus;
}

export function eventBus(): EventBus {
  return ambientBus;
}

/**
 * Test seam, the counterpart of `resetJobDriver()` and `resetJobsFacade()`: back to a FRESH
 * in-process bus, the state a process boots in. An event is matchable until it expires, so on a
 * bus shared by a whole `bun test` process an answer one test published resumes the next test's
 * wait before that test has asked anything — call this between tests.
 */
export function resetEventBus(): void {
  ambientBus = memoryEventBus();
}

/** The one function app code calls to unblock a waiting step. */
export function publishEvent(
  name: string,
  payload: unknown,
  options?: PublishOptions,
): Promise<JobEvent> {
  return ambientBus.publish(name, payload, options);
}
