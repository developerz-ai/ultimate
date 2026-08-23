import { describe, expect, test } from 'bun:test';
import { UltimateError } from './errors';
import { createSingleFlight } from './single-flight';

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

describe('createSingleFlight', () => {
  test('N callers on one key are ONE run of work', async () => {
    const flight = createSingleFlight();
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
    const flight = createSingleFlight();
    let runs = 0;
    const work = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    expect(await Promise.all([flight.run('a', work), flight.run('b', work)])).toEqual([1, 2]);
  });

  test('a REJECTED load clears its key — one failure is not cached forever', async () => {
    const flight = createSingleFlight();
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
    const flight = createSingleFlight();
    const boom = (): Promise<never> => {
      throw new UltimateError({ code: 'X_INTERNAL', cause: 'sync throw', fix: 'x doctor --json' });
    };
    await expect(flight.run('k', boom)).rejects.toMatchObject({ code: 'X_INTERNAL' });
    expect(flight.size).toBe(0);
  });

  test('joiners fold their context in, and the leader reads it LATE', async () => {
    const flight = createSingleFlight();
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
    const flight = createSingleFlight({ schedule: timers.schedule });
    await flight.run('k', async () => 'done');
    expect(timers.pending()).toBe(0);
    expect(timers.delays()).toEqual([]);
  });

  test('a deadline evicts a wedged key, and its own joiners still get its answer', async () => {
    const timers = manualTimers();
    const flight = createSingleFlight({ deadlineMs: 5_000, schedule: timers.schedule });
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
    const flight = createSingleFlight({ deadlineMs: 5_000, schedule: timers.schedule });
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

  test('the deadline timer is cancelled when the load settles', async () => {
    const timers = manualTimers();
    const flight = createSingleFlight({ deadlineMs: 5_000, schedule: timers.schedule });
    await flight.run('k', async () => 'done');
    expect(timers.pending()).toBe(0);
  });
});
