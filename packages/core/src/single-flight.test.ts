import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, tryUseContext } from './context';
import { UltimateError } from './errors';
import { singleFlight } from './single-flight';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve = (_value: T): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** A scheduler whose timers only fire when the test says so. */
const manualTimers = (): {
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly pending: () => number;
  readonly delays: () => readonly number[];
  readonly fire: () => void;
} => {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return (): void => {
        timer.cancelled = true;
      };
    },
    pending: (): number => timers.filter((one) => !one.cancelled).length,
    delays: (): readonly number[] => timers.map((one) => one.ms),
    fire: (): void => {
      for (const timer of timers) {
        if (!timer.cancelled) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
  };
};

describe('singleFlight', () => {
  test('N callers on one key are ONE run of work', async () => {
    const flight = singleFlight();
    const held = deferred<string>();
    let runs = 0;
    const work = async (): Promise<string> => {
      runs += 1;
      return await held.promise;
    };
    const callers = [flight.run('k', work), flight.run('k', work), flight.run('k', work)];
    expect(flight.size).toBe(1);
    held.resolve('one origin load');
    expect(await Promise.all(callers)).toEqual([
      'one origin load',
      'one origin load',
      'one origin load',
    ]);
    expect(runs).toBe(1);
    expect(flight.size).toBe(0);
  });

  test('different keys never share', async () => {
    const flight = singleFlight();
    let runs = 0;
    const work = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    expect(await Promise.all([flight.run('a', work), flight.run('b', work)])).toEqual([1, 2]);
  });

  test('a REJECTED load clears its key — one failure is not cached forever', async () => {
    const flight = singleFlight();
    let runs = 0;
    const failing = async (): Promise<never> => {
      runs += 1;
      throw new UltimateError({ code: 'X_INTERNAL', cause: 'origin down', fix: 'x doctor --json' });
    };
    await expect(flight.run('k', failing)).rejects.toMatchObject({ code: 'X_INTERNAL' });
    expect(flight.size).toBe(0);
    await expect(flight.run('k', failing)).rejects.toMatchObject({ code: 'X_INTERNAL' });
    expect(runs).toBe(2);
  });

  test('work that throws SYNCHRONOUSLY still rejects its joiners and clears', async () => {
    const flight = singleFlight();
    const boom = (): Promise<never> => {
      throw new UltimateError({ code: 'X_INTERNAL', cause: 'sync throw', fix: 'x doctor --json' });
    };
    await expect(flight.run('k', boom)).rejects.toMatchObject({ code: 'X_INTERNAL' });
    expect(flight.size).toBe(0);
  });

  test('joiners fold their context in, and the leader reads it LATE', async () => {
    const flight = singleFlight();
    const gate = deferred<void>();
    const seen: string[] = [];
    const leader = flight.run<string, string>(
      'k',
      async (shared) => {
        await gate.promise;
        seen.push(shared() ?? 'nothing');
        return 'value';
      },
      { context: 'leader', merge: (current, joining) => `${current}+${joining}` },
    );
    const joiner = flight.run<string, string>('k', async () => 'never runs', {
      context: 'joiner',
      merge: (current, joining) => `${current}+${joining}`,
    });
    gate.resolve();
    await Promise.all([leader, joiner]);
    expect(seen).toEqual(['leader+joiner']);
  });

  test('with no deadline configured, nothing is ever scheduled', async () => {
    const timers = manualTimers();
    const flight = singleFlight({ schedule: timers.schedule });
    await flight.run('k', async () => 'done');
    expect(timers.pending()).toBe(0);
    expect(timers.delays()).toEqual([]);
  });

  test('a deadline evicts a wedged key, and its own joiners still get its answer', async () => {
    const timers = manualTimers();
    const flight = singleFlight({ deadlineMs: 5_000, schedule: timers.schedule });
    const wedged = deferred<string>();
    const first = flight.run('k', async () => await wedged.promise);
    expect(flight.size).toBe(1);
    expect(timers.delays()).toEqual([5_000]);

    timers.fire();
    // The key is free — a later caller starts its own load instead of joining a load that will
    // never settle. The wedged work is NOT cancelled; nothing here can cancel it.
    expect(flight.size).toBe(0);
    const second = flight.run('k', async () => 'fresh');
    expect(await second).toBe('fresh');

    wedged.resolve('late');
    expect(await first).toBe('late');
  });

  test('a late settle evicts only ITS OWN entry, never the key', async () => {
    const timers = manualTimers();
    const flight = singleFlight({ deadlineMs: 5_000, schedule: timers.schedule });
    const wedged = deferred<string>();
    const held = deferred<string>();
    const first = flight.run('k', async () => await wedged.promise);
    timers.fire();
    const second = flight.run('k', async () => await held.promise);
    expect(flight.size).toBe(1);

    wedged.resolve('late');
    await first;
    // The replacement is still in flight: the settle of the load it replaced must not drop it.
    expect(flight.size).toBe(1);
    held.resolve('replacement');
    expect(await second).toBe('replacement');
    expect(flight.size).toBe(0);
  });

  test('evict frees the key: the next run leads a fresh load, the evicted one keeps its callers', async () => {
    const timers = manualTimers();
    const flight = singleFlight({ deadlineMs: 5_000, schedule: timers.schedule });
    const stale = deferred<string>();
    const first = flight.run('k', async () => await stale.promise);
    expect(flight.keys()).toEqual(['k']);

    expect(flight.evict('k')).toBe(true);
    expect(flight.evict('k')).toBe(false);
    expect(timers.pending()).toBe(0);
    const second = flight.run('k', async () => 'fresh');
    expect(await second).toBe('fresh');

    // The evicted load settling late drops nothing that is not its own.
    const third = flight.run('k', async () => await deferred<string>().promise);
    stale.resolve('stale');
    expect(await first).toBe('stale');
    expect(flight.size).toBe(1);
    void third;
  });

  test('the deadline timer is cancelled when the load settles', async () => {
    const timers = manualTimers();
    const flight = singleFlight({ deadlineMs: 5_000, schedule: timers.schedule });
    await flight.run('k', async () => 'done');
    expect(timers.pending()).toBe(0);
  });
});

/**
 * One closed tab must not fail every healthy reader of a cold key. Each reader here runs on its own
 * context, because that is how the signal reaches a flight, and a re-lead's work reads the context
 * it finds, which is what proves the second load ran as the joiner and not as the leader.
 */
describe('a joiner after its leader was aborted', () => {
  const lifetimeFlight = () => singleFlight({ signal: () => tryUseContext()?.signal });
  const as = <T>(signal: AbortSignal, fn: () => T): T => runWithContext(ctxOf({ signal }), fn);
  const aborted = (): DOMException => new DOMException('the caller left', 'AbortError');

  test('a live joiner gets the value from a second load, under its own context', async () => {
    const flight = lifetimeFlight();
    const leader = new AbortController();
    const joiner = new AbortController();
    const gate = deferred<string>();
    const loadedUnder: (AbortSignal | undefined)[] = [];

    const led = as(leader.signal, () => flight.run('key', () => gate.promise));
    const joined = as(joiner.signal, () =>
      flight.run('key', async () => {
        loadedUnder.push(tryUseContext()?.signal);
        return 'second';
      }),
    );
    leader.abort();
    gate.reject(aborted());

    await expect(led).rejects.toThrow('the caller left');
    expect(await joined).toBe('second');
    expect(loadedUnder).toEqual([joiner.signal]);
    expect(flight.size).toBe(0);
  });

  test('three live joiners are one second load, and they share it', async () => {
    const flight = lifetimeFlight();
    const leader = new AbortController();
    const gate = deferred<string>();
    const second = deferred<string>();
    let reloads = 0;

    const led = as(leader.signal, () => flight.run('key', () => gate.promise));
    led.catch(() => undefined);
    const joined = [1, 2, 3].map(() =>
      as(new AbortController().signal, () =>
        flight.run('key', () => {
          reloads += 1;
          return second.promise;
        }),
      ),
    );
    leader.abort();
    gate.reject(aborted());
    await Bun.sleep(0);
    second.resolve('value');

    expect(await Promise.all(joined)).toEqual(['value', 'value', 'value']);
    expect(reloads).toBe(1);
  });

  test('a re-leader aborted in turn hands its live joiners a third load', async () => {
    const flight = lifetimeFlight();
    const first = new AbortController();
    const second = new AbortController();
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();

    const led = as(first.signal, () => flight.run('key', () => firstGate.promise));
    led.catch(() => undefined);
    const relead = as(second.signal, () => flight.run('key', () => secondGate.promise));
    relead.catch(() => undefined);
    const last = as(new AbortController().signal, () => flight.run('key', async () => 'third'));
    first.abort();
    firstGate.reject(aborted());
    await Bun.sleep(0);
    second.abort();
    secondGate.reject(aborted());

    expect(await last).toBe('third');
  });

  test('a leader that FAILS with its signal live hands its joiner that failure, no second load', async () => {
    const flight = lifetimeFlight();
    const gate = deferred<string>();
    const failure = new UltimateError({
      code: 'X_FLIGHT_PROBE',
      cause: 'the load itself failed',
      fix: 'x doctor --json',
    });
    let reloads = 0;

    const led = as(new AbortController().signal, () => flight.run('key', () => gate.promise));
    led.catch(() => undefined);
    const joined = as(new AbortController().signal, () =>
      flight.run('key', async () => {
        reloads += 1;
        return 'second';
      }),
    );
    gate.reject(failure);

    await expect(joined).rejects.toBe(failure);
    expect(reloads).toBe(0);
  });

  test('a joiner whose own signal is aborted takes the rejection', async () => {
    const flight = lifetimeFlight();
    const leader = new AbortController();
    const joiner = new AbortController();
    const gate = deferred<string>();
    const failure = aborted();
    let reloads = 0;

    const led = as(leader.signal, () => flight.run('key', () => gate.promise));
    led.catch(() => undefined);
    const joined = as(joiner.signal, () =>
      flight.run('key', async () => {
        reloads += 1;
        return 'second';
      }),
    );
    leader.abort();
    joiner.abort();
    gate.reject(failure);

    await expect(joined).rejects.toBe(failure);
    expect(reloads).toBe(0);
  });

  test('with no `signal` option a joiner shares the rejection, as it always did', async () => {
    const flight = singleFlight();
    const leader = new AbortController();
    const gate = deferred<string>();
    const failure = aborted();
    let reloads = 0;

    const led = as(leader.signal, () => flight.run('key', () => gate.promise));
    const joined = as(new AbortController().signal, () =>
      flight.run('key', async () => {
        reloads += 1;
        return 'second';
      }),
    );
    expect(joined).toBe(led);
    leader.abort();
    gate.reject(failure);

    await expect(joined).rejects.toBe(failure);
    expect(reloads).toBe(0);
  });

  test('a joiner still contributes its context to the load it re-leads', async () => {
    const flight = lifetimeFlight();
    const leader = new AbortController();
    const gate = deferred<string>();
    const contexts: (string | undefined)[] = [];
    const join = (context: string) => ({
      context,
      merge: (current: string, joining: string): string => `${current}+${joining}`,
    });

    const led = as(leader.signal, () => flight.run('key', () => gate.promise, join('leader')));
    led.catch(() => undefined);
    const joined = as(new AbortController().signal, () =>
      flight.run(
        'key',
        async (shared) => {
          contexts.push(shared());
          return 'second';
        },
        join('joiner'),
      ),
    );
    leader.abort();
    gate.reject(aborted());

    await joined;
    expect(contexts).toEqual(['joiner']);
  });
});

describe('`released`: told each time a key stops being held', () => {
  test('on settle, on a rejection, on `evict` and on the deadline, once each', async () => {
    const freed: string[] = [];
    const timers = manualTimers();
    const flight = singleFlight({
      deadlineMs: 5_000,
      schedule: timers.schedule,
      released: (key) => {
        freed.push(key);
      },
    });
    await flight.run('settled', async () => 'done');
    await flight.run('rejected', () => Promise.reject(new TypeError('no'))).catch(() => undefined);
    expect(freed).toEqual(['settled', 'rejected']);

    const evicted = deferred<string>();
    const evicting = flight.run('evicted', () => evicted.promise);
    expect(flight.evict('evicted')).toBe(true);
    expect(flight.evict('evicted')).toBe(false);
    expect(freed).toEqual(['settled', 'rejected', 'evicted']);
    evicted.resolve('late');
    await evicting;
    // Settling after it was evicted frees nothing: the key was already not this load's.
    expect(freed).toEqual(['settled', 'rejected', 'evicted']);

    void flight.run('wedged', () => new Promise<string>(() => undefined));
    timers.fire();
    expect(freed).toEqual(['settled', 'rejected', 'evicted', 'wedged']);
  });

  test('an evicted load settling does not report the key a newer load holds', async () => {
    const freed: string[] = [];
    const flight = singleFlight({
      released: (key) => {
        freed.push(key);
      },
    });
    const first = deferred<string>();
    const second = deferred<string>();
    const old = flight.run('k', () => first.promise);
    flight.evict('k');
    freed.length = 0;
    const newer = flight.run('k', () => second.promise);
    first.resolve('old');
    await old;
    expect(freed).toEqual([]);
    second.resolve('new');
    await newer;
    expect(freed).toEqual(['k']);
  });

  test('it runs before a joiner re-leads, so what it clears is the old holder', async () => {
    const events: string[] = [];
    const flight = singleFlight({
      signal: () => tryUseContext()?.signal,
      released: () => {
        events.push('released');
      },
    });
    const leader = new AbortController();
    const gate = deferred<string>();
    const led = runWithContext(ctxOf({ signal: leader.signal }), () =>
      flight.run('k', () => gate.promise),
    );
    led.catch(() => undefined);
    const joined = runWithContext(ctxOf({ signal: new AbortController().signal }), () =>
      flight.run('k', async () => {
        events.push('re-led');
        return 'second';
      }),
    );
    leader.abort();
    gate.reject(new DOMException('gone', 'AbortError'));
    await joined;
    expect(events.slice(0, 2)).toEqual(['released', 're-led']);
  });
});
