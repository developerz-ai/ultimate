// The liveness probe the e2e preload relaunches a browser on: answered, refused, or stalled.

import { expect, test } from 'bun:test';
import { answersWithin } from './e2e-probe';

test('a page that answers is alive', async () => {
  expect(await answersWithin({ evaluate: () => Promise.resolve(1) }, 50)).toBe(true);
});

test('a page whose connection refuses is dead, and the refusal is not rethrown', async () => {
  const refused = { evaluate: () => Promise.reject(new TypeError('socket closed')) };
  expect(await answersWithin(refused, 50)).toBe(false);
});

test('a page that never answers is dead after the budget, not after a CDP deadline', async () => {
  const started = performance.now();
  expect(await answersWithin({ evaluate: () => new Promise(() => undefined) }, 50)).toBe(false);
  expect(performance.now() - started).toBeLessThan(1_000);
});
