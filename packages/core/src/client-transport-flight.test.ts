import { afterEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from './client-dispatch';
import { createClientFlight } from './client-flight';
import { clientTransport } from './client-transport';
import { failure, fakeFetch, json } from './client-transport-fixture';
import { isUltimateError, UltimateError } from './errors';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

describe('clientTransport — flight', () => {
  test('concurrent identical GETs under a flight dispatch once', async () => {
    const flight = createClientFlight({ principal: () => 'user:1' });
    const { fetchImpl, calls } = fakeFetch(() => json({ n: 1 }));
    const [a, b] = await Promise.all([
      clientTransport({ method: 'GET', url: '/q', flight, fetchImpl }),
      clientTransport({ method: 'GET', url: '/q', flight, fetchImpl }),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual({ n: 1 });
    // Each caller parses its own object from the shared text.
    expect(a).not.toBe(b);
  });

  test('a write never dedupes, even two sharing one idempotency key', async () => {
    const flight = createClientFlight({ principal: () => 'user:1' });
    const { fetchImpl, calls } = fakeFetch(() => json({ ok: true }));
    const post = (): Promise<unknown> =>
      clientTransport({
        method: 'POST',
        url: '/a',
        body: {},
        idempotencyKey: 'k',
        flight,
        fetchImpl,
      });
    await Promise.all([post(), post()]);
    expect(calls).toHaveLength(2);
  });

  test('fresh: true refuses to join a read already in flight', async () => {
    const flight = createClientFlight({ principal: () => 'user:1' });
    const { fetchImpl, calls } = fakeFetch(() => json(1));
    await Promise.all([
      clientTransport({ method: 'GET', url: '/q', flight, fetchImpl }),
      clientTransport({ method: 'GET', url: '/q', flight, fetchImpl, fresh: true }),
    ]);
    expect(calls).toHaveLength(2);
  });

  test('a per-call retry reaches the flight', async () => {
    const flight = createClientFlight({ sleep: async () => {} });
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('Failed to fetch');
      return json('ok');
    };
    const data = await clientTransport({
      method: 'GET',
      url: '/q',
      flight,
      fetchImpl,
      retry: { attempts: 3 },
    });
    expect(data).toBe('ok');
    expect(attempts).toBe(3);
  });
});

describe('clientTransport — caller hooks', () => {
  test('rawBody goes out verbatim, with no default header, and the answer is not decoded', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { fetchImpl, calls } = fakeFetch(() => new Response('<xml/>', { status: 200 }));
    const data = await clientTransport({
      method: 'PUT',
      url: 'https://bucket.example/signed',
      rawBody: bytes,
      headers: { 'content-type': 'image/png' },
      fetchImpl,
    });
    expect(data).toBeUndefined();
    expect(calls[0]?.init.body).toBe(bytes);
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'image/png' });
  });

  test("decodeError answers a non-2xx as the caller's own error", async () => {
    const { fetchImpl } = fakeFetch(() => new Response('denied', { status: 403 }));
    const mine = new UltimateError({ code: 'X_UPLOAD_PROBE', cause: 'probe', fix: 'x doctor' });
    const seen: [number, string][] = [];
    const error = await failure(
      clientTransport({
        method: 'PUT',
        url: '/u',
        rawBody: 'x',
        fetchImpl,
        decodeError: (status, text) => {
          seen.push([status, text]);
          return mine;
        },
      }),
    );
    expect(error).toBe(mine);
    expect(seen).toEqual([[403, 'denied']]);
  });

  test('decodeError answering undefined falls back to the shared decode', async () => {
    const { fetchImpl } = fakeFetch(() => json({ code: 'X_POST_LOCKED' }, { status: 409 }));
    const error = await failure(
      clientTransport({ method: 'GET', url: '/q', fetchImpl, decodeError: () => undefined }),
    );
    expect(isUltimateError(error) && error.code).toBe('X_POST_LOCKED');
  });

  test('onResponse sees the response first, and its throw is the answer', async () => {
    const { fetchImpl } = fakeFetch(() => json(1, { headers: { 'x-ultimate-build': 'b2' } }));
    const drift = new UltimateError({ code: 'X_BUILD_PROBE', cause: 'skew', fix: 'x doctor' });
    const error = await failure(
      clientTransport({
        method: 'POST',
        url: '/a',
        fetchImpl,
        onResponse: (response) => {
          if (response.headers.get('x-ultimate-build') !== 'b1') throw drift;
        },
      }),
    );
    expect(error).toBe(drift);
  });
});
