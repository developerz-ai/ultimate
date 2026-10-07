/**
 * unit — nothing sleeps for real. The other half of `client-flight.ts`: the retry loop, the one
 * wall-clock deadline and the concurrency ceiling, each driven through injected time so a schedule
 * is pinned as exact numbers rather than waited for.
 */

import { describe, expect, test } from 'bun:test';
import { clientFlight, type FlightPlan } from './client-flight';
import { UltimateError } from './errors';

/** Every wait the loop asked for, recorded and answered instantly. */
function recordedSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

/** Timers a test fires by hand. `fireAll` runs every callback scheduled so far, once. */
function manualClock(): {
  schedule: (fn: () => void, ms: number) => () => void;
  fireAll: () => void;
} {
  let pending: Array<{ fn: () => void; live: boolean }> = [];
  return {
    schedule: (fn) => {
      const entry = { fn, live: true };
      pending.push(entry);
      return (): void => {
        entry.live = false;
      };
    },
    fireAll: (): void => {
      const due = pending;
      pending = [];
      for (const entry of due) if (entry.live) entry.fn();
    },
  };
}

const gateway = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'the budget ran out', fix: 'raise deadlineMs' });

/** A plan that fails `failures` times, then answers. Never aborts, so no signal is needed. */
function flaky(
  failures: number,
  error: () => unknown,
): FlightPlan<string> & { calls: () => number } {
  let calls = 0;
  return {
    key: undefined,
    abortable: false,
    calls: () => calls,
    run: (): Promise<string> => {
      calls += 1;
      return calls <= failures ? Promise.reject(error()) : Promise.resolve('rows');
    },
  };
}

describe('retry, on the framework executor', () => {
  test('a declared-retryable failure is sent again on backoffDelay’s curve, exactly', async () => {
    const plan = flaky(2, gateway);
    const clock = recordedSleep();
    const flight = clientFlight({
      retry: { attempts: 3 },
      sleep: clock.sleep,
      random: () => 0.5,
    });

    expect(await flight.run(plan)).toBe('rows');
    expect(plan.calls()).toBe(3);
    // `backoffDelay`'s numbers, not a second table: base 100 exponential, full jitter at roll 0.5.
    expect(clock.waits).toEqual([50, 100]);
  });

  test('an UNCLASSIFIED throw stops the loop after ONE attempt and reaches the caller unwrapped', async () => {
    const thrown = new RangeError('a foreign value');
    const plan = flaky(9, () => thrown);
    const clock = recordedSleep();
    const flight = clientFlight({ retry: { attempts: 5 }, sleep: clock.sleep });

    const outcome = await flight.run(plan).catch((caught: unknown) => caught);

    // By IDENTITY: the loop resolves to a private sentinel rather than throwing, precisely so the
    // caller's own value survives instead of being replaced by "something retried".
    expect(outcome).toBe(thrown);
    expect(plan.calls()).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test('a dispatch that produced no response at all IS sent again', async () => {
    const plan = flaky(1, () => new TypeError('Failed to fetch'));
    const clock = recordedSleep();
    const flight = clientFlight({
      retry: { attempts: 3 },
      sleep: clock.sleep,
      random: () => 0,
    });

    expect(await flight.run(plan)).toBe('rows');
    expect(plan.calls()).toBe(2);
  });

  test('the plan’s own policy overrides the flight’s', async () => {
    const plan = { ...flaky(1, gateway), retry: { attempts: 2 } };
    const clock = recordedSleep();
    const flight = clientFlight({ retry: { attempts: 1 }, sleep: clock.sleep });

    expect(await flight.run(plan)).toBe('rows');
  });

  test('an app may supply its own predicate, and neither default then applies', async () => {
    const plan = flaky(1, () => new RangeError('foreign'));
    const clock = recordedSleep();
    const flight = clientFlight({
      retry: { attempts: 2 },
      sleep: clock.sleep,
      random: () => 0,
      transient: () => true,
    });

    expect(await flight.run(plan)).toBe('rows');
    expect(plan.calls()).toBe(2);
  });

  // `clientTransport` classifies its own wire failures, so a bare TypeError reaching the flight
  // is a caller hook's bug — and was re-sent, as a network rejection, until the attempts ran out.
  test('a classified plan never sends a bare TypeError again', async () => {
    const bug = new TypeError('a hook broke');
    const plan = { ...flaky(1, () => bug), classified: true };
    const flight = clientFlight({ retry: { attempts: 3 }, sleep: recordedSleep().sleep });

    expect(await flight.run(plan).catch((caught: unknown) => caught)).toBe(bug);
    expect(plan.calls()).toBe(1);
  });

  test("on a classified plan, the app's own predicate still decides", async () => {
    const plan = { ...flaky(1, () => new TypeError('foreign')), classified: true };
    const flight = clientFlight({
      retry: { attempts: 2 },
      sleep: recordedSleep().sleep,
      random: () => 0,
      transient: () => true,
    });

    expect(await flight.run(plan)).toBe('rows');
    expect(plan.calls()).toBe(2);
  });
});

describe('the deadline', () => {
  test('an abortable plan past its budget is X_TIMEOUT, not the bare AbortError it produced', async () => {
    const clock = manualClock();
    const plan: FlightPlan<string> = {
      key: undefined,
      abortable: true,
      run: (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    };
    const flight = clientFlight({ deadlineMs: 5_000, schedule: clock.schedule });

    const pending = flight.run(plan).catch((caught: unknown) => caught);
    await Promise.resolve();
    clock.fireAll();
    const outcome = await pending;

    expect(outcome).toBeUltimateError('X_TIMEOUT');
    expect((outcome as { cause: string }).cause).toContain('5000ms');
    expect((outcome as { meta: { deadlineMs: number } }).meta.deadlineMs).toBe(5_000);
  });

  test('a NON-abortable plan is never aborted by the deadline — it only stops being retried', async () => {
    const clock = manualClock();
    let seenSignal: AbortSignal | undefined | 'unset' = 'unset';
    let release = (): void => {};
    const plan: FlightPlan<string> = {
      key: undefined,
      abortable: false,
      run: (signal) => {
        seenSignal = signal;
        return new Promise<string>((resolve) => {
          release = (): void => {
            resolve('committed');
          };
        });
      },
    };
    const flight = clientFlight({ deadlineMs: 5_000, schedule: clock.schedule });

    const pending = flight.run(plan);
    await Promise.resolve();
    clock.fireAll();
    release();

    expect(seenSignal).toBeUndefined();
    expect(await pending).toBe('committed');
  });
});

describe('the concurrency ceiling', () => {
  test('past the ceiling and the queue the answer is a refusal, never a longer queue', async () => {
    const waiters: Array<() => void> = [];
    const plan: FlightPlan<string> = {
      key: undefined,
      abortable: false,
      run: () =>
        new Promise<string>((resolve) => {
          waiters.push(() => {
            resolve('rows');
          });
        }),
    };
    const flight = clientFlight({ limit: { maxConcurrent: 1, maxQueued: 0 } });

    const first = flight.run(plan);
    expect(flight.active).toBe(1);
    const refused = await flight.run(plan).catch((caught: unknown) => caught);
    for (const resume of waiters.splice(0)) resume();
    await first;

    expect(refused).toBeUltimateError('X_FLIGHT_GATE_OVERLOADED');
    expect(flight.active).toBe(0);
    expect(flight.queued).toBe(0);
  });

  test('with no limit declared there is no gate, and both counters read 0', async () => {
    const flight = clientFlight({});
    expect(flight.active).toBe(0);
    expect(flight.queued).toBe(0);
    expect(
      await flight.run({ key: undefined, abortable: false, run: () => Promise.resolve('rows') }),
    ).toBe('rows');
  });
});

/** Whether `promise` settles within `ms` of real time — a wait that cannot be cancelled never does. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([promise, Bun.sleep(ms).then(() => 'still waiting' as const)]);
}

/** Lets the first attempt fail and the loop reach its wait. */
const reachTheWait = (): Promise<void> => Bun.sleep(5);

describe('the wait between attempts', () => {
  test('a bump during the wait settles the call at once, not when the timer fires', async () => {
    const clock = manualClock();
    let calls = 0;
    const plan: FlightPlan<string> = {
      key: undefined,
      abortable: true,
      run: () => {
        calls += 1;
        return Promise.reject(gateway());
      },
    };
    const flight = clientFlight({ retry: { attempts: 2 }, schedule: clock.schedule });

    const pending = flight.run(plan).catch((caught: unknown) => caught);
    await reachTheWait();
    flight.bump();

    const outcome = await settledWithin(pending, 50);
    expect(outcome).toBeUltimateError('X_SUPERSEDED');
    expect(calls).toBe(1);
  });

  test("the caller's own abort during the wait settles the call at once — a write's too", async () => {
    const clock = manualClock();
    const caller = new AbortController();
    let calls = 0;
    const plan: FlightPlan<string> = {
      key: undefined,
      abortable: false,
      signal: caller.signal,
      run: () => {
        calls += 1;
        return Promise.reject(gateway());
      },
    };
    const flight = clientFlight({ retry: { attempts: 2 }, schedule: clock.schedule });

    const pending = flight.run(plan).catch((caught: unknown) => caught);
    await reachTheWait();
    caller.abort();

    const outcome = await settledWithin(pending, 50);
    expect(outcome).toBeInstanceOf(DOMException);
    expect((outcome as DOMException).name).toBe('AbortError');
    expect(calls).toBe(1);
  });

  test('the gate slot is free during the wait, so another call proceeds instead of being refused', async () => {
    const clock = manualClock();
    const flight = clientFlight({
      retry: { attempts: 2 },
      schedule: clock.schedule,
      limit: { maxConcurrent: 1, maxQueued: 0 },
    });
    const waiting = flight.run(flaky(1, gateway));
    await reachTheWait();
    expect(flight.active).toBe(0);

    const other = await flight.run(flaky(0, gateway)).catch((caught: unknown) => caught);
    expect(other).toBe('rows');

    clock.fireAll();
    expect(await waiting).toBe('rows');
    expect(flight.active).toBe(0);
    expect(flight.queued).toBe(0);
  });
});

describe('a retry attempt queued at the gate', () => {
  /** A plan that holds its slot until `release()` — the call a queued retry waits behind. */
  function holding(): FlightPlan<string> & { release: () => void } {
    let done: (() => void) | undefined;
    return {
      key: undefined,
      abortable: false,
      release: () => done?.(),
      run: () =>
        new Promise<string>((resolve) => {
          done = () => resolve('held');
        }),
    };
  }

  /** A read that fails once, so its second attempt is the one that queues. */
  function failsOnce(signal?: AbortSignal): FlightPlan<string> {
    let calls = 0;
    return {
      key: undefined,
      abortable: signal === undefined,
      ...(signal === undefined ? {} : { signal }),
      run: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(gateway()) : Promise.resolve('rows');
      },
    };
  }

  async function queuedBehind(signal?: AbortSignal) {
    const clock = manualClock();
    const flight = clientFlight({
      retry: { attempts: 2 },
      schedule: clock.schedule,
      limit: { maxConcurrent: 1, maxQueued: 1 },
    });
    const retrying = flight.run(failsOnce(signal)).catch((caught: unknown) => caught);
    await reachTheWait();
    const holder = holding();
    const held = flight.run(holder);
    clock.fireAll();
    await reachTheWait();
    expect(flight.queued).toBe(1);
    return { flight, retrying, holder, held };
  }

  test('bump() removes it from the queue and settles it at once; the slot holder runs on', async () => {
    const { flight, retrying, holder, held } = await queuedBehind();
    flight.bump();
    expect(await settledWithin(retrying, 50)).toBeUltimateError('X_SUPERSEDED');
    expect(flight.queued).toBe(0);
    // The holder is a write, so the bump never aborts it: it keeps its slot and finishes, and its
    // answer is then fenced like every call issued before the bump.
    expect(flight.active).toBe(1);
    holder.release();
    expect(await held.catch((caught: unknown) => caught)).toBeUltimateError('X_SUPERSEDED');
    expect(flight.active).toBe(0);
  });

  test("the caller's abort removes it too, and the next call takes the queue place", async () => {
    const caller = new AbortController();
    const { flight, retrying, holder, held } = await queuedBehind(caller.signal);
    caller.abort();
    const outcome = await settledWithin(retrying, 50);
    expect((outcome as DOMException).name).toBe('AbortError');
    expect(flight.queued).toBe(0);
    const next = flight.run(flaky(0, gateway));
    expect(flight.queued).toBe(1);
    holder.release();
    expect(await held).toBe('held');
    expect(await next).toBe('rows');
    expect(flight.active).toBe(0);
  });
});
