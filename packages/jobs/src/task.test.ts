// The `task` primitive: its declaration rules (an IANA tz is not optional and not a city name),
// the name the registry seats it under, and the key a manual `enqueue()` fires with.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import type { CronResolver } from './scheduler';
import { createScheduler } from './scheduler';
import { getTask, registeredTasks, resetTasks, task } from './task';

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

/** Deterministic stand-in for @ultimat3/time: fires daily at 03:00 in the task's zone. */
const dailyAt3: CronResolver = (cron, options) => {
  expect(cron).toBe('0 3 * * *');
  const offsetMs = options.tz === 'America/New_York' ? 5 * 3_600_000 : 0;
  const dayMs = 86_400_000;
  const from = options.from.getTime();
  const midnight = Math.floor((from - offsetMs) / dayMs) * dayMs + offsetMs;
  const at3 = midnight + 3 * 3_600_000;
  return new Date(at3 > from ? at3 : at3 + dayMs);
};

// 2026-07-26T00:00:00Z, a Sunday.
const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

let sendDigest: JobHandle<Record<string, never>>;
let sweepLogs: JobHandle<Record<string, never>>;

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
  sendDigest = job<Record<string, never>>({
    tenant: 'none',
    name: 'sendDigest',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'digest',
    retry: { attempts: 3 },
    run: () => Promise.resolve(),
  });
  sweepLogs = job<Record<string, never>>({
    tenant: 'none',
    name: 'sweepLogs',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'sweep',
    retry: { attempts: 2 },
    run: () => Promise.resolve(),
  });
});

// Both slots are process-global; a leaked one reroutes every later enqueue in this process.
afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});
describe('task', () => {
  test('registers with its explicit tz — a cron without one is a build error by type', () => {
    const nightlyDigest = task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      enqueue: () => [[sendDigest, {}]],
    });
    expect(nightlyDigest.tz).toBe('America/New_York');
    expect(registeredTasks().map((handle) => handle.name)).toEqual(['nightlyDigest']);
  });

  test('registeredTasks() orders by CODE UNITS, not by the runtime locale', () => {
    // Same reason as `registeredJobs()`: this list reaches a committed build artefact, and
    // `localeCompare` with no locale argument is a function of the runtime's ICU collation.
    for (const name of ['aDigest', 'BDigest', '_sweep']) {
      task({ name, cron: '0 3 * * *', tz: 'UTC', enqueue: () => [[sendDigest, {}]] });
    }

    expect(registeredTasks().map((handle) => handle.name)).toEqual([
      'BDigest',
      '_sweep',
      'aDigest',
    ]);
  });

  test('an empty tz is refused at runtime as well as by the type', () => {
    expect(() => task({ name: 'bad', cron: '0 3 * * *', tz: '', enqueue: () => [] })).toThrow();
  });

  // `registerTasks(module)` is what gives a task its export name; `task()` on its own is
  // unchanged, and must stay so — 1.0.0 semver, and every existing caller declares only.
  test('an unregistered task still takes a positional name and still schedules under it', () => {
    const orphan = task({ cron: '0 3 * * *', tz: 'UTC', enqueue: () => [[sendDigest, {}]] });

    expect(orphan.name).toMatch(/^anonymous-task-\d+$/);
    expect(getTask(orphan.name)).toBe(orphan);
    expect(orphan.describe().name).toBe(orphan.name);
    expect(registeredTasks().map((handle) => handle.name)).toEqual([orphan.name]);
  });

  test('a non-empty string that is not an IANA zone is refused too', () => {
    expect(() =>
      task({ name: 'nowhere', cron: '0 3 * * *', tz: 'Not/AZone', enqueue: () => [] }),
    ).toThrow('X_INVARIANT');
    // The city alone is the mistake this catches: it would resolve every occurrence in UTC.
    expect(() =>
      task({ name: 'bogota', cron: '0 3 * * *', tz: 'Bogota', enqueue: () => [] }),
    ).toThrow('X_INVARIANT');
    // ES2024 `Intl` ACCEPTS a numeric offset, so a bare `Intl` probe would let this through — and
    // a fixed offset has no DST rules, which is the one thing a cron's timezone is for.
    expect(() =>
      task({ name: 'offset', cron: '0 3 * * *', tz: '+02:00', enqueue: () => [] }),
    ).toThrow('X_INVARIANT');
    expect(() =>
      task({ name: 'offsetShort', cron: '0 3 * * *', tz: '-0500', enqueue: () => [] }),
    ).toThrow('X_INVARIANT');
    expect(() =>
      task({ name: 'newYork', cron: '0 3 * * *', tz: 'America/New_York', enqueue: () => [] }),
    ).not.toThrow();
  });

  test('describe() is JSON-safe and lists its jobs in declaration order', () => {
    const nightly = task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      catchUp: 'run-once',
      maxCatchUp: 3,
      enqueue: () => [
        [sweepLogs, {}],
        [sendDigest, {}],
      ],
    });

    expect(nightly.describe()).toEqual({
      kind: 'task',
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      catchUp: 'run-once',
      maxCatchUp: 3,
      jobs: ['sweepLogs', 'sendDigest'],
    });
    expect(JSON.parse(JSON.stringify(nightly.describe()))).toEqual(nightly.describe());
  });

  test('enqueue() fires every declared entry now, once each', async () => {
    const clock = fakeClock(T0);
    const driver = createMemoryDriver({ clock });
    setJobDriver(driver);
    const nightly = task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [
        [sendDigest, {}],
        [sweepLogs, {}],
      ],
    });

    const fired = await nightly.enqueue();
    expect(fired.map((entry) => entry.job)).toEqual(['sendDigest', 'sweepLogs']);
    // `some`, not `every`: "once EACH" fails if a SINGLE entry deduped, and `every(...) === false`
    // would pass with one of the two already on the queue.
    expect(fired.some((entry) => entry.result.deduped)).toBe(false);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(2);
  });

  test('a manual enqueue() uses the job plain key; the scheduler stays occurrence-scoped', async () => {
    const clock = fakeClock(T0);
    const driver = createMemoryDriver({ clock });
    setJobDriver(driver);
    const nightly = task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[sendDigest, {}]],
    });
    const scheduler = createScheduler({ driver, clock, cron: dailyAt3 });

    await nightly.enqueue();
    expect(((await driver.introspect?.list()) ?? []).map((row) => row.idempotencyKey)).toEqual([
      'digest',
    ]);

    await scheduler.tick(); // arms the task
    clock.advance(4 * 3_600_000);
    const dispatched = await scheduler.tick();
    const occurrenceMs = dispatched[0]?.occurrenceMs ?? 0;

    // Two rows, two different keys: the occurrence key is what stops two schedulers from
    // double-firing a tick, and a manual run has no occurrence to scope itself to. Newest first —
    // `introspect.list` answers in `createdAt desc` in both drivers, and the dispatched row was
    // enqueued four hours after the manual one.
    expect(((await driver.introspect?.list()) ?? []).map((row) => row.idempotencyKey)).toEqual([
      `nightlyDigest:${occurrenceMs}:digest`,
      'digest',
    ]);
  });
});
