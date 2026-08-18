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
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      return Promise.resolve(new Response(answer.body, { status: answer.status }));
    }) as unknown as typeof fetch,
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
    expect(calls[0]?.headers.cookie).toBe('sid=abc');
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
    expect(calls[0]?.headers.cookie).toBeUndefined();
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
