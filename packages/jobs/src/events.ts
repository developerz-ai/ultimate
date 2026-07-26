// The event bus `step.waitForEvent` consumes. Events are stored, not just broadcast: a step
// that suspends at 12:00 and resumes at 12:00:30 must still see an event published at
// 12:00:10, so a fire-and-forget emitter would silently strand every waiting run.

import type { Clock } from '@ultimat3/core';
import { logger, systemClock, uuid } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { nowMs, toMs } from './clock';
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
  publish(name: string, payload: unknown, options?: PublishOptions): Promise<JobEvent>;
  list(name?: string): Promise<readonly JobEvent[]>;
  purgeExpired(): number;
  size(): number;
}

export interface MemoryEventBusOptions {
  readonly clock?: Clock;
  readonly defaultTtl?: DurationInput;
  readonly maxEvents?: number;
}

export function createMemoryEventBus(options: MemoryEventBusOptions = {}): EventBus {
  const clock = options.clock ?? systemClock;
  const defaultTtl = options.defaultTtl ?? 604_800_000;
  const maxEvents = options.maxEvents ?? 10_000;
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
    publish(name, payload, publishOptions = {}) {
      purgeExpired();
      const at = nowMs(clock);
      const event: JobEvent = {
        id: uuid(),
        name,
        payload,
        publishedAt: at,
        expiresAt: at + toMs(publishOptions.ttl ?? defaultTtl),
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

    purgeExpired,
    size: () => events.size,
  };
}

let ambientBus: EventBus = createMemoryEventBus();

/** Swapped at boot for the NATS/Redis-streams bus in a multi-node deployment. */
export function setEventBus(bus: EventBus): void {
  ambientBus = bus;
}

export function eventBus(): EventBus {
  return ambientBus;
}

/** The one function app code calls to unblock a waiting step. */
export function publishEvent(
  name: string,
  payload: unknown,
  options?: PublishOptions,
): Promise<JobEvent> {
  return ambientBus.publish(name, payload, options);
}
