// A scheduler fire on core's instrumentation bus: each fired job is one `job.enqueue` event, under
// one producer span whose id the enqueued row's `traceparent` carries — the run's parent.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock, JobEnqueueEvent, ReadableSpan } from '@ultimat3/core';
import { resetInstrumentation, resetTelemetry, subscribe } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import type { CronResolver } from './scheduler';
import { jobScheduler } from './scheduler';
import { resetTasks, task } from './task';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

/** Deterministic stand-in for @ultimat3/time: fires daily at 03:00 UTC. */
const dailyAt3: CronResolver = (cron, options) => {
  expect(cron).toBe('0 3 * * *');
  const dayMs = 86_400_000;
  const from = options.from.getTime();
  const at3 = Math.floor(from / dayMs) * dayMs + 3 * 3_600_000;
  return new Date(at3 > from ? at3 : at3 + dayMs);
};

// 2026-07-26T00:00:00Z.
const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
});

// Both slots are process-global; a leaked one reroutes every later enqueue in this process.
afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});

describe('a fire on the instrumentation bus', () => {
  afterEach(() => {
    resetInstrumentation();
    resetTelemetry();
  });

  test('each fired job is one job.enqueue, under one producer span its run will be a child of', async () => {
    const sendReport = job({
      tenant: 'none',
      name: 'sendReport',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'report',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    task({
      name: 'nightlyReport',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[sendReport, {}]],
    });
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const scheduler = jobScheduler({ driver, clock, cron: dailyAt3 });
    const seen: JobEnqueueEvent[] = [];
    const spans: ReadableSpan[] = [];
    subscribe('job.enqueue', (event) => seen.push(event.payload));
    subscribe('span.end', (event) => spans.push(event.payload));

    await scheduler.tick();
    clock.advance(4 * 3_600_000);
    const [dispatched] = await scheduler.tick();

    expect(seen).toEqual([
      { job: 'sendReport', queue: sendReport.queue, id: dispatched?.jobs[0]?.result.id ?? '' },
    ]);
    const producer = spans.find((span) => span.kind === 'producer');
    expect(producer?.name).toBe('job.nightlyReport.enqueue');
    const [row] = (await driver.introspect?.list()) ?? [];
    expect(row?.traceparent).toContain(producer?.context.spanId ?? 'no producer');
  });
});
