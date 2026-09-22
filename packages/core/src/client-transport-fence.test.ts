import { afterEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from './client-dispatch';
import { createClientFlight } from './client-flight';
import { rescope } from './client-scope';
import { clientTransport } from './client-transport';
import { failure, fakeFetch, heldFetch, json, recordingSink } from './client-transport-fixture';
import { isUltimateError } from './errors';
import { isSuperseded } from './generation-fence';
import { RECORDS_HEADER } from './record-envelope';
import { pageClient } from './record-sink';
import { parseTraceparent, withSpan } from './telemetry';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

describe('clientTransport — the principal fence', () => {
  test('a GET in flight across rescope rejects X_CLIENT_SCOPE_CHANGED and adopts nothing', async () => {
    const sink = recordingSink();
    const held = heldFetch();
    const pending = failure(
      clientTransport({ method: 'GET', url: '/q', fetchImpl: held.fetchImpl }),
    );
    expect(held.aborted()).toBe(false);
    rescope('user:2');
    // Aborted by the fence itself, synchronously — not merely refused once the answer lands.
    expect(held.aborted()).toBe(true);
    held.release(
      json(
        { data: 1, records: { post: { p1: { id: 'p1' } } } },
        { headers: { [RECORDS_HEADER]: '1' } },
      ),
    );
    const error = await pending;
    expect(isUltimateError(error) && error.code).toBe('X_CLIENT_SCOPE_CHANGED');
    expect(isSuperseded(error)).toBe(true);
    expect(sink.adopted).toEqual([]);
  });

  test('a GET whose answer arrived before the abort could land is still refused', async () => {
    const sink = recordingSink();
    const fetchImpl: FetchLike = async () => {
      // The answer is already here; the rescope happens between it and the caller's continuation.
      queueMicrotask(() => rescope('user:9'));
      return json(
        { data: 1, records: { post: { p1: { id: 'p1' } } } },
        { headers: { [RECORDS_HEADER]: '1' } },
      );
    };
    const error = await failure(clientTransport({ method: 'GET', url: '/q', fetchImpl }));
    expect(isSuperseded(error)).toBe(true);
    expect(sink.adopted).toEqual([]);
  });

  test('a POST in flight across rescope is never aborted: it completes, its records dropped', async () => {
    const sink = recordingSink();
    const held = heldFetch();
    const pending = clientTransport({
      method: 'POST',
      url: '/a',
      body: {},
      fetchImpl: held.fetchImpl,
    });
    rescope('user:2');
    expect(held.aborted()).toBe(false);
    held.release(
      json(
        { data: { ok: true }, records: { post: { p1: { id: 'p1' } } } },
        { headers: { [RECORDS_HEADER]: '1' } },
      ),
    );
    expect(await pending).toEqual({ ok: true });
    expect(sink.adopted).toEqual([]);
  });

  test('a flight-deduped GET across rescope rejects every joiner with the scope refusal', async () => {
    const flight = createClientFlight({ principal: () => pageClient().scope.principal ?? '' });
    const held = heldFetch();
    const a = failure(
      clientTransport({ method: 'GET', url: '/q', flight, fetchImpl: held.fetchImpl }),
    );
    const b = failure(
      clientTransport({ method: 'GET', url: '/q', flight, fetchImpl: held.fetchImpl }),
    );
    rescope('user:2');
    expect(isSuperseded(await a)).toBe(true);
    expect(isSuperseded(await b)).toBe(true);
    expect(flight.inflight).toBe(0);
  });

  test('a rescope listener is released when the request settles', async () => {
    const { fetchImpl } = fakeFetch(() => json(1));
    await clientTransport({ method: 'GET', url: '/q', fetchImpl });
    // Rescoping after the fact reaches no stale controller and changes nothing observable.
    expect(() => rescope('user:5')).not.toThrow();
    const cell = Reflect.get(pageClient(), 'scopeCell') as { listeners: Set<unknown> };
    expect(cell.listeners.size).toBe(0);
  });
});

describe('clientTransport — outbound trace headers', () => {
  test('a browser-shaped call (no context, no span) carries no traceparent', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(1));
    await clientTransport({ method: 'GET', url: '/q', fetchImpl });
    expect(new Headers(calls[0]?.init.headers).get('traceparent')).toBeNull();
  });

  test('a call inside a span continues its trace, and an explicit header still wins', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(1));
    const traceId = await withSpan('a.calls.b', async (span) => {
      await clientTransport({ method: 'GET', url: '/q', fetchImpl });
      await clientTransport({
        method: 'GET',
        url: '/q',
        fetchImpl,
        headers: { traceparent: 'mine' },
      });
      return span.context.traceId;
    });
    const sent = parseTraceparent(new Headers(calls[0]?.init.headers).get('traceparent'));
    expect(sent?.traceId).toBe(traceId);
    expect(new Headers(calls[1]?.init.headers).get('traceparent')).toBe('mine');
  });

  test('a signed raw upload never carries it, even inside a span', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    await withSpan('upload', () =>
      clientTransport({ method: 'PUT', url: 'https://bucket.example/s', rawBody: 'x', fetchImpl }),
    );
    expect(new Headers(calls[0]?.init.headers).get('traceparent')).toBeNull();
  });
});
