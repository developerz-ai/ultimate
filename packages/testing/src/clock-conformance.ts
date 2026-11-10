// The `clock` port's contract as shared examples: `behavesLike(sleepClockConformance, () => clock)`.
// The abort half is the point: a watchdog aborts a wedged run with an `UltimateError` carrying a
// fix, and a clock that wraps that reason, or keeps waiting, loses both.

import { expect, test } from 'bun:test';
import type { SleepClock } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface SleepClockCheck {
  readonly name: string;
  run(clock: SleepClock): Promise<void>;
}

/** Long enough that a clock which really waits it out fails the test's own timeout instead. */
const AN_HOUR = 3_600_000;

/** What a sleep settled as — its rejection reason kept by identity, never re-rendered. */
const settled = (pending: Promise<void>): Promise<{ readonly reason: unknown } | 'resolved'> =>
  pending.then(
    () => 'resolved' as const,
    (reason: unknown) => ({ reason }),
  );

/** A signal that counts the `abort` listeners still attached to it — the leak a long run pays. */
function countingSignal(): { readonly signal: AbortSignal; attached(): number } {
  const signal = new AbortController().signal;
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, 'addEventListener', {
    value: (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') live.add(listener);
      add(type, listener, options as AddEventListenerOptions);
    },
  });
  Object.defineProperty(signal, 'removeEventListener', {
    value: (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') live.delete(listener);
      remove(type, listener, options as EventListenerOptions);
    },
  });
  return { signal, attached: () => live.size };
}

export const SLEEP_CLOCK_CHECKS: readonly SleepClockCheck[] = [
  {
    name: 'now() is a real instant and monotonic() never runs backwards, across a sleep too',
    async run(clock) {
      const at = clock.now();
      expect(Number.isFinite(at.getTime())).toBe(true);
      const before = clock.monotonic();
      expect(Number.isFinite(before)).toBe(true);
      await clock.sleep(1);
      expect(clock.monotonic()).toBeGreaterThanOrEqual(before);
      expect(clock.now().getTime()).toBeGreaterThanOrEqual(at.getTime());
    },
  },
  {
    name: 'a short sleep with no signal resolves, to nothing',
    async run(clock) {
      expect(await clock.sleep(1)).toBeUndefined();
    },
  },
  {
    name: 'a wait that is not a number is refused X_INVARIANT, as a rejection — never a spin',
    async run(clock) {
      for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const outcome = await settled(clock.sleep(ms));
        const reason = outcome === 'resolved' ? undefined : outcome.reason;
        expect(isUltimateError(reason) ? reason.code : String(reason)).toBe('X_INVARIANT');
      }
    },
  },
  {
    name: 'an already-aborted signal rejects with its reason VERBATIM, and waits for nothing',
    async run(clock) {
      const controller = new AbortController();
      const reason = { cancelledBy: 'the watchdog', stage: 'before the wait' };
      controller.abort(reason);
      const outcome = await settled(clock.sleep(AN_HOUR, controller.signal));
      expect(outcome !== 'resolved' && outcome.reason === reason).toBe(true);
    },
  },
  {
    name: 'an abort while the sleep is pending rejects with that reason, by identity',
    async run(clock) {
      const controller = new AbortController();
      const reason = new Error('the watchdog fired');
      const pending = settled(clock.sleep(AN_HOUR, controller.signal));
      controller.abort(reason);
      const outcome = await pending;
      expect(outcome !== 'resolved' && outcome.reason === reason).toBe(true);
    },
  },
  {
    name: 'aborting one sleep leaves a sibling on another signal to resolve',
    async run(clock) {
      const [doomed, sibling] = [new AbortController(), new AbortController()];
      const cut = settled(clock.sleep(AN_HOUR, doomed.signal));
      const kept = settled(clock.sleep(1, sibling.signal));
      doomed.abort('gone');
      expect([await cut, await kept]).toEqual([{ reason: 'gone' }, 'resolved']);
    },
  },
  {
    name: 'a sleep that completed leaves no abort listener on the signal it was handed',
    async run(clock) {
      const { signal, attached } = countingSignal();
      for (let poll = 0; poll < 5; poll += 1) await clock.sleep(1, signal);
      expect(attached()).toBe(0);
    },
  },
];

export const sleepClockConformance: SharedExamples<SleepClock> = sharedExamples(
  'a sleep clock',
  (subject) => {
    for (const check of SLEEP_CLOCK_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
