import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from './client-scope';
import { clientTransport } from './client-transport';
import { onSessionLost } from './session-lost';
import type { IntervalHost } from './visible-interval';
import { visibleInterval, visibleIntervalOn } from './visible-interval';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

/** Lets a settled run's handlers, and an unhandled rejection's report, run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** An injected tab: a timer queue run by hand and a visibility flag with its one event. */
function fakeHost(): IntervalHost & {
  hidden: boolean;
  waits: number[];
  fire(): void;
  show(): void;
  hide(): void;
  armed(): number;
  listeners(): number;
} {
  let next = 1;
  const timers = new Map<number, () => void>();
  const handlers = new Set<() => void>();
  const host = {
    hidden: false,
    waits: [] as number[],
    setTimer(fn: () => void, ms: number): number {
      host.waits.push(ms);
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimer(id: number): void {
      timers.delete(id);
    },
    isHidden: (): boolean => host.hidden,
    onVisibility(fn: () => void): () => void {
      handlers.add(fn);
      return (): void => {
        handlers.delete(fn);
      };
    },
    random: (): number => 1,
    fire(): void {
      const due = [...timers];
      timers.clear();
      for (const [, fn] of due) fn();
    },
    show(): void {
      host.hidden = false;
      for (const fn of [...handlers]) fn();
    },
    hide(): void {
      host.hidden = true;
      for (const fn of [...handlers]) fn();
    },
    armed: (): number => timers.size,
    listeners: (): number => handlers.size,
  };
  return host;
}

describe('visibleInterval', () => {
  test('calls once per wait while the tab is shown', () => {
    const host = fakeHost();
    let calls = 0;
    visibleIntervalOn(host, () => (calls += 1), 1000);
    expect(calls).toBe(0);
    host.fire();
    host.fire();
    expect(calls).toBe(2);
    expect(host.waits).toEqual([1000, 1000, 1000]);
  });

  test('a hidden tab makes no call and arms no timer, then pays exactly once when shown', () => {
    const host = fakeHost();
    let calls = 0;
    visibleIntervalOn(host, () => (calls += 1), 1000);
    host.hide();
    host.fire();
    expect(calls).toBe(0);
    expect(host.armed()).toBe(0);
    host.show();
    host.show();
    expect(calls).toBe(1);
    expect(host.armed()).toBe(1);
  });

  test('shown again before anything was owed calls nothing extra', () => {
    const host = fakeHost();
    let calls = 0;
    visibleIntervalOn(host, () => (calls += 1), 1000);
    host.hide();
    host.show();
    expect(calls).toBe(0);
  });

  test('maxMs: a healthy poll keeps the base wait, however many calls succeed', async () => {
    const host = fakeHost();
    visibleIntervalOn(host, async () => {}, 1000, { maxMs: 8000 });
    for (let i = 0; i < 4; i += 1) {
      host.fire();
      await flush();
    }
    expect(host.waits).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  test('maxMs: each failed or rejected run doubles the wait to the ceiling; a success resets it', async () => {
    const host = fakeHost();
    const outcomes = ['reject', 'throw', 'reject', 'reject', 'ok'];
    // What `run` throws is this test's input, and any value at all must survive the re-raise.
    const thrown: unknown = 'sync';
    const raised: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task: () => void): void =>
      original(() => {
        try {
          task();
        } catch (error) {
          raised.push(error);
        }
      });
    try {
      visibleIntervalOn(
        host,
        () => {
          const outcome = outcomes.shift();
          if (outcome === 'throw') throw thrown;
          return outcome === 'reject' ? Promise.reject('async') : Promise.resolve();
        },
        1000,
        { maxMs: 5000 },
      );
      for (let i = 0; i < 5; i += 1) {
        host.fire();
        await flush();
      }
      expect(host.waits).toEqual([1000, 2000, 4000, 5000, 5000, 1000]);
      // No failure is swallowed: each is re-raised once, off the loop's stack.
      expect(raised).toEqual(['async', 'sync', 'async', 'async']);
    } finally {
      globalThis.queueMicrotask = original;
    }
  });

  test('an async run is never overlapped: the next wait starts when it settles', async () => {
    const host = fakeHost();
    let release: () => void = () => {};
    let calls = 0;
    visibleIntervalOn(
      host,
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          release = resolve;
        }),
      1000,
    );
    host.fire();
    expect(host.armed()).toBe(0);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.armed()).toBe(1);
    expect(calls).toBe(1);
  });

  test('the disposer is idempotent and leaves zero timers and zero listeners', () => {
    const host = fakeHost();
    const stop = visibleIntervalOn(host, () => {}, 1000);
    expect(host.listeners()).toBe(1);
    stop();
    stop();
    expect(host.armed()).toBe(0);
    expect(host.listeners()).toBe(0);
  });

  test('a session loss stops it: one 401 on a scoped page and no further call', async () => {
    rescope('user:1');
    const host = fakeHost();
    let calls = 0;
    visibleIntervalOn(host, () => (calls += 1), 1000);
    let told = 0;
    onSessionLost(() => (told += 1));
    await clientTransport({
      method: 'GET',
      url: '/q/feed',
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 'X_UNAUTHENTICATED', cause: 'c', fix: 'f' }), {
          status: 401,
        }),
    }).catch(() => undefined);
    expect(told).toBe(1);
    expect(host.armed()).toBe(0);
    expect(host.listeners()).toBe(0);
    host.fire();
    host.show();
    expect(calls).toBe(0);
  });

  test('started after the loss, it is a no-op from the first moment', async () => {
    rescope('user:1');
    await clientTransport({
      method: 'GET',
      url: '/q/feed',
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 'X_SESSION_EXPIRED', cause: 'c', fix: 'f' }), {
          status: 401,
        }),
    }).catch(() => undefined);
    const host = fakeHost();
    const stop = visibleIntervalOn(host, () => {}, 1000);
    expect(host.armed()).toBe(0);
    expect(host.listeners()).toBe(0);
    stop();
  });

  test('a non-finite wait is refused, never armed as zero', () => {
    const host = fakeHost();
    expect(() => visibleIntervalOn(host, () => {}, Number.NaN)).toThrow(/ms is NaN/);
    expect(() => visibleIntervalOn(host, () => {}, 10, { maxMs: Number.NaN })).toThrow(/maxMs/);
  });

  test('the default host runs with no document (a server, a test) and stops cleanly', () => {
    const stop = visibleInterval(() => {}, 60_000);
    stop();
  });

  test('maxMs: a success waits exactly ms, never a jittered fraction of it', async () => {
    const host = { ...fakeHost(), random: (): number => 0 };
    const waits: number[] = [];
    const base = host.setTimer;
    host.setTimer = (fn: () => void, ms: number): unknown => {
      waits.push(ms);
      return base(fn, ms);
    };
    visibleIntervalOn(host, async () => {}, 1000, { maxMs: 8000 });
    host.fire();
    await flush();
    expect(waits).toEqual([1000, 1000]);
  });
});

describe('visibleInterval across sessions', () => {
  test('stopped by a loss, it polls again once a principal signs back in', async () => {
    rescope('user:1');
    const host = fakeHost();
    let calls = 0;
    const stop = visibleIntervalOn(host, () => (calls += 1), 1000);
    await clientTransport({
      method: 'GET',
      url: '/q/feed',
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 'X_UNAUTHENTICATED', cause: 'c', fix: 'f' }), {
          status: 401,
        }),
    }).catch(() => undefined);
    expect(host.armed()).toBe(0);
    rescope('user:2');
    expect(host.armed()).toBe(1);
    expect(host.listeners()).toBe(1);
    host.fire();
    expect(calls).toBe(1);
    stop();
    expect(host.armed()).toBe(0);
    expect(host.listeners()).toBe(0);
  });
});
