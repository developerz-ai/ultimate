import { describe, expect, test } from 'bun:test';
import type { ScrapeFetch } from './http';
import { robotsGate } from './robots';
import { DEFAULT_ROBOTS_MAX_BYTES, MAX_ROBOTS_REDIRECTS, robotsFetcher } from './robots-fetch';

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const DISALLOWED = 'X_SCRAPE_ROBOTS_DISALLOWED';

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

const bodyResponse = (body: ReadableStream<Uint8Array>, status = 200): Response =>
  new Response(body, { status });

/** Resolves only when the caller's signal aborts — a hung CDN, without the wait. */
const hangingFetch: ScrapeFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const { signal } = init;
    if (signal == null) return;
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new Error('aborted'));
    });
  });

describe('unit · the default robots.txt read', () => {
  test('a hung origin gives up on the deadline instead of parking the run forever', async () => {
    const read = robotsFetcher({ timeoutMs: 25, fetch: hangingFetch });
    const started = performance.now();
    // A deadline is a network failure, never "no file": RFC 9309 §2.3.1.4 reads it as disallow.
    expect(await read('https://slow.test/robots.txt')).toEqual({ unreachable: 'timeout' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("the run's own cancellation unwinds the read", async () => {
    const controller = new AbortController();
    const read = robotsFetcher({ signal: controller.signal, fetch: hangingFetch });
    const pending = read('https://slow.test/robots.txt');
    controller.abort();
    expect(await pending).toEqual({ unreachable: 'cancelled' });
  });

  test('a robots.txt past the cap is abandoned, never held in full', async () => {
    let pulled = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const read = robotsFetcher({
      maxBytes: 4 * 1024,
      fetch: () => Promise.resolve(bodyResponse(oversized)),
    });
    expect(await read('https://huge.test/robots.txt')).toBeUndefined();
    // The cap is enforced by counting as the stream arrives, so the producer is stopped early
    // rather than after a multi-gigabyte body has already been materialised by `.text()`.
    expect(pulled).toBeLessThan(4);
  });

  test('a body inside the cap is decoded and returned', async () => {
    const text = 'User-agent: *\nDisallow: /private';
    const read = robotsFetcher({
      fetch: () => Promise.resolve(bodyResponse(streamOf([new TextEncoder().encode(text)]))),
    });
    expect(await read('https://ok.test/robots.txt')).toBe(text);
  });

  test('a 4xx answer reads as "no restrictions"', async () => {
    const read = robotsFetcher({
      fetch: () => Promise.resolve(bodyResponse(streamOf([]), 404)),
    });
    expect(await read('https://gone.test/robots.txt')).toBeUndefined();
  });

  // The exit is RESOLVED per read, never captured at construction: the gate is built as an
  // argument to `driver.open()`, and the proxy is a driver option resolved inside it — so a
  // string captured here could only ever be the one nobody has yet, which is how the robots read
  // came to exit from the worker's IP while every page load exited through the proxy.
  test('the exit is resolved per read, and only dialled when there is one', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const record: ScrapeFetch = (_url, init) => {
      seen.push((init ?? {}) as Record<string, unknown>);
      return Promise.resolve(bodyResponse(streamOf([])));
    };
    let exit: string | undefined;
    const read = robotsFetcher({ proxy: () => exit, fetch: record });
    await read('https://a.test/robots.txt');
    // `driver.open()` has now returned, and the session dialled through a proxy.
    exit = 'http://exit:8080';
    await read('https://b.test/robots.txt');
    expect('proxy' in (seen[0] ?? {})).toBe(false);
    expect(seen[1]?.['proxy']).toBe('http://exit:8080');
  });

  test('the cap is a real number of bytes, not a placeholder', () => {
    expect(DEFAULT_ROBOTS_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe('unit · the gate takes the deadline without a fetchText injected', () => {
  // The gap that hid this: every existing gate test injects `fetchText`, so the path production
  // actually takes (`scrape-run.ts` constructs the gate with no `fetchText`) had no coverage.
  test('a hung origin does not park every later navigation on one cached promise', async () => {
    const gate = robotsGate({
      policy: 'obey',
      timeoutMs: 25,
      fetch: hangingFetch,
    });
    const started = performance.now();
    expect(await codeOf(gate.assertAllowed('https://slow.test/one'))).toBe(DISALLOWED);
    expect(await codeOf(gate.assertAllowed('https://slow.test/two'))).toBe(DISALLOWED);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

// RFC 9309 §2.3.1.3–4: a file that is UNAVAILABLE (4xx) means no rules; a file that is
// UNREACHABLE (5xx, a network error, a deadline) means complete disallow. Reading both as "no
// rules" let an origin shed its own robots.txt under load and be crawled in full for the run.
describe('unit · an unreachable robots.txt disallows, an unavailable one allows', () => {
  const answering =
    (status: number): ScrapeFetch =>
    () =>
      Promise.resolve(new Response('User-agent: *\nAllow: /', { status }));

  test('a 503 answer refuses every path on the origin', async () => {
    expect(await robotsFetcher({ fetch: answering(503) })('https://down.test/robots.txt')).toEqual({
      unreachable: 'status 503',
    });
    const gate = robotsGate({ policy: 'obey', fetch: answering(503) });
    expect(await codeOf(gate.assertAllowed('https://down.test/anything'))).toBe(DISALLOWED);
    expect(await codeOf(gate.assertAllowed('https://down.test/'))).toBe(DISALLOWED);
  });

  test('a 429 is the origin shedding load, not a missing file', async () => {
    const gate = robotsGate({ policy: 'obey', fetch: answering(429) });
    expect(await codeOf(gate.assertAllowed('https://busy.test/page'))).toBe(DISALLOWED);
  });

  test('a thrown fetch refuses', async () => {
    const thrown: ScrapeFetch = () => Promise.reject(new TypeError('connection refused'));
    expect(await robotsFetcher({ fetch: thrown })('https://gone.test/robots.txt')).toEqual({
      unreachable: 'network',
    });
    const gate = robotsGate({ policy: 'obey', fetch: thrown });
    expect(await codeOf(gate.assertAllowed('https://gone.test/page'))).toBe(DISALLOWED);
  });

  test('a 404 and a 410 allow', async () => {
    for (const status of [404, 410, 403]) {
      const gate = robotsGate({ policy: 'obey', fetch: answering(status) });
      expect(await codeOf(gate.assertAllowed('https://plain.test/page'))).toBeUndefined();
    }
  });

  test('an unreachable answer is not cached: the origin is asked again and can recover', async () => {
    let calls = 0;
    const flaky: ScrapeFetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response('User-agent: *\nDisallow: /private', {
          status: calls === 1 ? 503 : 200,
        }),
      );
    };
    const gate = robotsGate({ policy: 'obey', fetch: flaky });
    expect(await codeOf(gate.assertAllowed('https://flaky.test/page'))).toBe(DISALLOWED);
    expect(await codeOf(gate.assertAllowed('https://flaky.test/page'))).toBeUndefined();
    expect(await codeOf(gate.assertAllowed('https://flaky.test/private'))).toBe(DISALLOWED);
    expect(await codeOf(gate.assertAllowed('https://flaky.test/again'))).toBeUndefined();
    // Readable once, then cached for the run as before.
    expect(calls).toBe(2);
  });

  test('a caller-supplied read that rejects refuses rather than allowing', async () => {
    const gate = robotsGate({
      policy: 'obey',
      fetchText: () => Promise.reject(new TypeError('dns')),
    });
    expect(await codeOf(gate.assertAllowed('https://custom.test/page'))).toBe(DISALLOWED);
  });

  test('a caller-supplied read may answer unreachable itself', async () => {
    const gate = robotsGate({
      policy: 'obey',
      fetchText: () => Promise.resolve({ unreachable: 'upstream cache said 502' }),
    });
    expect(await codeOf(gate.assertAllowed('https://custom.test/page'))).toBe(DISALLOWED);
  });
});

// The robots read was the one request on the HTTP leg the platform followed on its own: an
// allow-listed origin answering `/robots.txt` with `302 -> http://169.254.169.254/…` made the worker
// GET an address `allowHosts` never listed. Each hop is now screened by the same host rule.
describe('unit · a robots redirect is followed hop by hop, inside allowHosts', () => {
  interface Seen {
    readonly url: string;
    readonly redirect: unknown;
    readonly proxy: unknown;
  }
  const chain = (answers: Readonly<Record<string, Response>>) => {
    const seen: Seen[] = [];
    const call: ScrapeFetch = (url, init) => {
      seen.push({ url, redirect: init.redirect, proxy: init.proxy });
      return Promise.resolve(answers[url] ?? new Response('', { status: 404 }));
    };
    return { seen, call };
  };
  const to = (location: string, status = 302): Response =>
    new Response(null, { status, headers: { location } });
  const RULES = 'User-agent: *\nDisallow: /private';

  test('a redirect off the list is never requested, and reads as "no robots"', async () => {
    const { seen, call } = chain({
      'https://shop.test/robots.txt': to('http://169.254.169.254/latest/meta-data/'),
    });
    const read = robotsFetcher({ allowHosts: ['shop.test'], fetch: call });
    expect(await read('https://shop.test/robots.txt')).toBeUndefined();
    expect(seen.map((hop) => hop.url)).toEqual(['https://shop.test/robots.txt']);
    expect(seen[0]?.redirect).toBe('manual');
  });

  test('a redirect on the list is followed, every hop manual and through the same exit', async () => {
    const { seen, call } = chain({
      'http://shop.test/robots.txt': to('https://shop.test/robots.txt', 301),
      'https://shop.test/robots.txt': to('/static/robots.txt', 307),
      'https://shop.test/static/robots.txt': new Response(RULES),
    });
    const read = robotsFetcher({
      allowHosts: ['shop.test'],
      proxy: () => 'http://exit.test:1',
      fetch: call,
    });
    expect(await read('http://shop.test/robots.txt')).toBe(RULES);
    expect(seen.map((hop) => hop.redirect)).toEqual(['manual', 'manual', 'manual']);
    expect(seen.map((hop) => hop.proxy)).toEqual([
      'http://exit.test:1',
      'http://exit.test:1',
      'http://exit.test:1',
    ]);
  });

  test('the first URL is screened too: an origin off the list is never read', async () => {
    const { seen, call } = chain({ 'https://other.test/robots.txt': new Response(RULES) });
    const read = robotsFetcher({ allowHosts: ['shop.test'], fetch: call });
    expect(await read('https://other.test/robots.txt')).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test('with no allowHosts a same-host redirect is followed: scheme upgrade, then path move', async () => {
    const { seen, call } = chain({
      'http://shop.test/robots.txt': to('https://shop.test/robots.txt', 301),
      'https://shop.test/robots.txt': to('/static/robots.txt'),
      'https://shop.test/static/robots.txt': new Response(RULES),
    });
    expect(await robotsFetcher({ fetch: call })('http://shop.test/robots.txt')).toBe(RULES);
    expect(seen.map((hop) => hop.redirect)).toEqual(['manual', 'manual', 'manual']);
  });

  test('with no allowHosts a redirect to ANOTHER host is never requested', async () => {
    const { seen, call } = chain({
      'https://shop.test/robots.txt': to('https://cdn.shop.test/robots.txt'),
      'https://cdn.shop.test/robots.txt': new Response(RULES),
    });
    expect(await robotsFetcher({ fetch: call })('https://shop.test/robots.txt')).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  test(`with no allowHosts a same-host chain past ${String(MAX_ROBOTS_REDIRECTS)} hops is abandoned`, async () => {
    const answers: Record<string, Response> = {};
    for (let hop = 0; hop < 20; hop += 1) {
      answers[`https://shop.test/r${String(hop)}`] = to(`https://shop.test/r${String(hop + 1)}`);
    }
    const { seen, call } = chain(answers);
    expect(await robotsFetcher({ fetch: call })('https://shop.test/r0')).toBeUndefined();
    expect(seen).toHaveLength(MAX_ROBOTS_REDIRECTS + 1);
  });

  test(`a chain past ${String(MAX_ROBOTS_REDIRECTS)} hops is abandoned`, async () => {
    const answers: Record<string, Response> = {};
    for (let hop = 0; hop < 20; hop += 1) {
      answers[`https://shop.test/r${String(hop)}`] = to(`https://shop.test/r${String(hop + 1)}`);
    }
    const { seen, call } = chain(answers);
    const read = robotsFetcher({ allowHosts: ['shop.test'], fetch: call });
    expect(await read('https://shop.test/r0')).toBeUndefined();
    expect(seen).toHaveLength(MAX_ROBOTS_REDIRECTS + 1);
  });

  test('the gate scrape-run builds hands the run allowHosts to the read', async () => {
    const { seen, call } = chain({
      'https://shop.test/robots.txt': to('https://evil.test/robots.txt'),
      'https://evil.test/robots.txt': new Response('User-agent: *\nDisallow: /'),
    });
    const gate = robotsGate({ policy: 'obey', allowHosts: ['shop.test'], fetch: call });
    await gate.assertAllowed('https://shop.test/orders');
    expect(seen.map((hop) => hop.url)).toEqual(['https://shop.test/robots.txt']);
  });
});
