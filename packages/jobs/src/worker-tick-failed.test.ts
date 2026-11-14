// A worker through a database restart: every claim pass fails until it is back, and the loop
// retries at its floor — but the log says so once, then once more on recovery with the count.
// A line per pass buried the one that said why (production, 2026-11-14). Fake time fires the
// loop's own timers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, installLogSink } from '@ultimat3/core';
import { resetJobDriver } from './adapter';
import type { ClaimedJob, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { DriverUnavailableError } from './errors';
import { useFakeTime } from './fake-time-fixture';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { jobWorker } from './worker';

const time = useFakeTime();

const events: string[] = [];
let releaseLogSink: () => void = () => undefined;

beforeEach(() => {
  events.length = 0;
  releaseLogSink = installLogSink((line) => {
    const parsed = JSON.parse(line) as { msg?: string; event?: string };
    events.push(parsed.msg ?? parsed.event ?? line);
  });
});

afterEach(() => {
  releaseLogSink();
  resetJobDriver();
  resetJobs();
});

describe('a worker through a database restart', () => {
  test('logs the first failed pass and the recovery, never a line per pass', async () => {
    itemJob({ run: () => Promise.resolve() });
    const base = memoryJobDriver();
    let down = true;
    let claims = 0;
    const driver: JobDriver = {
      ...base,
      claim(options): Promise<readonly ClaimedJob[]> {
        claims += 1;
        if (down) {
          const error = new DriverUnavailableError({ driver: 'pg', cause: 'restart', fix: 'wait' });
          return Promise.reject(error);
        }
        return base.claim(options);
      },
    };
    const worker = jobWorker({
      driver,
      pollIntervalMs: 10,
      drainOnShutdown: false,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    });
    worker.start();
    await time.advance(500, 10);
    const failedPasses = claims;
    down = false;
    await time.advance(100, 10);
    await time.settles(worker.stop(), 1_000);

    expect(failedPasses).toBeGreaterThan(5);
    const ticks = events.filter((event) => event.startsWith('jobs.worker.tick-'));
    expect(ticks).toEqual(['jobs.worker.tick-failed', 'jobs.worker.tick-recovered']);
  });

  test("a restarted worker opens its own streak: a stopped run's is not carried over", async () => {
    itemJob({ run: () => Promise.resolve() });
    const base = memoryJobDriver();
    const driver: JobDriver = {
      ...base,
      claim: () =>
        Promise.reject(new DriverUnavailableError({ driver: 'pg', cause: 'down', fix: 'wait' })),
    };
    const worker = jobWorker({
      driver,
      pollIntervalMs: 10,
      drainOnShutdown: false,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    });
    worker.start();
    await time.advance(100, 10);
    await time.settles(worker.stop(), 1_000);
    worker.start();
    await time.advance(100, 10);
    await time.settles(worker.stop(), 1_000);

    const ticks = events.filter((event) => event.startsWith('jobs.worker.tick-'));
    expect(ticks).toEqual(['jobs.worker.tick-failed', 'jobs.worker.tick-failed']);
  });
});
