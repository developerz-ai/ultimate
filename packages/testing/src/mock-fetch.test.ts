// `mockFetch` as a retry test uses it: a verb in the match, answers in order, a pinned dial's name,
// and `requestLog` holding what each call sent. The seal's own refusals are `sealed-network.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  allowHost,
  captureNetwork,
  mockFetch,
  mockJson,
  requestLog,
  resetNetwork,
  restoreCapturedNetwork,
  sealNetwork,
  setNetworkState,
  unsealNetwork,
} from './sealed-network';
import { testName } from './test-types';

sealNetwork();

afterEach(resetNetwork);

const VENDOR = 'https://vendor.test/a';
const ADDRESS = '203.0.113.9';

/** The refusal's code when the call was refused, `undefined` when something answered it. */
const refusalCode = async (url: string, init?: RequestInit): Promise<string | undefined> =>
  fetch(url, init).then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

describe(testName('unit', 'mockFetch — a verb in the match'), () => {
  test('a method prefix answers its verb and misses the other', async () => {
    mockJson(`POST ${VENDOR}`, { verb: 'post' });
    const answered = await fetch(VENDOR, { method: 'post' });
    expect(await answered.json()).toEqual({ verb: 'post' });
    expect(await refusalCode(VENDOR)).toBe('X_TEST_NETWORK_SEALED');
  });

  test('two verbs on one URL are two registrations', async () => {
    mockJson(`GET ${VENDOR}`, { verb: 'get' });
    mockJson(`POST ${VENDOR}`, { verb: 'post' });
    expect(await (await fetch(VENDOR)).json()).toEqual({ verb: 'get' });
    expect(await (await fetch(VENDOR, { method: 'POST' })).json()).toEqual({ verb: 'post' });
  });

  test('a method prefix keeps the wildcard its URL part spells', async () => {
    mockJson('DELETE https://vendor.test/*', { ok: true });
    expect(await refusalCode('https://vendor.test/x/y', { method: 'DELETE' })).toBeUndefined();
    expect(await refusalCode('https://vendor.test/x/y', { method: 'PUT' })).toBe(
      'X_TEST_NETWORK_SEALED',
    );
  });

  test('the verb of a Request input is the one matched', async () => {
    mockJson(`POST ${VENDOR}`, { ok: true });
    expect((await fetch(new Request(VENDOR, { method: 'POST' }))).status).toBe(200);
    await expect(fetch(new Request(VENDOR))).rejects.toBeUltimateError('X_TEST_NETWORK_SEALED');
  });

  test('a bare URL and a RegExp still answer every verb', async () => {
    mockJson(VENDOR, { ok: 'bare' });
    mockJson(/vendor\.test\/regexp$/, { ok: 'regexp' });
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(await refusalCode(VENDOR, { method })).toBeUndefined();
      expect(await refusalCode('https://vendor.test/regexp', { method })).toBeUndefined();
    }
  });

  test('init overriding a Request reaches the handler, the same verb the route matched', async () => {
    const seen: string[] = [];
    mockFetch(`PUT ${VENDOR}`, (request) => {
      seen.push(request.method);
      return new Response(null, { status: 204 });
    });
    await fetch(new Request(VENDOR, { method: 'POST' }), { method: 'PUT' });
    expect(seen).toEqual(['PUT']);
  });
});

describe(testName('unit', 'mockFetch — answers in order'), () => {
  test('a retry test: 503 then 200, the last repeated with a body still readable', async () => {
    mockFetch(VENDOR, [new Response('busy', { status: 503 }), new Response('done')]);
    const answers: [number, string][] = [];
    for (const _ of [1, 2, 3, 4]) {
      const response = await fetch(VENDOR);
      answers.push([response.status, await response.text()]);
    }
    expect(answers).toEqual([
      [503, 'busy'],
      [200, 'done'],
      [200, 'done'],
      [200, 'done'],
    ]);
  });

  test('answers go in call order, not in the order bodies finish being read', async () => {
    mockFetch(`${VENDOR}/*`, [new Response(null, { status: 503 }), new Response(null)]);
    const slow = fetch(`${VENDOR}/a`, { method: 'POST', body: new Blob(['large']).stream() });
    const fast = fetch(`${VENDOR}/b`);
    const statuses = (await Promise.all([slow, fast])).map((response) => response.status);
    expect(requestLog().map((call) => call.url)).toEqual([`${VENDOR}/a`, `${VENDOR}/b`]);
    expect(statuses).toEqual([503, 200]);
  });

  test('an Error in the list is thrown, and repeats when it is the last', async () => {
    const reset = new TypeError('connection reset');
    mockFetch(VENDOR, [new Response('first'), reset]);
    expect(await (await fetch(VENDOR)).text()).toBe('first');
    await expect(fetch(VENDOR)).rejects.toBe(reset);
    await expect(fetch(VENDOR)).rejects.toBe(reset);
  });

  test('each registration keeps its own place', async () => {
    mockFetch(`${VENDOR}/1`, [new Response('1a'), new Response('1b')]);
    mockFetch(`${VENDOR}/2`, [new Response('2a'), new Response('2b')]);
    expect(await (await fetch(`${VENDOR}/1`)).text()).toBe('1a');
    expect(await (await fetch(`${VENDOR}/2`)).text()).toBe('2a');
    expect(await (await fetch(`${VENDOR}/1`)).text()).toBe('1b');
  });

  test('the list is read at registration: a later push is not an answer', async () => {
    const answers = [new Response('only')];
    mockFetch(VENDOR, answers);
    answers.push(new Response('late'));
    await fetch(VENDOR);
    expect(await (await fetch(VENDOR)).text()).toBe('only');
  });

  test('an empty list is refused at registration, naming the match', () => {
    let refusal: unknown;
    try {
      mockFetch(`POST ${VENDOR}`, []);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeUltimateError('X_INVARIANT');
    expect((refusal as { cause: string }).cause).toContain(`POST ${VENDOR}`);
    expect(() => mockFetch(/vendor/, [])).toThrow('/vendor/');
  });
});

describe(testName('unit', 'requestLog'), () => {
  test('one registration answers a retry test and proves the header and the body', async () => {
    mockFetch(`POST ${VENDOR}`, [new Response('busy', { status: 503 }), new Response('done')]);
    const send = (): Promise<Response> =>
      fetch(VENDOR, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk_1' },
        body: JSON.stringify({ n: 1 }),
      });
    expect((await send()).status).toBe(503);
    expect((await send()).status).toBe(200);
    const call = {
      method: 'POST',
      url: VENDOR,
      headers: expect.objectContaining({ authorization: 'Bearer sk_1' }),
      body: '{"n":1}',
    };
    expect(requestLog()).toEqual([call, call]);
  });

  test('a handler still reads the body the log read', async () => {
    const read: string[] = [];
    mockFetch(VENDOR, async (request) => {
      read.push(await request.text());
      return new Response(null, { status: 204 });
    });
    await fetch(VENDOR, { method: 'POST', body: 'from-init' });
    await fetch(new Request(VENDOR, { method: 'POST', body: 'from-request' }));
    expect(read).toEqual(['from-init', 'from-request']);
    expect(requestLog().map((call) => call.body)).toEqual(['from-init', 'from-request']);
  });

  test('a streamed body reaches a mock whole, and the log', async () => {
    let read = '';
    mockFetch(VENDOR, async (request) => {
      read = await request.text();
      return new Response(null, { status: 204 });
    });
    await fetch(VENDOR, { method: 'POST', body: new Blob(['streamed']).stream() });
    expect(read).toBe('streamed');
    expect(requestLog()[0]?.body).toBe('streamed');
  });

  test('a call with no body logs null; an empty body logs the empty string', async () => {
    mockJson(VENDOR, {});
    await fetch(VENDOR);
    await fetch(VENDOR, { method: 'POST', body: '' });
    expect(requestLog().map((call) => call.body)).toEqual([null, '']);
  });

  test('the entry is in place when fetch returns its promise, so concurrent calls keep order', async () => {
    mockJson(`${VENDOR}/1`, {});
    mockJson(`${VENDOR}/2`, {});
    const calls = [
      fetch(`${VENDOR}/1`, { method: 'POST', body: new Blob(['large']).stream() }),
      fetch(`${VENDOR}/2`),
    ];
    expect(requestLog().map((call) => call.url)).toEqual([`${VENDOR}/1`, `${VENDOR}/2`]);
    await Promise.all(calls);
    expect(requestLog()[0]?.body).toBe('large');
  });

  test('a refused call is logged too: sealed with its body, offline with its body', async () => {
    await expect(fetch(VENDOR, { method: 'POST', body: 'sealed' })).rejects.toBeUltimateError(
      'X_TEST_NETWORK_SEALED',
    );
    setNetworkState('offline');
    await expect(fetch(VENDOR, { method: 'POST', body: 'offline' })).rejects.toBeUltimateError(
      'X_TEST_NETWORK_OFFLINE',
    );
    expect(requestLog().map((call) => call.body)).toEqual(['sealed', 'offline']);
  });

  test('a URL no Request can hold still reaches the seal, logged without headers', async () => {
    expect(await refusalCode('not a url', { headers: { a: 'b' } })).toBe('X_TEST_NETWORK_SEALED');
    expect(requestLog()).toEqual([{ method: 'GET', url: 'not a url', headers: {}, body: null }]);
  });

  test('a body that cannot be read is logged null, and the refusal stays the seal', async () => {
    const used = new Request(VENDOR, { method: 'POST', body: 'x' });
    await used.text();
    await expect(fetch(used)).rejects.toBeUltimateError('X_TEST_NETWORK_SEALED');
    expect(requestLog()[0]?.body).toBeNull();
  });

  test('a body that fails as it is read is logged null, and the refusal stays the seal', async () => {
    const missing = Bun.file('/nonexistent/sealed-network-body');
    await expect(fetch(VENDOR, { method: 'POST', body: missing })).rejects.toBeUltimateError(
      'X_TEST_NETWORK_SEALED',
    );
    expect(requestLog()[0]?.body).toBeNull();
  });

  test('resetNetwork clears it', async () => {
    mockJson(VENDOR, {});
    await fetch(VENDOR);
    resetNetwork();
    expect(requestLog()).toEqual([]);
  });

  test('a nested captureNetwork restores the log', async () => {
    mockJson(VENDOR, {});
    await fetch(VENDOR, { method: 'POST', body: 'outer' });
    const snapshot = captureNetwork();
    resetNetwork();
    expect(requestLog()).toEqual([]);
    mockJson(VENDOR, {});
    await fetch(VENDOR, { method: 'POST', body: 'inner' });
    restoreCapturedNetwork(snapshot);
    expect(requestLog().map((call) => call.body)).toEqual(['outer']);
  });
});

describe(testName('unit', 'mockFetch — a pinned dial'), () => {
  const pinned = (url: string, host: string): Promise<Response> =>
    fetch(url, { headers: { host } });

  test('an address literal carrying a host header answers the mock of that name', async () => {
    mockJson('https://vendor.test/a', { via: 'name' });
    const response = await pinned(`https://${ADDRESS}/a`, 'vendor.test');
    expect(await response.json()).toEqual({ via: 'name' });
  });

  test('the literal URL itself still matches, and the log keeps the URL dialled', async () => {
    mockJson(`https://${ADDRESS}/a`, { via: 'literal' });
    expect(await (await pinned(`https://${ADDRESS}/a`, 'vendor.test')).json()).toEqual({
      via: 'literal',
    });
    expect(requestLog()[0]?.url).toBe(`https://${ADDRESS}/a`);
  });

  test.each([
    [
      'a port',
      `https://${ADDRESS}:8443/a?b=1`,
      'vendor.test:8443',
      'https://vendor.test:8443/a?b=1',
    ],
    ['an IPv6 literal', 'https://[2001:db8::1]/a', 'vendor.test', 'https://vendor.test/a'],
    ['plain http', `http://${ADDRESS}/a`, 'vendor.test', 'http://vendor.test/a'],
  ])('%s', async (_name, url, host, mocked) => {
    mockJson(mocked, { ok: true });
    expect((await pinned(url, host)).status).toBe(200);
  });

  test('a Request input, a RegExp and a verb all match the name', async () => {
    mockJson(/^https:\/\/vendor\.test\/regexp$/, { ok: true });
    mockJson('POST https://vendor.test/verb', { ok: true });
    const headers = { host: 'vendor.test' };
    const regexp = new Request(`https://${ADDRESS}/regexp`, { headers });
    expect((await fetch(regexp)).status).toBe(200);
    const verb = { method: 'POST', headers };
    expect(await refusalCode(`https://${ADDRESS}/verb`, verb)).toBeUndefined();
    expect(await refusalCode(`https://${ADDRESS}/verb`, { headers })).toBe('X_TEST_NETWORK_SEALED');
  });

  test('the name is read from a literal alone: a named URL never borrows its header', async () => {
    mockJson('https://vendor.test/a', {});
    const borrowed = { headers: { host: 'vendor.test' } };
    expect(await refusalCode('https://elsewhere.test/a', borrowed)).toBe('X_TEST_NETWORK_SEALED');
  });

  test('a literal without a host header misses the mock of a name', async () => {
    mockJson('https://vendor.test/a', {});
    expect(await refusalCode(`https://${ADDRESS}/a`)).toBe('X_TEST_NETWORK_SEALED');
  });
});

describe(testName('unit', 'requestLog — a call that passes through'), () => {
  /** A stand-in for the real dial: what the seal handed on is the assertion. */
  const passing = async (
    body: (handed: { input: unknown; init: unknown }[]) => Promise<void>,
  ): Promise<void> => {
    const handed: { input: unknown; init: unknown }[] = [];
    unsealNetwork();
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: unknown, init: unknown) => {
        handed.push({ input, init });
        return Promise.resolve(new Response('real'));
      },
      { preconnect: realFetch.preconnect },
    ) as typeof fetch;
    try {
      sealNetwork();
      allowHost('vendor.test');
      await body(handed);
    } finally {
      unsealNetwork();
      globalThis.fetch = realFetch;
      sealNetwork();
    }
  };

  test('a real call gets its arguments untouched, and its body is logged', async () => {
    await passing(async (handed) => {
      const init = { method: 'POST', body: 'real-body', tls: { serverName: 'vendor.test' } };
      expect(await (await fetch(VENDOR, init)).text()).toBe('real');
      expect(handed).toEqual([{ input: VENDOR, init }]);
      expect(handed[0]?.init).toBe(init);
      expect(requestLog()[0]?.body).toBe('real-body');
    });
  });

  test('a real call keeps a Request body readable after the log read it', async () => {
    await passing(async (handed) => {
      await fetch(new Request(VENDOR, { method: 'POST', body: 'in-request' }));
      expect(await (handed[0]?.input as Request | undefined)?.text()).toBe('in-request');
      expect(requestLog()[0]?.body).toBe('in-request');
    });
  });

  test('a stream on its way to a real server is never pulled, so it logs null', async () => {
    await passing(async () => {
      let pulls = 0;
      const stream = new ReadableStream(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      await fetch(VENDOR, { method: 'POST', body: stream });
      expect(pulls).toBe(0);
      expect(stream.locked).toBe(false);
      expect(requestLog()[0]?.body).toBeNull();
    });
  });
});
