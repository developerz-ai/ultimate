/**
 * unit — no server, no real clock. The write half of flight control, which is the half whose rules
 * are all refusals: a mutation never joins another mutation, a fence never closes its socket, and
 * a retry is gated on an `Idempotency-Key` because a second POST without one is a second write.
 */

import { describe, expect, test } from 'bun:test';
import { createClientFlight, isSuperseded } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { type FetchLike, rpc } from './client';
import { IDEMPOTENCY_HEADER } from './wire-headers';

const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const OK = { id: POST_ID, published: true };

const publishPost = action({
  input: t.object({ postId: t.uuid }),
  output: t.object({ id: t.uuid, published: t.boolean }),
  policy: can('post:publish'),
  handle: () => OK,
}).named('publishPost');

const actions = { publishPost };

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

describe('a write never joins, and is never aborted', () => {
  test('two identical concurrent mutations are TWO requests', async () => {
    let calls = 0;
    const waiters: Array<() => void> = [];
    const fetchStub: FetchLike = () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        waiters.push(() => {
          resolve(Response.json(OK));
        });
      });
    };
    const flight = createClientFlight({ principal: () => 'alice' });
    const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub, flight });

    const both = Promise.all([
      api.publishPost({ postId: POST_ID }),
      api.publishPost({ postId: POST_ID }),
    ]);
    for (const resume of waiters.splice(0)) resume();
    await both;

    // A principal IS installed, so dedup is available — and still unreachable from this client,
    // because `client.ts` never calls `keyFor`. Two writes are two writes.
    expect(calls).toBe(2);
  });

  test('a fence bump supersedes the ANSWER and leaves the request alone', async () => {
    let sentSignal: AbortSignal | null | undefined = null;
    const waiters: Array<() => void> = [];
    let completed = false;
    const fetchStub: FetchLike = (_url, init) => {
      sentSignal = init.signal;
      return new Promise<Response>((resolve) => {
        waiters.push(() => {
          completed = true;
          resolve(Response.json(OK));
        });
      });
    };
    const flight = createClientFlight({ principal: () => 'alice' });
    const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub, flight });

    const pending = api.publishPost({ postId: POST_ID }).catch((caught: unknown) => caught);
    flight.bump();
    for (const resume of waiters.splice(0)) resume();
    const outcome = await pending;

    // No signal ever reached the wire, so there was nothing for the bump to abort: closing the
    // socket does not un-commit the write, it only destroys the answer.
    expect(sentSignal).toBeUndefined();
    expect(completed).toBe(true);
    expect(isSuperseded(outcome)).toBe(true);
  });
});

describe('a retried mutation needs an idempotency key', () => {
  test('without one, `retry` is narrowed to a single attempt', async () => {
    let calls = 0;
    const fetchStub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response('gateway', { status: 503 }));
    };
    const clock = recordedSleep();
    const flight = createClientFlight({
      principal: () => 'alice',
      retry: { attempts: 5 },
      sleep: clock.sleep,
    });
    const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub, flight });

    const outcome = await api
      .publishPost({ postId: POST_ID }, { retry: { attempts: 5 } })
      .catch((caught: unknown) => caught);

    expect(outcome).toBeUltimateError('X_RPC_FAILED');
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test('with one, it is retried — and every attempt carries the same key', async () => {
    let calls = 0;
    const keys: (string | null)[] = [];
    const fetchStub: FetchLike = (_url, init) => {
      calls += 1;
      keys.push(new Headers(init.headers).get(IDEMPOTENCY_HEADER));
      return Promise.resolve(
        calls < 3 ? new Response('gateway', { status: 503 }) : Response.json(OK),
      );
    };
    const clock = recordedSleep();
    const flight = createClientFlight({
      principal: () => 'alice',
      sleep: clock.sleep,
      random: () => 0.5,
    });
    const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub, flight });

    const answer = await api.publishPost(
      { postId: POST_ID },
      { idempotencyKey: 'charge-1', retry: { attempts: 3 } },
    );

    expect(answer).toEqual(OK);
    expect(calls).toBe(3);
    expect(keys).toEqual(['charge-1', 'charge-1', 'charge-1']);
    expect(clock.waits).toEqual([50, 100]);
  });

  test('an idempotency key alone does not opt a call into retrying', async () => {
    let calls = 0;
    const fetchStub: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response('gateway', { status: 503 }));
    };
    const clock = recordedSleep();
    const flight = createClientFlight({ principal: () => 'alice', sleep: clock.sleep });
    const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub, flight });

    await api
      .publishPost({ postId: POST_ID }, { idempotencyKey: 'charge-1' })
      .catch((caught: unknown) => caught);

    // The flight declared no policy either, so the shipped default stands: one attempt.
    expect(calls).toBe(1);
  });
});
