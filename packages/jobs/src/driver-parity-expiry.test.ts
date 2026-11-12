// The expiry scenarios on the memory driver, under an injected clock. The Postgres half is
// `driver-pg-expiry.job.test.ts`, the Redis half `driver-redis-expiry.live.test.ts`.

import { describe } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { driverExpiryScenarios } from './driver-expiry-fixture';
import { memoryJobDriver } from './driver-memory';

const clock = frozenClock('2026-11-12T00:00:00.000Z');

describe('when expiry buries a row, on the memory driver', () => {
  driverExpiryScenarios('memory', {
    driver: () => Promise.resolve(memoryJobDriver({ clock })),
    now: () => Promise.resolve(clock.now().getTime()),
    elapse: (_driver, ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
  });
});
