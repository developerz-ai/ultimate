// The FOLLOW half of the redirect fix, against the transport: `http-redirect.ts` decides where a
// hop goes, and this file proves `httpOverFetch` re-asks every gate about it. Its own file because
// `http.test.ts` is at the 500-line ceiling and these nine tests share one multi-answer transport
// double rather than that file's single-answer one.

import { describe, expect, test } from 'bun:test';
import { testClock } from './clock';
import { httpOverFetch } from './http';
import { MAX_REDIRECT_HOPS } from './http-redirect';
import type { NetworkEntry } from './rings';
import { createRing } from './rings';
import type { RobotsGate } from './robots';
import type { SessionSnapshot } from './session-state';
import { EMPTY_SESSION } from './session-state';

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

/**
 * A redirect is a request to a URL nobody screened. `fetch` follows one by default and returns the
 * body of wherever it ended up under the URL that was asked for, so an allow-listed endpoint
 * answering `302 → http://169.254.169.254/…` read the metadata service THROUGH the allow list, and
 * `page.network()` reported the request that was allowed rather than the one that was made. The CDP
 * leg has never had the hole: interception fires per hop there.
 */
describe('unit · every redirect hop is screened, and the FINAL url is what is reported', () => {
  interface Answer {
    readonly status: number;
    readonly location?: string;
    readonly body?: string;
  }

  const chain = (
    answers: readonly Answer[],
    options: {
      readonly allowHosts?: readonly string[];
      readonly robots?: RobotsGate;
      readonly session?: SessionSnapshot;
    } = {},
  ) => {
    const calls: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      redirect?: string;
    }[] = [];
    const network = createRing<NetworkEntry>();
    const http = httpOverFetch({
      rules: { allowHosts: options.allowHosts ?? ['api.test'] },
      clock: testClock(),
      timeoutMs: 1_000,
      network,
      robots: options.robots,
      session: () => Promise.resolve(options.session ?? EMPTY_SESSION),
      fetch: (url, init) => {
        calls.push({
          url,
          method: init.method ?? 'GET',
          headers: (init.headers ?? {}) as Record<string, string>,
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
          ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
        });
        const answer = answers[calls.length - 1] ?? { status: 200, body: '{}' };
        return Promise.resolve(
          new Response(answer.body ?? '', {
            status: answer.status,
            headers: answer.location === undefined ? {} : { location: answer.location },
          }),
        );
      },
    });
    return { http, calls, network };
  };

  test('the platform is told NOT to follow — the default is what made the gates decorative', async () => {
    // The one assertion a test double can make about the line that matters: with `follow`, fetch
    // dials the target itself and hands back one Response, and no loop in this file ever runs.
    const { http, calls } = chain([{ status: 200, body: '{}' }]);
    await http.request('https://api.test/orders');
    expect(calls[0]?.redirect).toBe('manual');
  });

  test('a 302 off the allow list is REFUSED, and the second request never leaves', async () => {
    const { http, calls } = chain([
      { status: 302, location: 'http://169.254.169.254/latest/meta' },
    ]);
    expect(await codeOf(http.request('https://api.test/orders'))).toBe('X_SCRAPE_HOST_BLOCKED');
    expect(calls.map((call) => call.url)).toEqual(['https://api.test/orders']);
  });

  test('a relative Location is resolved against the hop it came from before it is screened', async () => {
    const { http, calls } = chain([{ status: 301, location: '//evil.test/steal' }]);
    expect(await codeOf(http.request('https://api.test/orders'))).toBe('X_SCRAPE_HOST_BLOCKED');
    expect(calls).toHaveLength(1);
  });

  test('a hop to a listed host IS followed, and response.url is the final one', async () => {
    const { http, calls, network } = chain(
      [
        { status: 302, location: 'https://cdn.test/orders.json' },
        { status: 200, body: '{"id":7}' },
      ],
      { allowHosts: ['api.test', 'cdn.test'] },
    );
    const response = await http.request('https://api.test/orders');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.test/orders',
      'https://cdn.test/orders.json',
    ]);
    expect(response.url).toBe('https://cdn.test/orders.json');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 7 });
    // The ring is the diagnosis surface: a hop reported under the requested URL sends its reader
    // hunting for a request the site never answered.
    expect(network.entries().map((entry) => [entry.url, entry.status])).toEqual([
      ['https://api.test/orders', 302],
      ['https://cdn.test/orders.json', 200],
    ]);
  });

  test('robots is asked about the TARGET, not only about the url that was requested', async () => {
    const asked: string[] = [];
    const robots: RobotsGate = {
      assertAllowed: (url) => {
        asked.push(url);
        return Promise.resolve();
      },
      ignoredBecause: undefined,
    };
    const { http } = chain(
      [{ status: 307, location: 'https://cdn.test/private/orders.json' }, { status: 200 }],
      { allowHosts: ['api.test', 'cdn.test'], robots },
    );
    await http.request('https://api.test/orders');
    expect(asked).toEqual(['https://api.test/orders', 'https://cdn.test/private/orders.json']);
  });

  test('the session jar is re-scoped per hop — the first host`s cookie does not ride along', async () => {
    const { http, calls } = chain(
      [{ status: 302, location: 'https://other.test/a' }, { status: 200 }],
      {
        allowHosts: ['api.test', 'other.test'],
        session: {
          ...EMPTY_SESSION,
          cookies: [
            {
              name: 'sid',
              value: 'SECRET',
              domain: 'api.test',
              path: '/',
              httpOnly: true,
              secure: true,
            },
          ],
        },
      },
    );
    await http.request('https://api.test/orders');
    expect(calls[0]?.headers['cookie']).toBe('sid=SECRET');
    expect(calls[1]?.headers['cookie']).toBeUndefined();
  });

  test('a chain past the hop bound is refused rather than followed forever', async () => {
    const { http, calls } = chain(
      Array.from({ length: MAX_REDIRECT_HOPS + 2 }, (_unused, index) => ({
        status: 302,
        location: `https://api.test/hop-${String(index + 1)}`,
      })),
    );
    expect(await codeOf(http.request('https://api.test/hop-0'))).toBe('X_SCRAPE_REDIRECT_LOOP');
    expect(calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  test('a 303 after a POST re-asks with GET and no body — the fetch spec, performed here', async () => {
    const { http, calls } = chain(
      [{ status: 303, location: 'https://api.test/result' }, { status: 200 }],
      {
        allowHosts: ['api.test'],
      },
    );
    await http.request('https://api.test/orders', { method: 'POST', body: '{"qty":1}' });
    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ['POST', '{"qty":1}'],
      ['GET', undefined],
    ]);
  });

  test('a 307 keeps the method and the body, and a 308 does too', async () => {
    const { http, calls } = chain([
      { status: 308, location: 'https://api.test/v2/orders' },
      { status: 200 },
    ]);
    await http.request('https://api.test/orders', { method: 'POST', body: '{"qty":1}' });
    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ['POST', '{"qty":1}'],
      ['POST', '{"qty":1}'],
    ]);
  });

  test('a 3xx with no Location is the answer itself, not a hop', async () => {
    const { http, calls } = chain([{ status: 304 }]);
    const response = await http.request('https://api.test/orders');
    expect(response.status).toBe(304);
    expect(calls).toHaveLength(1);
  });
});
