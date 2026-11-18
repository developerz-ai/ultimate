// checkOutboundLinks's durable identity: a job, its schedule in an explicit zone, and one live run per
// name. The body is the unit suite's, next door.

import { memoryJobDriver } from '@ultimat3/jobs';
import { beforeAll, expect, jobTest, swapAdapter } from '@ultimat3/testing';
import { checkOutboundLinks } from './check-outbound-links';

// The queue is a process-global adapter port, so it is swapped for this file and put back after.
beforeAll(() => swapAdapter('jobs', memoryJobDriver()));

jobTest('checkOutboundLinks is a job, fired by its own schedule in an explicit zone', () => {
  expect(checkOutboundLinks.kind).toBe('job');
  expect(checkOutboundLinks.schedule.kind).toBe('task');
  expect(checkOutboundLinks.schedule.name).toBe('check-outbound-links.schedule');
  expect(checkOutboundLinks.schedule.tz).toBe('UTC');
  expect(checkOutboundLinks.retry.attempts).toBeGreaterThan(1);
});

jobTest(
  'checkOutboundLinks enqueues once, and dedupes a second run while one is live',
  async () => {
    const first = await checkOutboundLinks.enqueue({});
    expect(first.deduped).toBe(false);
    const again = await checkOutboundLinks.enqueue({});
    expect(again.deduped).toBe(true);
  },
);
