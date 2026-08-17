// The clock fixture moves process-global state, so what it puts back is the whole subject here.

import { expect, test } from 'bun:test';
import { frozenNow } from './determinism';
import { createTestClock } from './fixture-clock';
import { runWithFixtures } from './fixtures';

test('clock.advance is undone when the fixture is disposed', async () => {
  const before = frozenNow().getTime();
  const clock = await createTestClock();
  clock.advance('3d');
  expect(frozenNow().getTime()).toBe(before + 3 * 24 * 60 * 60 * 1000);
  await clock[Symbol.asyncDispose]?.();
  expect(frozenNow().getTime()).toBe(before);
});

test('clock.set is undone when the fixture is disposed', async () => {
  const before = frozenNow().getTime();
  const clock = await createTestClock();
  clock.set('2030-06-01T00:00:00.000Z');
  expect(frozenNow().getTime()).not.toBe(before);
  await clock[Symbol.asyncDispose]?.();
  expect(frozenNow().getTime()).toBe(before);
});

// `bun test` is one process: a fixture that advances the clock and never restores it hands the
// advanced clock to every later test FILE in the run, and the failure lands somewhere innocent.
test('a fixtureTest body that advances time leaves the clock where it found it', async () => {
  const before = frozenNow().getTime();
  await runWithFixtures(async ({ clock }) => {
    clock.advance('90d');
    expect(frozenNow().getTime()).toBeGreaterThan(before);
  });
  expect(frozenNow().getTime()).toBe(before);
});
