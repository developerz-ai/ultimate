/**
 * unit — nothing sleeps for real. The scheduler and the sleep are injected, so a retry schedule, a
 * deadline and a concurrency refusal are all pinned as exact numbers rather than waited for.
 */

import { describe, expect, test } from 'bun:test';
import { createClientFlight, declaredErrorRetry, isTransientFailure } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { type FetchLike, queryClient } from './client';
import { query } from './query';
import { from } from './source';

type PostRow = { readonly id: string; readonly title: string };

const publicPost = query({
  input: t.object({ slug: t.string }),
  policy: can('post:read'),
  sql: ({ slug }) =>
    from<PostRow>('posts', async () => [{ id: 'a', title: slug }])
      .where({ slug })
      .orderBy('id')
      .limit(1),
}).named('publicPost');

const queries = { publicPost };
const ROWS = '[{"id":"a","title":"t"}]';

/** Every wait the loop asked for, recorded and answered instantly. No test may sleep for real. */
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
    schedule: (fn, _ms) => {
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

describe('retry, on the framework executor', () => {
  test('a 503 is sent again on the shipped curve, and the delays are exact', async () => {
    let calls = 0;
    const fetchStub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        calls < 3 ? new Response('bad gateway', { status: 503 }) : new Response(ROWS),
      );
    };
    const clock = recordedSleep();
    const flight = createClientFlight({
      principal: () => 'alice',
      retry: { attempts: 3 },
      sleep: clock.sleep,
      random: () => 0.5,
    });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
      flight,
    });

    expect(await client.publicPost({ slug: 'x' })).toEqual([{ id: 'a', title: 't' }]);
    expect(calls).toBe(3);
    // `backoffDelay`'s numbers, not a second table: base 100 exponential, full jitter at roll 0.5.
    expect(clock.waits).toEqual([50, 100]);
  });

  test('a 400 is the request’s own fault and is never sent again', async () => {
    let calls = 0;
    const fetchStub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        Response.json({ code: 'X_INPUT_INVALID', cause: 'slug', fix: 'fix it' }, { status: 400 }),
      );
    };
    const clock = recordedSleep();
    const flight = createClientFlight({
      principal: () => 'alice',
      retry: { attempts: 5 },
      sleep: clock.sleep,
    });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
      flight,
    });

    const outcome = await client.publicPost({ slug: 'x' }).catch((caught: unknown) => caught);

    expect(outcome).toBeUltimateError('X_INPUT_INVALID');
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test('an UNCLASSIFIED throw stops the loop, and reaches the caller unchanged', async () => {
    // `retryDecision` retries anything nobody classified until the attempts run out. A client is
    // the one place that means a caller's own abort and a mapper's `TypeError` get sent again,
    // which is why `isTransientFailure` inverts the default rather than trusting it.
    const thrown = new RangeError('a foreign value');
    let calls = 0;
    const fetchStub: FetchLike = () => {
      calls += 1;
      return Promise.reject(thrown);
    };
    const clock = recordedSleep();
    const flight = createClientFlight({
      principal: () => 'alice',
      retry: { attempts: 5 },
      sleep: clock.sleep,
    });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
      flight,
    });

    const outcome = await client.publicPost({ slug: 'x' }).catch((caught: unknown) => caught);

    expect(outcome).toBe(thrown);
    expect(calls).toBe(1);
  });

  test('a dispatch that produced no response at all IS sent again', async () => {
    let calls = 0;
    const fetchStub: FetchLike = () => {
      calls += 1;
      return calls < 2
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response(ROWS));
    };
    const clock = recordedSleep();
    const flight = createClientFlight({
      principal: () => 'alice',
      retry: { attempts: 3 },
      sleep: clock.sleep,
      random: () => 0,
    });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
      flight,
    });

    expect(await client.publicPost({ slug: 'x' })).toEqual([{ id: 'a', title: 't' }]);
    expect(calls).toBe(2);
  });

  test('an abort is a decision, not a failure, so it is never retried', () => {
    expect(isTransientFailure(new DOMException('gone', 'AbortError'))).toBe(false);
    expect(isTransientFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientFailure(new RangeError('foreign'))).toBe(false);
  });

  test('the status is what classifies a wire failure, and it reaches `error.retry`', async () => {
    // The premise this rests on: nobody has declared X_RPC_FAILED, so the status decides.
    expect(declaredErrorRetry('X_RPC_FAILED')).toBeUndefined();
    const fetchStub: FetchLike = () => Promise.resolve(new Response('nope', { status: 502 }));
    const read = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
    }).publicPost;

    const outcome = await read({ slug: 'x' }).catch((caught: unknown) => caught);

    expect(outcome).toBeUltimateError('X_RPC_FAILED');
    expect((outcome as { retry: string }).retry).toBe('retryable');
  });
});

describe('the deadline and the ceiling', () => {
  test('a read past its deadline is X_TIMEOUT, not a bare AbortError', async () => {
    const clock = manualClock();
    const fetchStub: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    const flight = createClientFlight({
      principal: () => 'alice',
      deadlineMs: 5_000,
      schedule: clock.schedule,
    });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
      flight,
    });

    const pending = client.publicPost({ slug: 'x' }).catch((caught: unknown) => caught);
    await Promise.resolve();
    clock.fireAll();
    const outcome = await pending;

    expect(outcome).toBeUltimateError('X_TIMEOUT');
    expect((outcome as { cause: string }).cause).toContain('5000ms');
  });

  test('past the ceiling and the queue the answer is a refusal, never a longer queue', async () => {
    const waiters: Array<() => void> = [];
    const fetchStub: FetchLike = () =>
      new Promise<Response>((resolve) => {
        waiters.push(() => {
          resolve(new Response(ROWS));
        });
      });
    const flight = createClientFlight({
      principal: () => 'alice',
      limit: { maxConcurrent: 1, maxQueued: 0 },
    });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
      flight,
    });

    const first = client.publicPost({ slug: 'one' });
    const refused = await client.publicPost({ slug: 'two' }).catch((caught: unknown) => caught);
    for (const resume of waiters.splice(0)) resume();
    await first;

    expect(refused).toBeUltimateError('X_FLIGHT_GATE_OVERLOADED');
    expect(flight.active).toBe(0);
    expect(flight.queued).toBe(0);
    expect(flight.inflight).toBe(0);
  });
});
