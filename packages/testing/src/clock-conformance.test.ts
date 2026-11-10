// The sleep-clock suite over core's three clocks — the system one, the frozen one a test runs on
// and the one that waits a loop turn — and the proof it can fail: a clock that wraps the abort
// reason in its own error, and one that never takes its abort listener back off a long-lived
// signal.

import { describe, expect, test } from 'bun:test';
import type { SleepClock } from '@ultimat3/core';
import { frozenClock, noWaitClock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core/adapter';
import { SLEEP_CLOCK_CHECKS, sleepClockConformance } from './clock-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the system sleep clock'), () => {
  behavesLike(sleepClockConformance, () => systemClock);
});

describe(testName('unit', 'the frozen clock'), () => {
  behavesLike(sleepClockConformance, () => frozenClock('2026-11-09T00:00:00Z'));
});

describe(testName('unit', 'the no-wait clock'), () => {
  behavesLike(sleepClockConformance, () => noWaitClock);
});

/** Rejects with a value of its own: the caller's code and fix line are gone. */
const wrapping: SleepClock = {
  now: () => systemClock.now(),
  monotonic: () => systemClock.monotonic(),
  sleep: (ms, signal) =>
    systemClock.sleep(ms, signal).catch((reason: unknown) => Promise.reject({ aborted: reason })),
};

/** Waits correctly, and leaves one `abort` listener behind per sleep. */
const leaking: SleepClock = {
  now: () => systemClock.now(),
  monotonic: () => systemClock.monotonic(),
  sleep: (ms, signal) => {
    signal?.addEventListener('abort', () => undefined);
    return systemClock.sleep(ms, signal);
  },
};

const check = (prefix: string) => {
  const found = SLEEP_CLOCK_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no sleep-clock check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a clock that breaks the contract fails conformance'), () => {
  test('a wrapped abort reason fails both abort checks', async () => {
    await expect(check('an already-aborted signal').run(wrapping)).rejects.toThrow();
    await expect(check('an abort while the sleep is pending').run(wrapping)).rejects.toThrow();
  });

  test('a listener left on the signal fails the leak check, and only that one', async () => {
    await expect(check('a sleep that completed').run(leaking)).rejects.toThrow();
    await check('an abort while the sleep is pending').run(leaking);
  });

  test('every check has a name of its own', () => {
    const names = SLEEP_CLOCK_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
