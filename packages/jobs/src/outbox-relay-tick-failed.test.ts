// The relay through a database restart: every pass's claim fails until it is back, and the relay
// retries at its floor — but the log says so once, then once more on recovery with the count.
// Fake time fires the relay's own timer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import { memoryJobDriver } from './driver-memory';
import { DriverUnavailableError } from './errors';
import { useFakeTime } from './fake-time-fixture';
import type { OutboxStore } from './outbox';
import { memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';

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
});

describe('an outbox relay through a database restart', () => {
  test('logs the first failed pass and the recovery, never a line per pass', async () => {
    const inner = memoryOutboxStore();
    let down = true;
    let claims = 0;
    const store: OutboxStore = {
      ...inner,
      claim(limit, options) {
        claims += 1;
        if (down) {
          const error = new DriverUnavailableError({ driver: 'pg', cause: 'restart', fix: 'wait' });
          return Promise.reject(error);
        }
        return inner.claim(limit, options);
      },
    };
    const relay = outboxRelay({
      driver: memoryJobDriver(),
      store,
      intervalMs: 10,
      drainOnShutdown: false,
    });
    relay.start();
    await time.advance(500, 10);
    const failedPasses = claims;
    down = false;
    await time.advance(100, 10);
    await time.settles(relay.stop(), 1_000);

    expect(failedPasses).toBeGreaterThan(5);
    const ticks = events.filter((event) => event.startsWith('jobs.outbox.tick-'));
    expect(ticks).toEqual(['jobs.outbox.tick-failed', 'jobs.outbox.tick-recovered']);
  });
});
