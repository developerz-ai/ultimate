// A request's deadline signal is undone when the request settles: the timer cleared, the caller's
// session-long signal let go. `AbortSignal.any` per hop left one listener on that signal per hop
// of every request for the life of the run, and an armed timer per request behind it.

import { describe, expect, test } from 'bun:test';
import { testScrapeClock } from './clock';
import { type DeadlineTimer, deadlineSignal } from './deadline-signal';
import { httpOverFetch } from './http';
import type { NetworkEntry } from './rings';
import { boundedRing } from './rings';
import { robotsFetcher } from './robots-fetch';
import { EMPTY_SESSION } from './session-state';

/** A signal that counts the listeners still attached to it. */
function countedSignal(): { signal: AbortSignal; attached: () => number; abort(): void } {
  const controller = new AbortController();
  const live = new Set<unknown>();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    live.add(listener);
    add(type, listener, options as AddEventListenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListener) => {
    live.delete(listener);
    remove(type, listener);
  }) as typeof signal.removeEventListener;
  return { signal, attached: () => live.size, abort: () => controller.abort('cancelled') };
}

/** A timer nothing really waits on: `fire()` is the deadline passing. */
function manualTimer(): DeadlineTimer & { armed: () => number; made: () => number; fire(): void } {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    made: () => next,
    set: (fire) => {
      next += 1;
      pending.set(next, fire);
      return next;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
    armed: () => pending.size,
    fire: () => {
      for (const fire of [...pending.values()]) fire();
    },
  };
}

const answer = (): Promise<Response> => Promise.resolve(new Response('{"ok":true}'));

describe('unit · deadlineSignal', () => {
  test('a request that settles leaves no listener on the outer signal and no armed timer', async () => {
    const outer = countedSignal();
    const timer = manualTimer();
    const http = httpOverFetch({
      rules: { allowHosts: ['api.test'] },
      clock: testScrapeClock(),
      timeoutMs: 1_000,
      network: boundedRing<NetworkEntry>(),
      session: () => Promise.resolve(EMPTY_SESSION),
      signal: outer.signal,
      timer,
      fetch: () => {
        during.push(outer.attached());
        return answer();
      },
    });
    const during: number[] = [];
    for (let n = 0; n < 50; n += 1) await http.request(`https://api.test/orders/${n}`);
    // Followed while in flight — one listener, one timer per request — and let go once settled.
    expect(new Set(during)).toEqual(new Set([1]));
    expect(timer.made()).toBe(50);
    expect(outer.attached()).toBe(0);
    expect(timer.armed()).toBe(0);
  });

  test('a robots read that settles leaves nothing attached either', async () => {
    const outer = countedSignal();
    const timer = manualTimer();
    const during: number[] = [];
    const fetch = (): Promise<Response> => {
      during.push(outer.attached());
      return answer();
    };
    const read = robotsFetcher({ signal: outer.signal, timer, fetch });
    for (let n = 0; n < 50; n += 1) await read(`https://site-${n}.test/robots.txt`);
    expect(new Set(during)).toEqual(new Set([1]));
    expect(timer.made()).toBe(50);
    expect(outer.attached()).toBe(0);
    expect(timer.armed()).toBe(0);
  });

  test('the deadline aborts as a timeout; the outer signal aborts as itself', () => {
    const timer = manualTimer();
    const outer = countedSignal();
    using timed = deadlineSignal(1_000, outer.signal, timer);
    timer.fire();
    expect(timed.signal.aborted).toBe(true);
    expect(timed.timedOut()).toBe(true);
    expect((timed.signal.reason as DOMException).name).toBe('TimeoutError');

    const cancelled = deadlineSignal(1_000, outer.signal, manualTimer());
    outer.abort();
    expect(cancelled.signal.aborted).toBe(true);
    expect(cancelled.timedOut()).toBe(false);
    expect(cancelled.signal.reason).toBe('cancelled');
    cancelled[Symbol.dispose]();
  });

  test('an outer signal already aborted aborts at once, and nothing is attached to it', () => {
    const outer = countedSignal();
    outer.abort();
    using composed = deadlineSignal(1_000, outer.signal, manualTimer());
    expect(composed.signal.aborted).toBe(true);
    expect(outer.attached()).toBe(0);
  });
});
