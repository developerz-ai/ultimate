import { afterEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from './client-dispatch';
import { IDEMPOTENCY_HEADER } from './client-dispatch';
import { rescope } from './client-scope';
import { clientTransport } from './client-transport';
import { failure, fakeFetch, heldFetch, json, recordingSink } from './client-transport-fixture';
import { isUltimateError } from './errors';
import { RECORDS_HEADER } from './record-envelope';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

describe('clientTransport — the wire', () => {
  test('sends same-origin credentials, JSON, and the idempotency key', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ ok: true }));
    const data = await clientTransport({
      method: 'POST',
      url: '/_x/a/createPost',
      body: { title: 'hi' },
      idempotencyKey: 'k-1',
      headers: { 'x-extra': '1' },
      fetchImpl,
    });
    expect(data).toEqual({ ok: true });
    const init = calls[0]?.init;
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBe('{"title":"hi"}');
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(IDEMPOTENCY_HEADER)).toBe('k-1');
    expect(headers.get('x-extra')).toBe('1');
  });

  test('a non-2xx problem+json becomes the server code, marked remote', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        {
          code: 'X_POST_LOCKED',
          cause: 'post p1 is locked',
          fix: 'x errors explain X_POST_LOCKED --json',
        },
        { status: 409 },
      ),
    );
    const error = await failure(clientTransport({ method: 'GET', url: '/_x/q/post', fetchImpl }));
    if (!isUltimateError(error)) return expect.unreachable('not an UltimateError');
    expect(error.code).toBe('X_POST_LOCKED');
    expect(error.cause).toBe('post p1 is locked');
    expect(error.fix).toBe('x errors explain X_POST_LOCKED --json');
    expect(error.meta).toMatchObject({ origin: 'remote', status: 409 });
    // 409 is a retryable status and nobody classified X_POST_LOCKED.
    expect(error.retry).toBe('retryable');
  });

  test('a non-2xx body naming no framework code is X_CLIENT_TRANSPORT_FAILED', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('<html>bad gateway</html>', { status: 502 }),
    );
    const error = await failure(clientTransport({ method: 'GET', url: '/_x/q/post', fetchImpl }));
    expect(isUltimateError(error) && error.code).toBe('X_CLIENT_TRANSPORT_FAILED');
    expect(isUltimateError(error) && error.meta?.['failure']).toBe('status');
  });

  test('a 2xx body that is not JSON is X_CLIENT_TRANSPORT_FAILED, failure body', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>proxy</html>', { status: 200 }));
    const error = await failure(clientTransport({ method: 'GET', url: '/q', fetchImpl }));
    expect(isUltimateError(error) && error.code).toBe('X_CLIENT_TRANSPORT_FAILED');
    expect(isUltimateError(error) && error.meta?.['failure']).toBe('body');
  });

  test('a network TypeError is X_CLIENT_TRANSPORT_FAILED, keeping the original', async () => {
    const dropped = new TypeError('Failed to fetch');
    const fetchImpl: FetchLike = () => Promise.reject(dropped);
    const error = await failure(clientTransport({ method: 'GET', url: '/_x/q/post', fetchImpl }));
    if (!isUltimateError(error)) return expect.unreachable('not an UltimateError');
    expect(error.code).toBe('X_CLIENT_TRANSPORT_FAILED');
    expect(error.sourceError).toBe(dropped);
    expect(error.retry).toBe('retryable');
    // The one an offline outbox queues on: no response at all.
    expect(error.meta?.['failure']).toBe('network');
  });

  test('an unkeyed write that got no response is not announced as retryable', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await failure(clientTransport({ method: 'POST', url: '/_x/a/pay', fetchImpl }));
    expect(isUltimateError(error) && error.retry).toBe('terminal');
  });

  test('a caller abort is the caller decision, never a transport failure', async () => {
    const held = heldFetch();
    const controller = new AbortController();
    const pending = failure(
      clientTransport({
        method: 'GET',
        url: '/q',
        signal: controller.signal,
        fetchImpl: held.fetchImpl,
      }),
    );
    controller.abort();
    const error = await pending;
    expect(isUltimateError(error)).toBe(false);
    expect(error instanceof DOMException && error.name).toBe('AbortError');
  });

  test('a 204 answers undefined', async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    expect(
      await clientTransport<unknown>({ method: 'DELETE', url: '/x', fetchImpl }),
    ).toBeUndefined();
  });
});

describe('clientTransport — records', () => {
  test('an enveloped answer adopts its records and removals, and returns data alone', async () => {
    const sink = recordingSink();
    const { fetchImpl } = fakeFetch(() =>
      json(
        { data: { id: 'p1' }, records: { post: { p1: { id: 'p1' } } }, removed: { post: ['p0'] } },
        { headers: { [RECORDS_HEADER]: '1' } },
      ),
    );
    expect(await clientTransport<unknown>({ method: 'GET', url: '/q', fetchImpl })).toEqual({
      id: 'p1',
    });
    expect(sink.adopted).toEqual([['post', { p1: { id: 'p1' } }]]);
    expect(sink.removed).toEqual([['post', ['p0']]]);
  });

  test('onEnvelope sees the decoded envelope after adoption, keys in wire order', async () => {
    const sink = recordingSink();
    const seen: string[][] = [];
    const { fetchImpl } = fakeFetch(() =>
      json(
        { data: 1, records: { post: { p2: { id: 'p2' }, p1: { id: 'p1' } } } },
        { headers: { [RECORDS_HEADER]: '1' } },
      ),
    );
    await clientTransport({
      method: 'GET',
      url: '/q',
      fetchImpl,
      onEnvelope: (envelope) => {
        // Adopted first: the store already holds what the callback is told about.
        expect(sink.adopted).toHaveLength(1);
        seen.push(Object.keys(envelope.records?.['post'] ?? {}));
      },
    });
    expect(seen).toEqual([['p2', 'p1']]);
  });

  test('onEnvelope is not called for a bare answer, nor for a write across a rescope', async () => {
    let calls = 0;
    const onEnvelope = (): void => {
      calls += 1;
    };
    const bare = fakeFetch(() => json({ ok: true }));
    await clientTransport({ method: 'GET', url: '/q', fetchImpl: bare.fetchImpl, onEnvelope });
    const held = heldFetch();
    const pending = clientTransport({
      method: 'POST',
      url: '/a',
      fetchImpl: held.fetchImpl,
      onEnvelope,
    });
    rescope('user:2');
    held.release(
      json(
        { data: 1, records: { post: { p1: { id: 'p1' } } } },
        { headers: { [RECORDS_HEADER]: '1' } },
      ),
    );
    await pending;
    expect(calls).toBe(0);
  });

  test('without the header the body IS the data, even when it looks like an envelope', async () => {
    const sink = recordingSink();
    const body = { data: 1, records: { post: { p1: { id: 'p1' } } } };
    const { fetchImpl } = fakeFetch(() => json(body));
    expect(await clientTransport<unknown>({ method: 'GET', url: '/q', fetchImpl })).toEqual(body);
    expect(sink.adopted).toEqual([]);
  });

  test('in a browser page, records answered before the store exists reach it on install', async () => {
    Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
    Reflect.set(globalThis, 'document', { querySelector: () => null });
    try {
      const { fetchImpl } = fakeFetch(() =>
        json(
          { data: 7, records: { post: { p1: { id: 'p1' } } } },
          { headers: { [RECORDS_HEADER]: '1' } },
        ),
      );
      await clientTransport({ method: 'GET', url: '/q', fetchImpl });
      const sink = recordingSink();
      expect(sink.adopted).toEqual([['post', { p1: { id: 'p1' } }]]);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  test('no store installed drops the records without throwing', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(
        { data: 7, records: { post: { p1: { id: 'p1' } } } },
        { headers: { [RECORDS_HEADER]: '1' } },
      ),
    );
    expect(await clientTransport<unknown>({ method: 'GET', url: '/q', fetchImpl })).toBe(7);
  });
});

// Two app islands read an HTML answer (a re-rendered fragment, a search index page) and had no way
// to: the transport decoded JSON only, so each read the body off `onResponse` and swallowed the
// transport's own "2xx with a body that is not JSON" refusal.
describe('clientTransport — responseType: text', () => {
  test('answers the body as a string, asks for any type, and adopts nothing', async () => {
    const { adopted } = recordingSink();
    const html = '<ul><li>term</li></ul>';
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(html, { headers: { 'content-type': 'text/html', [RECORDS_HEADER]: '1' } }),
    );
    const body: string = await clientTransport({
      method: 'GET',
      url: '/terminos?dias=5',
      responseType: 'text',
      fetchImpl,
    });
    expect(body).toBe(html);
    expect(new Headers(calls[0]?.init.headers).get('accept')).toBe('*/*');
    expect(adopted).toEqual([]);
  });

  test('an empty 2xx is the empty string, never undefined', async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
    expect(
      await clientTransport({ method: 'POST', url: '/ping', responseType: 'text', fetchImpl }),
    ).toBe('');
  });

  test('a non-2xx is still decoded as a refusal', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ code: 'X_POST_LOCKED', cause: 'c', fix: 'f' }, { status: 409 }),
    );
    const error = await failure(
      clientTransport({ method: 'GET', url: '/x', responseType: 'text', fetchImpl }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_POST_LOCKED');
  });

  test('the default is still JSON: a non-JSON 2xx is refused', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html></html>'));
    const error = await failure(clientTransport({ method: 'GET', url: '/x', fetchImpl }));
    expect(isUltimateError(error) ? error.code : error).toBe('X_CLIENT_TRANSPORT_FAILED');
  });
});
