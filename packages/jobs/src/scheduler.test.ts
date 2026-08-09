import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import type { CronResolver, LeaderElection } from './scheduler';
import {
  createMemorySchedulerState,
  createScheduler,
  registeredTasks,
  resetTasks,
  task,
} from './scheduler';

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

/** The UTC calendar date of an instant — what a real digest payload keys itself on. */
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface DatedInput {
  readonly runDate: string;
}

/** A job whose payload names a day, so a payload built for the wrong day is visible. */
function datedDigestJob(): JobHandle<DatedInput> {
  return job<DatedInput>({
    name: 'datedDigest',
    input: passthrough<DatedInput>(),
    idempotencyKey: ({ runDate }) => `digest:${runDate}`,
    retry: { attempts: 3 },
    run: () => Promise.resolve(),
  });
}

let sendDigest: JobHandle<Record<string, never>>;
let sweepLogs: JobHandle<Record<string, never>>;

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
  sendDigest = job<Record<string, never>>({
    name: 'sendDigest',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'digest',
    retry: { attempts: 3 },
    run: () => Promise.resolve(),
  });
  sweepLogs = job<Record<string, never>>({
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

  test('an empty tz is refused at runtime as well as by the type', () => {
    expect(() => task({ name: 'bad', cron: '0 3 * * *', tz: '', enqueue: () => [] })).toThrow();
  });

  test('a non-empty string that is not an IANA zone is refused too', () => {
    expect(() =>
      task({ name: 'nowhere', cron: '0 3 * * *', tz: 'Not/AZone', enqueue: () => [] }),
    ).toThrow('X_INVARIANT');
    // The city alone is the mistake this catches: it would resolve every occurrence in UTC.
    expect(() =>
      task({ name: 'bogota', cron: '0 3 * * *', tz: 'Bogota', enqueue: () => [] }),
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
    expect(fired.every((entry) => entry.result.deduped)).toBe(false);
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
    // double-firing a tick, and a manual run has no occurrence to scope itself to.
    expect(((await driver.introspect?.list()) ?? []).map((row) => row.idempotencyKey)).toEqual([
      'digest',
      `nightlyDigest:${occurrenceMs}:digest`,
    ]);
  });
});

describe('scheduler', () => {
  test('nextRunFor honours the task tz — 03:00 New York is not 03:00 UTC', () => {
    const nightly = task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      enqueue: () => [[sendDigest, {}]],
    });
    const utc = task({
      name: 'utcDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[sendDigest, {}]],
    });
    const scheduler = createScheduler({
      driver: createMemoryDriver(),
      clock: fakeClock(T0),
      cron: dailyAt3,
    });

    expect(scheduler.nextRunFor(utc).toISOString()).toBe('2026-07-26T03:00:00.000Z');
    expect(scheduler.nextRunFor(nightly).toISOString()).toBe('2026-07-26T08:00:00.000Z');
  });

  test('dispatches once per occurrence and enqueues the task jobs', async () => {
    task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[sendDigest, {}]],
    });
    const clock = fakeClock(T0);
    const driver = createMemoryDriver({ clock });
    const scheduler = createScheduler({ driver, clock, cron: dailyAt3 });

    // First tick arms the task; it must not fire retroactively.
    expect(await scheduler.tick()).toEqual([]);
    expect(await scheduler.tick()).toEqual([]);

    clock.advance(4 * 3_600_000); // 04:00 UTC — 03:00 has passed.
    const dispatched = await scheduler.tick();
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.task).toBe('nightlyDigest');
    expect(new Date(dispatched[0]?.occurrenceMs ?? 0).toISOString()).toBe(
      '2026-07-26T03:00:00.000Z',
    );
    expect(dispatched[0]?.jobs[0]?.job).toBe('sendDigest');

    // Same occurrence must never fire twice.
    expect(await scheduler.tick()).toEqual([]);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);
  });

  test('catch-up: "skip" fires only the latest missed occurrence, "run-all" fires each', async () => {
    const clock = fakeClock(T0);
    const driver = createMemoryDriver({ clock });
    const state = createMemorySchedulerState();
    const skipping = task({
      name: 'skipDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      catchUp: 'skip',
      enqueue: () => [[sendDigest, {}]],
    });
    const catching = task({
      name: 'catchAllDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      catchUp: 'run-all',
      enqueue: () => [[sendDigest, {}]],
    });
    const scheduler = createScheduler({
      driver,
      clock,
      cron: dailyAt3,
      state,
      tasks: [skipping, catching],
    });

    await scheduler.tick();
    // The scheduler was down for three days.
    clock.advance(3 * 86_400_000 + 4 * 3_600_000);
    const dispatched = await scheduler.tick();

    const bySkipping = dispatched.filter((entry) => entry.task === 'skipDigest');
    const byCatching = dispatched.filter((entry) => entry.task === 'catchAllDigest');
    expect(bySkipping.length).toBe(1);
    expect(new Date(bySkipping[0]?.occurrenceMs ?? 0).toISOString()).toBe(
      '2026-07-29T03:00:00.000Z',
    );
    expect(byCatching.length).toBe(4);
  });

  test('a late dispatch builds its payload from the occurrence, not the wall clock', async () => {
    const dated = datedDigestJob();
    const nightly = task({
      name: 'datedNightly',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: (occurrenceMs) => [[dated, { runDate: utcDate(occurrenceMs) }]],
    });
    const clock = fakeClock(T0);
    const driver = createMemoryDriver({ clock });
    const scheduler = createScheduler({ driver, clock, cron: dailyAt3, tasks: [nightly] });

    await scheduler.tick(); // Arms it for 2026-07-26T03:00Z.
    // Down for 25 hours: the missed occurrence is still the 26th, but the worker's wall clock
    // has crossed midnight into the 27th. Deriving the payload from "now" here dates the
    // digest a day forward, and the scheduler's occurrence-scoped key hides it.
    clock.advance(25 * 3_600_000);
    const dispatched = await scheduler.tick();

    expect(utcDate(clock.now().getTime())).toBe('2026-07-27');
    expect(new Date(dispatched[0]?.occurrenceMs ?? 0).toISOString()).toBe(
      '2026-07-26T03:00:00.000Z',
    );
    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows.map((row) => dated.parse(row.input).runDate)).toEqual(['2026-07-26']);
    expect(rows[0]?.idempotencyKey).toBe(
      `datedNightly:${dispatched[0]?.occurrenceMs}:digest:2026-07-26`,
    );
  });

  test('catch-up gives every missed occurrence a payload for its own day', async () => {
    const dated = datedDigestJob();
    const nightly = task({
      name: 'datedNightly',
      cron: '0 3 * * *',
      tz: 'UTC',
      catchUp: 'run-all',
      enqueue: (occurrenceMs) => [[dated, { runDate: utcDate(occurrenceMs) }]],
    });
    const clock = fakeClock(T0);
    const driver = createMemoryDriver({ clock });
    const scheduler = createScheduler({ driver, clock, cron: dailyAt3, tasks: [nightly] });

    await scheduler.tick();
    clock.advance(3 * 86_400_000 + 4 * 3_600_000); // Down three days.
    expect((await scheduler.tick()).length).toBe(4);

    const rows = (await driver.introspect?.list()) ?? [];
    // Four days, four payloads. One shared wall-clock date would be four copies of the same
    // digest wearing four different occurrence keys — a duplicate nothing can dedupe.
    expect(
      rows
        .slice()
        .sort((a, b) => a.runAt - b.runAt)
        .map((row) => dated.parse(row.input).runDate),
    ).toEqual(['2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29']);
  });

  test('a node that loses the advisory lock dispatches nothing', async () => {
    task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[sendDigest, {}]],
    });
    const clock = fakeClock(T0);
    const follower: LeaderElection = {
      acquire: () => Promise.resolve(false),
      release: () => Promise.resolve(),
    };
    const driver = createMemoryDriver({ clock });
    const scheduler = createScheduler({ driver, clock, cron: dailyAt3, leader: follower });

    await scheduler.tick();
    clock.advance(4 * 3_600_000);
    expect(await scheduler.tick()).toEqual([]);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(0);
  });
});
