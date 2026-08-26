// The clock fixture moves process-global state, so what it puts back is the whole subject here.

import { expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
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

// The refusal names `clock.advance`, the knob the test author actually wrote — not `toMs`, which
// is a `@ultimat3/time` internal they never typed and cannot find in their own file (issue #376).
test('a non-finite advance names clock.advance, not the conversion behind it', async () => {
  const clock = await createTestClock();
  try {
    clock.advance(Number.NaN);
    expect.unreachable('advance(NaN) must be refused');
  } catch (error) {
    if (!(error instanceof UltimateError)) throw error;
    expect(error.code).toBe('X_INVARIANT');
    expect(error.fix).toContain('pass a finite duration to clock.advance');
    expect(error.fix).not.toContain('toMs');
  } finally {
    await clock[Symbol.asyncDispose]?.();
  }
});
