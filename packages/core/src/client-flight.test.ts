/**
 * unit — no fetch, no server, no real clock. The pipeline is driven through `FlightPlan` directly,
 * which is the seam a typed client sits on: `@ultimat3/action` and `@ultimat3/query` each prove
 * their own client reaches it, and this file proves what it does once reached.
 */

import { describe, expect, test } from 'bun:test';
import {
  createClientFlight,
  DEFAULT_CLIENT_RETRY,
  type FlightPlan,
  isTransientFailure,
} from './client-flight';
import { UltimateError } from './errors';
import { isSuperseded } from './generation-fence';

/** A plan that answers nothing until `release()`, recording the signal each attempt was given. */
function held(key: string | undefined, abortable = true) {
  let calls = 0;
  const signals: (AbortSignal | undefined)[] = [];
  const waiters: Array<() => void> = [];
  const plan: FlightPlan<string> = {
    key,
    abortable,
    run: (signal) => {
      calls += 1;
      signals.push(signal);
      return new Promise<string>((resolve, reject) => {
        waiters.push(() => {
          resolve('rows');
        });
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    },
  };
  return {
    plan,
    signals,
    calls: () => calls,
    release: (): void => {
      for (const resume of waiters.splice(0)) resume();
    },
  };
}

describe('the shipped policy', () => {
  test('is ONE dispatch — a client that retries by default triples a failing service’s load', () => {
    expect(DEFAULT_CLIENT_RETRY.attempts).toBe(1);
    expect(DEFAULT_CLIENT_RETRY.jitter).toBe('full');
    expect(DEFAULT_CLIENT_RETRY.curve).toBe('exponential');
  });
});

describe('isTransientFailure inverts retryDecision’s unclassified default', () => {
  test('a DECLARED classification is honoured in both directions', () => {
    const retryable = new UltimateError({
      code: 'X_TIMEOUT',
      cause: 'budget',
      fix: 'raise deadlineMs',
    });
    const terminal = new UltimateError({
      code: 'X_SUPERSEDED',
      cause: 'moved on',
      fix: 'read the newer answer',
    });
    expect(isTransientFailure(retryable)).toBe(true);
    expect(isTransientFailure(terminal)).toBe(false);
  });

  test('only a dispatch that produced NO response is retried unclassified', () => {
    // The whole inversion: `retryDecision` would send all four of these again.
    expect(isTransientFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientFailure(new DOMException('gone', 'AbortError'))).toBe(false);
    expect(isTransientFailure(new DOMException('slow', 'TimeoutError'))).toBe(false);
    expect(isTransientFailure(new RangeError('a foreign value'))).toBe(false);
    expect(isTransientFailure('not an error at all')).toBe(false);
  });
});

describe('keyFor decides what may share a dispatch', () => {
  test('no principal, no dedup — naming who is asking is what turns it on', () => {
    expect(createClientFlight({}).keyFor('/u')).toBeUndefined();
  });

  test('the key carries the principal, as JSON and never a joined string', () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    expect(flight.keyFor('/u')).toBe(JSON.stringify(['alice', '/u']));
    // A principal is app data and may carry any separator a joined key would use.
    expect(createClientFlight({ principal: () => 'a:b' }).keyFor('/u')).not.toBe(
      flight.keyFor('/u'),
    );
  });

  test('a caller’s own signal and `fresh` each disqualify the call from sharing', () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    expect(flight.keyFor('/u', { signal: new AbortController().signal })).toBeUndefined();
    expect(flight.keyFor('/u', { fresh: true })).toBeUndefined();
    expect(flight.keyFor('/u', { fresh: false })).toBe(JSON.stringify(['alice', '/u']));
  });
});

describe('dedup', () => {
  test('two plans holding one key are ONE dispatch, and the map drains', async () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    const wire = held('k');

    const both = Promise.all([flight.run(wire.plan), flight.run(wire.plan)]);
    expect(flight.inflight).toBe(1);
    wire.release();
    expect(await both).toEqual(['rows', 'rows']);

    expect(wire.calls()).toBe(1);
    expect(flight.inflight).toBe(0);
  });

  test('a plan with no key never joins one', async () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    const wire = held(undefined);

    const both = Promise.all([flight.run(wire.plan), flight.run(wire.plan)]);
    wire.release();
    await both;

    expect(wire.calls()).toBe(2);
    expect(flight.inflight).toBe(0);
  });
});

describe('the generation fence', () => {
  test('a bump supersedes the answer of work already issued, and aborts it', async () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    const wire = held('k');

    const pending = flight.run(wire.plan).catch((caught: unknown) => caught);
    expect(flight.bump()).toBe(1);
    const outcome = await pending;

    expect(isSuperseded(outcome)).toBe(true);
    expect(wire.signals[0]?.aborted).toBe(true);
  });

  test('a NON-abortable plan keeps its socket and is still told it was superseded', async () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    const wire = held('k', false);

    const pending = flight.run(wire.plan).catch((caught: unknown) => caught);
    flight.bump();
    wire.release();

    // Closing a mutation's socket does not un-commit it; it only destroys the answer.
    expect(wire.signals[0]).toBeUndefined();
    expect(isSuperseded(await pending)).toBe(true);
  });

  test('the guard runs on the FAILURE path too', async () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    const thrown = new RangeError('a foreign value');
    let release = (): void => {};
    const plan: FlightPlan<string> = {
      key: 'k',
      abortable: false,
      run: () =>
        new Promise<string>((_resolve, reject) => {
          release = (): void => {
            reject(thrown);
          };
        }),
    };

    const pending = flight.run(plan).catch((caught: unknown) => caught);
    flight.bump();
    release();

    // A bump supersedes a refusal exactly as much as an answer: a caller that cannot tell the two
    // apart retries a request its own context has already replaced.
    expect(isSuperseded(await pending)).toBe(true);
  });

  test('work issued AFTER the bump is answered normally', async () => {
    const flight = createClientFlight({ principal: () => 'alice' });
    flight.bump();
    const wire = held('k');
    const pending = flight.run(wire.plan);
    wire.release();

    expect(await pending).toBe('rows');
    expect(flight.generation()).toBe(1);
  });
});
