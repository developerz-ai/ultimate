// The event bus `step.waitForEvent` consumes. Events are stored, not just broadcast: a step
// that suspends at 12:00 and resumes at 12:00:30 must still see an event published at
// 12:00:10, so a fire-and-forget emitter would silently strand every waiting run.

import type { Clock } from '@ultimat3/core';
import { finiteOption, logger, systemClock, uuidV7 } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { finiteDurationMs, nowMs } from './clock';
import { eventBefore, pastCursor } from './events-cursor';
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
   * like every other instant it holds. The memory bus also sweeps on a publish, at most once a
   * second and only once something has expired; the stored one
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

/** The least gap between two publish-time sweeps, on the bus's clock. */
const SWEEP_EVERY_MS = 1_000;

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
  // Per name, so `find` reads one event's rows and never the whole bus (10k events made every
  // find a 10k scan). Sets keep insertion order and delete in O(1), which the eviction needs.
  const byName = new Map<string, Set<JobEvent>>();
  /** No stored event expires before this, so a publish before it has nothing to sweep. */
  let nextExpiry = Number.POSITIVE_INFINITY;
  let lastSweptAt = Number.NEGATIVE_INFINITY;

  const forget = (event: JobEvent): void => {
    events.delete(event.id);
    const named = byName.get(event.name);
    named?.delete(event);
    if (named?.size === 0) byName.delete(event.name);
  };

  const purgeExpired = (): number => {
    const at = nowMs(clock);
    let removed = 0;
    nextExpiry = Number.POSITIVE_INFINITY;
    for (const event of events.values()) {
      if (event.expiresAt <= at) {
        forget(event);
        removed += 1;
      } else if (event.expiresAt < nextExpiry) nextExpiry = event.expiresAt;
    }
    lastSweptAt = at;
    return removed;
  };

  return {
    stored: false,
    now: () => Promise.resolve(nowMs(clock)),
    publish(name, payload, publishOptions = {}) {
      const at = nowMs(clock);
      // A sweep is a pass over every event, so a publish pays for one only when something has
      // expired AND the last one is a second old: a sweep per publish made a 10k fill 916 ms.
      // `find` filters the expired either way; this only bounds the heap.
      if (at >= nextExpiry && at - lastSweptAt >= SWEEP_EVERY_MS) purgeExpired();
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
      const named = byName.get(name);
      if (named === undefined) byName.set(name, new Set([event]));
      else named.add(event);
      if (event.expiresAt < nextExpiry) nextExpiry = event.expiresAt;
      while (events.size > maxEvents) {
        const oldest = events.values().next();
        if (oldest.done === true) break;
        forget(oldest.value);
      }
      logger.debug('jobs.event.published', {
        event: name,
        correlationKey: publishOptions.correlationKey ?? null,
      });
      return Promise.resolve(event);
    },

    /**
     * Earliest matching event past the cursor, in `(publishedAt, id)` order (`events-cursor.ts`),
     * so a resumed step consumes events in publication order rather than jumping to the newest
     * one — the rule `SQL_EVENT_FIND` states. The cursor is compared, never looked up: a refused
     * event that has since been purged still excludes everything at or before it.
     */
    find(name, correlationKey, afterMs, afterId, _horizon, since) {
      const at = nowMs(clock);
      // The wait's own line; no horizon here — a memory publish is visible as it is stamped.
      const from = since?.at ?? afterMs;
      const cursor = afterId === undefined ? { afterMs } : { afterMs, afterId };
      let best: JobEvent | undefined;
      for (const event of byName.get(name) ?? []) {
        if (event.expiresAt <= at) continue;
        if (event.publishedAt < from || !pastCursor(event, cursor)) continue;
        if (since?.refused?.includes(event.id) === true) continue;
        if (correlationKey !== undefined && event.correlationKey !== correlationKey) continue;
        if (best === undefined || eventBefore(event, best)) best = event;
      }
      return Promise.resolve(
        best === undefined
          ? undefined
          : { id: best.id, payload: best.payload, publishedAt: best.publishedAt },
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
