// `registeredJobs()` is read by every claim (`dropExhausted`), so it answers one sorted list until
// the registry changes, and a fresh one the moment it does — a sort per claim was the cost.

import { afterEach, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { job, registeredJobs, resetJobs, restoreJobs } from './job';

afterEach(() => {
  resetJobs();
});

const declare = (name: string) =>
  job({
    name,
    tenant: 'none',
    input: t.object({}),
    idempotencyKey: () => name,
    retry: { attempts: 1 },
    run: async () => undefined,
  });

test('the same list until the registry changes, then the change in order', () => {
  resetJobs();
  declare('cacheB');
  const first = registeredJobs();
  expect(registeredJobs()).toBe(first);
  const a = declare('cacheA');
  const second = registeredJobs();
  expect(second).not.toBe(first);
  expect(second.map((handle) => handle.name)).toEqual(['cacheA', 'cacheB']);
  restoreJobs([a]);
  expect(registeredJobs().map((handle) => handle.name)).toEqual(['cacheA']);
  resetJobs();
  expect(registeredJobs()).toEqual([]);
});
