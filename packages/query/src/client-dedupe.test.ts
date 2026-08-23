/**
 * unit — no server, no socket, no real clock. What is pinned here is the read half of flight
 * control: which concurrent reads become ONE dispatch, which may never share one, and what a
 * caller can tell apart once a fence has moved on.
 */

import { describe, expect, test } from 'bun:test';
import { createClientFlight, isSuperseded } from '@ultimat3/core';
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

interface Held {
  readonly fetch: FetchLike;
  readonly calls: () => number;
  readonly signals: readonly (AbortSignal | undefined)[];
  release(): void;
}

/**
 * A fetch that answers nothing until `release()` — the only way two reads are provably in flight
 * at the same instant, which is what dedup is about. An abort rejects that call and no other.
 */
function held(body = '[{"id":"a","title":"t"}]'): Held {
  let calls = 0;
  const signals: (AbortSignal | undefined)[] = [];
  const waiters: Array<() => void> = [];
  return {
    calls: () => calls,
    signals,
    release: () => {
      for (const resume of waiters.splice(0)) resume();
    },
    fetch: (_url, init) => {
      calls += 1;
      const signal = init.signal ?? undefined;
      signals.push(signal);
      return new Promise<Response>((resolve, reject) => {
        waiters.push(() => {
          resolve(new Response(body, { status: 200 }));
        });
        signal?.addEventListener('abort', () => {
          reject(abortRejection());
        });
      });
    },
  };
}

/** What a real `fetch` rejects with when its signal fires. Input to the subject, never a verdict. */
function abortRejection(): unknown {
  const error = new DOMException('The operation was aborted.', 'AbortError');
  return error;
}

describe('dedup, on reads only', () => {
  test('two concurrent identical reads are ONE dispatch, and each gets its own body', async () => {
    const wire = held();
    const flight = createClientFlight({ principal: () => 'alice' });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });

    const first = client.publicPost({ slug: 'x' });
    const second = client.publicPost({ slug: 'x' });
    wire.release();
    const [a, b] = await Promise.all([first, second]);

    expect(wire.calls()).toBe(1);
    expect(a).toEqual(b);
    // Never the same object: a joiner holding the leader's array would see every other joiner's
    // edits, and the shared value is the immutable body TEXT for exactly this reason.
    expect(a).not.toBe(b);
    (a as PostRow[])[0] = { id: 'mutated', title: 'mutated' };
    expect(b[0]?.id).toBe('a');
  });

  test('a key that is only the URL is not enough: a principal change never joins', async () => {
    const wire = held();
    let who = 'alice';
    const flight = createClientFlight({ principal: () => who });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });

    const asAlice = client.publicPost({ slug: 'x' });
    who = 'bob';
    const asBob = client.publicPost({ slug: 'x' });
    wire.release();
    await Promise.all([asAlice, asBob]);

    expect(wire.calls()).toBe(2);
  });

  test('no principal, no dedup — naming who is asking is what turns it on', async () => {
    const wire = held();
    const flight = createClientFlight({});
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });

    const both = Promise.all([client.publicPost({ slug: 'x' }), client.publicPost({ slug: 'x' })]);
    wire.release();
    await both;

    expect(wire.calls()).toBe(2);
    expect(flight.keyFor('/_x/query/public-post')).toBeUndefined();
  });

  test('`fresh: true` refuses to join a dispatch that left before the change did', async () => {
    const wire = held();
    const flight = createClientFlight({ principal: () => 'alice' });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });

    const stale = client.publicPost({ slug: 'x' });
    const afterWrite = client.publicPost({ slug: 'x' }, { fresh: true });
    wire.release();
    await Promise.all([stale, afterWrite]);

    expect(wire.calls()).toBe(2);
  });

  test('a caller-supplied signal disqualifies the read from sharing entirely', async () => {
    const wire = held();
    const flight = createClientFlight({ principal: () => 'alice' });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });
    const controller = new AbortController();

    const shared = client.publicPost({ slug: 'x' });
    const owned = client.publicPost({ slug: 'x' }, { signal: controller.signal });
    wire.release();
    await Promise.all([shared, owned]);

    expect(wire.calls()).toBe(2);
    expect(flight.keyFor('/u', { signal: controller.signal })).toBeUndefined();
  });

  test("one caller's abort does not cancel another caller's read", async () => {
    const wire = held();
    const flight = createClientFlight({ principal: () => 'alice' });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });
    const controller = new AbortController();

    const owned = client.publicPost({ slug: 'x' }, { signal: controller.signal });
    const other = client.publicPost({ slug: 'x' });
    const ownedOutcome = owned.catch((caught: unknown) => caught);
    controller.abort();
    wire.release();

    expect(await ownedOutcome).toBeInstanceOf(DOMException);
    expect(await other).toEqual([{ id: 'a', title: 't' }]);
    expect(wire.calls()).toBe(2);
  });
});

describe('the generation fence', () => {
  test('a fenced read is distinguishable from a failed one, and the socket is closed', async () => {
    const wire = held();
    const flight = createClientFlight({ principal: () => 'alice' });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });

    const pending = client.publicPost({ slug: 'x' }).catch((caught: unknown) => caught);
    flight.bump();
    const outcome = await pending;

    // Not the `AbortError` the socket produced: a caller that cannot tell "superseded" from
    // "failed" retries a request its own context has already replaced.
    expect(isSuperseded(outcome)).toBe(true);
    expect(outcome).toBeUltimateError('X_SUPERSEDED');
    expect(wire.signals[0]?.aborted).toBe(true);
  });

  test('a read issued AFTER the bump is answered normally', async () => {
    const wire = held();
    const flight = createClientFlight({ principal: () => 'alice' });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });

    flight.bump();
    const pending = client.publicPost({ slug: 'x' });
    wire.release();

    expect(await pending).toEqual([{ id: 'a', title: 't' }]);
    expect(flight.generation()).toBe(1);
  });

  test('a read holding its own signal is never aborted by a fence', async () => {
    const wire = held();
    const flight = createClientFlight({ principal: () => 'alice' });
    const client = queryClient<typeof queries>({
      baseUrl: 'https://app.test',
      fetch: wire.fetch,
      flight,
    });
    const controller = new AbortController();

    const pending = client.publicPost({ slug: 'x' }, { signal: controller.signal });
    const outcome = pending.catch((caught: unknown) => caught);
    flight.bump();
    wire.release();

    // The caller still learns it was superseded — it just kept its socket, because it owns one.
    expect(isSuperseded(await outcome)).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });
});
