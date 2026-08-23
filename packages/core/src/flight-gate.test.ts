import { describe, expect, test } from 'bun:test';
import { isUltimateError, UltimateError } from './errors';
import { createFlightGate } from './flight-gate';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = (): void => settle();
  });
  return { promise, resolve };
};

/** Peak concurrency, which is the only observation that can falsify a bound. */
const tracker = (): {
  readonly peak: () => number;
  wrap: (inner: Promise<void>) => () => Promise<void>;
} => {
  let active = 0;
  let peak = 0;
  return {
    peak: (): number => peak,
    wrap: (inner: Promise<void>) => async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await inner;
      active -= 1;
    },
  };
};

describe('createFlightGate', () => {
  test('runs work straight through below the ceiling', async () => {
    const gate = createFlightGate({ maxConcurrent: 2, maxQueued: 2 });
    expect(await gate.run(async () => 'answer')).toBe('answer');
    expect(gate.active).toBe(0);
    expect(gate.queued).toBe(0);
  });

  test('never runs more than maxConcurrent at once', async () => {
    const gate = createFlightGate({ maxConcurrent: 2, maxQueued: 8 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const track = tracker();
    const runs = gates.map((one) => gate.run(track.wrap(one.promise)));
    await Promise.resolve();
    expect(gate.active).toBe(2);
    expect(gate.queued).toBe(2);
    for (const one of gates) one.resolve();
    await Promise.all(runs);
    expect(track.peak()).toBe(2);
    expect(gate.active).toBe(0);
  });

  test('a woken waiter HOLDS the slot it was handed, so a later arrival still waits', async () => {
    const gate = createFlightGate({ maxConcurrent: 1, maxQueued: 8 });
    const track = tracker();
    const first = deferred();
    const waiting = deferred();
    const late = deferred();
    const runs = [gate.run(track.wrap(first.promise)), gate.run(track.wrap(waiting.promise))];
    await Promise.resolve();
    expect(gate.queued).toBe(1);

    first.resolve();
    await runs[0];
    await Promise.resolve();
    // The slot was HANDED to the waiter, never released and re-acquired: a gate that decrements
    // first reads 0 here, and the arrival below then runs beside the waiter it just woke.
    expect(gate.active).toBe(1);

    runs.push(gate.run(track.wrap(late.promise)));
    await Promise.resolve();
    expect(track.peak()).toBe(1);
    waiting.resolve();
    late.resolve();
    await Promise.all(runs);
    expect(track.peak()).toBe(1);
    expect(gate.active).toBe(0);
  });

  test('refuses past maxQueued instead of growing the queue', async () => {
    const gate = createFlightGate({ maxConcurrent: 1, maxQueued: 1 });
    const held = deferred();
    const first = gate.run(async () => {
      await held.promise;
    });
    const queued = gate.run(async () => {
      await held.promise;
    });
    await Promise.resolve();
    const refused = gate.run(async () => undefined);
    await expect(refused).rejects.toMatchObject({ code: 'X_FLIGHT_GATE_OVERLOADED' });
    const error = await refused.catch((thrown: unknown) => thrown);
    expect(isUltimateError(error) ? error.retry : undefined).toBe('retry-after');
    expect(isUltimateError(error) ? error.meta : undefined).toMatchObject({
      active: 1,
      queued: 1,
      maxConcurrent: 1,
      maxQueued: 1,
      retryAfterSeconds: 1,
      subject: 'in-flight work',
    });
    held.resolve();
    await Promise.all([first, queued]);
    expect(gate.active).toBe(0);
    expect(gate.queued).toBe(0);
  });

  test('an injected overflow refusal replaces the default, so a package keeps its own code', async () => {
    const gate = createFlightGate(
      { maxConcurrent: 1, maxQueued: 0 },
      {
        overflow: (state) =>
          new UltimateError({
            code: 'X_OVERLOADED',
            cause: `${state.active} running`,
            fix: 'retry after the Retry-After header, or widen the ceiling with configureKdfGate({ maxConcurrent, maxQueued })',
          }),
      },
    );
    const held = deferred();
    const first = gate.run(async () => {
      await held.promise;
    });
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({ code: 'X_OVERLOADED' });
    held.resolve();
    await first;
  });

  test('releases the slot when work throws', async () => {
    const gate = createFlightGate({ maxConcurrent: 1, maxQueued: 1 });
    await expect(
      gate.run(async () => {
        throw new UltimateError({
          code: 'X_INTERNAL',
          cause: 'work failed',
          fix: 'x doctor --json',
        });
      }),
    ).rejects.toMatchObject({ code: 'X_INTERNAL' });
    expect(gate.active).toBe(0);
    expect(await gate.run(async () => 'next')).toBe('next');
  });

  test('a subject names what is bounded in the refusal', async () => {
    const gate = createFlightGate({ maxConcurrent: 1, maxQueued: 0 }, { subject: 'argon2 hashes' });
    const held = deferred();
    const first = gate.run(async () => {
      await held.promise;
    });
    const error = await gate.run(async () => undefined).catch((thrown: unknown) => thrown);
    expect(isUltimateError(error) ? error.cause : '').toContain('argon2 hashes');
    held.resolve();
    await first;
  });
});
