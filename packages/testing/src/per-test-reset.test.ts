// State the preload puts back before EVERY test, not every file. Two tests here publish and read
// one event name: without the reset the second reads the first's answer — exactly how a prompt a
// test answered resumed the next test's waiting run.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installedRateLimitStore, memoryRateLimitStore } from '@ultimat3/http';
import { installRateLimitStore } from '@ultimat3/http/adapter';
import { eventBus, memoryEventBus, publishEvent } from '@ultimat3/jobs';
import { installEventBus } from '@ultimat3/jobs/adapter';
import { installPerTestReset } from './per-test-reset';
import { testName } from './test-types';

// What the app preload does once per process; the framework repository's own preload is another
// file, so this one installs it for itself. Installing twice registers one hook.
installPerTestReset();
installPerTestReset();

describe(testName('unit', 'the event bus is the test’s own'), () => {
  test('a test publishes an answer under a shared name', async () => {
    await publishEvent('prompt.answered', { answer: 'yes' }, { correlationKey: 'run-1' });
    expect(await eventBus().list('prompt.answered')).toHaveLength(1);
  });

  test('the next test sees none of it', async () => {
    expect(await eventBus().list('prompt.answered')).toEqual([]);
    await publishEvent('prompt.answered', { answer: 'no' }, { correlationKey: 'run-1' });
    expect(await eventBus().list('prompt.answered')).toHaveLength(1);
  });
});

// The installed rate-limit store is read per request (`httpServer`, actions, queries), so a bucket
// one test drained answered the next test in the same file with a 429. Each test spends the WHOLE
// limit here; only a per-test reset lets the second one through.
describe(testName('unit', 'the rate-limit store is the test’s own'), () => {
  const bucket = { capacity: 2, refillPerSecond: 0 };
  const spendAll = async (): Promise<readonly boolean[]> => {
    const store = installedRateLimitStore();
    const now = Date.now();
    const answers: boolean[] = [];
    for (let i = 0; i < 3; i += 1) answers.push((await store.take('ip:1', bucket, 1, now)).allowed);
    return answers;
  };

  test('a test spends the full limit', async () => {
    expect(await spendAll()).toEqual([true, true, false]);
  });

  test('the next test has the full limit again', async () => {
    expect(await spendAll()).toEqual([true, true, false]);
  });
});

// The per-test reset empties the DEFAULT buckets only: a store a file installs once, in
// `beforeAll` (a booted app's, a suite's own), is still the one every test spends from.
describe(testName('unit', 'a store installed for the file survives every test'), () => {
  const mine = memoryRateLimitStore();
  let release: (() => void) | undefined;
  beforeAll(() => {
    release = installRateLimitStore(mine);
  });
  afterAll(() => release?.());

  test('the first test reads it', () => {
    expect(installedRateLimitStore()).toBe(mine);
  });

  test('the second test still reads it', () => {
    expect(installedRateLimitStore()).toBe(mine);
  });
});

// The per-test reset freshens the DEFAULT bus only: a bus a file installs once, in `beforeAll`, is
// still the one every test publishes to and reads from.
describe(testName('unit', 'a bus installed for the file survives every test'), () => {
  const mine = memoryEventBus();
  let release: (() => void) | undefined;
  beforeAll(() => {
    release = installEventBus(mine);
  });
  afterAll(() => release?.());

  test('the first test reads it', () => {
    expect(eventBus()).toBe(mine);
  });

  test('the second test still reads it', () => {
    expect(eventBus()).toBe(mine);
  });
});
