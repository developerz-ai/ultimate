import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { testClock } from './clock';
import { httpOverFetch } from './http';
import type { NetworkEntry } from './rings';
import { createRing } from './rings';
import { EMPTY_SESSION } from './session-state';

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const transport = (
  answer: { status: number; body: string },
  session = EMPTY_SESSION,
  allowHosts: readonly string[] = ['api.test'],
) => {
  const calls: Call[] = [];
  const network = createRing<NetworkEntry>();
  const http = httpOverFetch({
    rules: { allowHosts },
    clock: testClock(),
    timeoutMs: 1_000,
    network,
    session: () => Promise.resolve(session),
    fetch: (url, init) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      return Promise.resolve(new Response(answer.body, { status: answer.status }));
    },
  });
  return { http, calls, network };
};

describe('unit · the HTTP leg is session-bound, not a bare fetch', () => {
  test("the browser session's cookies and user agent ride along", async () => {
    const { http, calls } = transport(
      { status: 200, body: '{}' },
      {
        ...EMPTY_SESSION,
        cookies: [
          {
            name: 'sid',
            value: 'abc',
            domain: 'api.test',
            path: '/',
            httpOnly: true,
            secure: true,
          },
        ],
        headers: { 'x-csrf': 'tok' },
        userAgent: 'Mozilla/5.0 (a real one)',
      },
    );
    await http.request('https://api.test/orders');
    expect(calls[0]?.headers['cookie']).toBe('sid=abc');
    expect(calls[0]?.headers['x-csrf']).toBe('tok');
    expect(calls[0]?.headers['user-agent']).toBe('Mozilla/5.0 (a real one)');
  });

  test('a cookie for another domain is NOT sent', async () => {
    const { http, calls } = transport(
      { status: 200, body: '{}' },
      {
        ...EMPTY_SESSION,
        cookies: [
          {
            name: 'sid',
            value: 'abc',
            domain: 'other.test',
            path: '/',
            httpOnly: true,
            secure: true,
          },
        ],
      },
    );
    await http.request('https://api.test/orders');
    expect(calls[0]?.headers['cookie']).toBeUndefined();
  });

  test('the SAME allow list gates this transport — refused before a byte leaves', async () => {
    const { http, calls } = transport({ status: 200, body: '{}' });
    expect(await codeOf(http.request('https://evil.test/api'))).toBe('X_SCRAPE_HOST_BLOCKED');
    expect(calls).toEqual([]);
  });

  test('every request is recorded in the same network ring the page uses', async () => {
    const { http, network } = transport({ status: 204, body: '' });
    await http.request('https://api.test/orders');
    expect(network.entries().map((entry) => [entry.method, entry.status])).toEqual([['GET', 204]]);
  });
});

describe('unit · reading a response', () => {
  const orders = t.object({ id: t.number });

  test('parse() refuses a non-2xx BEFORE the schema runs', async () => {
    const { http } = transport({ status: 503, body: 'upstream down' });
    const response = await http.request('https://api.test/orders');
    expect(response.ok).toBe(false);
    expect(await codeOf(response.parse(orders))).toBe('X_SCRAPE_HTTP_FAILED');
  });

  test('a 4xx is TERMINAL and a 429 is not — same code, the throw site decides', async () => {
    const notFound = await (await transport({ status: 404, body: 'no' }).http).request(
      'https://api.test/orders',
    );
    let terminal: unknown;
    try {
      await notFound.parse(orders);
    } catch (thrown) {
      terminal = thrown;
    }
    expect((terminal as { retry?: string }).retry).toBe('terminal');

    const throttled = await transport({ status: 429, body: 'slow down' }).http.request(
      'https://api.test/orders',
    );
    let retryable: unknown;
    try {
      await throttled.parse(orders);
    } catch (thrown) {
      retryable = thrown;
    }
    expect((retryable as { retry?: string }).retry).toBe('retryable');
  });

  test('a 2xx body is parsed by the schema, and json() stays unknown', async () => {
    const { http } = transport({ status: 200, body: '{"id":7}' });
    const response = await http.request('https://api.test/orders');
    expect(await response.parse(orders)).toEqual({ id: 7 });
    expect(await response.json()).toEqual({ id: 7 });
  });
});

describe('unit · the session jar is EVERY domain the browser touched, so scoping is a security rule', () => {
  const hostOnly = (domain: string, path = '/') => ({
    ...EMPTY_SESSION,
    cookies: [{ name: 'sid', value: 'SECRET', domain, path, httpOnly: true, secure: true }],
  });

  test('a host-only bank.test cookie never reaches evilbank.test — a suffix is not a domain', async () => {
    const { http, calls } = transport({ status: 200, body: '{}' }, hostOnly('bank.test'), ['*']);
    await http.request('https://evilbank.test/a');
    expect(calls[0]?.headers['cookie']).toBeUndefined();
  });

  test('a host-only bank.test cookie never reaches sub.bank.test — host-only means the host', async () => {
    const { http, calls } = transport({ status: 200, body: '{}' }, hostOnly('bank.test'), ['*']);
    await http.request('https://sub.bank.test/a');
    expect(calls[0]?.headers['cookie']).toBeUndefined();
  });

  test('the cookie DOES reach the host it belongs to', async () => {
    const { http, calls } = transport({ status: 200, body: '{}' }, hostOnly('bank.test'), ['*']);
    await http.request('https://bank.test/a');
    expect(calls[0]?.headers['cookie']).toBe('sid=SECRET');
  });

  test('a domain-scoped .bank.test cookie DOES reach a subdomain, and still not evilbank.test', async () => {
    const { http, calls } = transport({ status: 200, body: '{}' }, hostOnly('.bank.test'), ['*']);
    await http.request('https://sub.bank.test/a');
    await http.request('https://evilbank.test/a');
    expect(calls[0]?.headers['cookie']).toBe('sid=SECRET');
    expect(calls[1]?.headers['cookie']).toBeUndefined();
  });

  test('a cookie scoped to /admin is not sent to /public', async () => {
    const { http, calls } = transport(
      { status: 200, body: '{}' },
      hostOnly('bank.test', '/admin'),
      ['*'],
    );
    await http.request('https://bank.test/public');
    await http.request('https://bank.test/admin/users');
    expect(calls[0]?.headers['cookie']).toBeUndefined();
    expect(calls[1]?.headers['cookie']).toBe('sid=SECRET');
  });
});

describe('unit · the response body is bounded by BYTES, not only by time', () => {
  const withBody = (body: string | ReadableStream<Uint8Array>, headers?: Headers) =>
    httpOverFetch({
      rules: { allowHosts: ['api.test'] },
      clock: testClock(),
      timeoutMs: 1_000,
      network: createRing<NetworkEntry>(),
      session: () => Promise.resolve(EMPTY_SESSION),
      fetch: () =>
        Promise.resolve(
          new Response(body, { status: 200, ...(headers === undefined ? {} : { headers }) }),
        ),
    });

  test('a body past maxBytes is refused rather than buffered whole', async () => {
    const http = withBody('x'.repeat(4_096));
    expect(await codeOf(http.request('https://api.test/export', { maxBytes: 1_024 }))).toBe(
      'X_SCRAPE_BODY_TOO_LARGE',
    );
  });

  test('a body inside the cap is returned untouched', async () => {
    const http = withBody('{"ok":true}');
    const response = await http.request('https://api.test/orders', { maxBytes: 1_024 });
    expect(await response.json()).toEqual({ ok: true });
  });

  test('the cap is applied with no maxBytes on the call — the default is not optional', async () => {
    // A stream that never ends is the shape that matters: `.text()` on it never returns, and the
    // deadline it would eventually hit does not un-allocate what was already read.
    let pushed = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pushed += 1;
        if (pushed > 5_000) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const http = httpOverFetch({
      rules: { allowHosts: ['api.test'] },
      clock: testClock(),
      timeoutMs: 1_000,
      network: createRing<NetworkEntry>(),
      session: () => Promise.resolve(EMPTY_SESSION),
      fetch: () => Promise.resolve(new Response(endless, { status: 200 })),
    });
    expect(await codeOf(http.request('https://api.test/firehose', { maxBytes: 256 * 1024 }))).toBe(
      'X_SCRAPE_BODY_TOO_LARGE',
    );
  });
});

describe('unit · response headers are data, not a prototype the site can reach', () => {
  const withHeaders = (headers: Headers) =>
    httpOverFetch({
      rules: { allowHosts: ['api.test'] },
      clock: testClock(),
      timeoutMs: 1_000,
      network: createRing<NetworkEntry>(),
      session: () => Promise.resolve(EMPTY_SESSION),
      fetch: () => Promise.resolve(new Response('{}', { status: 200, headers })),
    });

  test('a site sending __proto__ and constructor gets both filed as ordinary keys', async () => {
    const headers = new Headers();
    headers.append('__proto__', 'evil');
    headers.append('constructor', 'c');
    headers.append('x-real', 'ok');
    const response = await withHeaders(headers).request('https://api.test/orders');
    expect([...Object.keys(response.headers)].sort()).toEqual([
      '__proto__',
      'constructor',
      'x-real',
    ]);
    // Read through the descriptor: the assertion is that the site's header is an OWN key, and
    // spelling `headers['__proto__']` in a test is the very accessor this fix routes around.
    expect(Object.getOwnPropertyDescriptor(response.headers, '__proto__')?.value).toBe('evil');
    expect(response.headers['constructor']).toBe('c');
  });

  test('a header the site never sent is not readable off the record', async () => {
    const response = await withHeaders(new Headers({ 'x-real': 'ok' })).request(
      'https://api.test/orders',
    );
    expect(response.headers['toString']).toBeUndefined();
    expect(response.headers['hasOwnProperty']).toBeUndefined();
  });
});
