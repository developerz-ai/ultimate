// `JobDriver.enqueueMany` on the memory driver, under an injected clock. The same scenarios run on
// Postgres in `enqueue-many.job.test.ts` and on Redis in `driver-redis.live.test.ts`.

import { describe } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { driverEnqueueManyScenarios, introspectedHarness } from './driver-enqueue-many-fixture';
import { memoryJobDriver } from './driver-memory';

const clock = frozenClock('2026-10-01T00:00:30.000Z');

describe('what enqueueMany answers, on the memory driver', () => {
  driverEnqueueManyScenarios(
    'memory',
    introspectedHarness(
      () => Promise.resolve(memoryJobDriver({ clock })),
      () => Promise.resolve(clock.now().getTime()),
    ),
  );
});
